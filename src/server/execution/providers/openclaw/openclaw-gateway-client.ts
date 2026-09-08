import "server-only";

// A real WebSocket client for the OpenClaw Gateway — the same RPC surface
// `openclaw agent` itself talks to under the hood (confirmed: `openclaw
// agent --help` literally says "Run an agent turn via the Gateway"). Unlike
// a CLI subprocess (which would block the caller for the whole agent turn),
// this is genuinely async: startAgentRun() only waits for the Gateway's
// ACCEPTANCE of the run and returns immediately; the real result streams in
// later via Gateway events and is read back with getRunState().
//
// Protocol (confirmed directly against a live local Gateway — `openclaw
// gateway --help` / `openclaw gateway call --help` — and
// docs.openclaw.ai/concepts/architecture):
//   - Envelopes: request  {type:"req", id, method, params}
//                response {type:"res", id, ok, payload|error}
//                event    {type:"event", event, payload, seq?, stateVersion?}
//   - Handshake: first request must be method "connect" with
//     params.auth.token (see `openclaw gateway --help`: "Shared token
//     required in connect.params.auth.token").
//   - Starting a run: method "agent", params {idempotencyKey, message,
//     sessionKey}. There is NO separate "agent id" field — routing to a
//     specific OpenClaw agent happens entirely through sessionKey, whose
//     format is `agent:<agentId>:<key>` (matches the CLI's own
//     `--session-key` docs: "agent:<id>:<key>, or scoped to --agent").
//     idempotencyKey is required for this side-effecting method.
//   - Response/event payload shape for a run is IDENTICAL to what the CLI's
//     `agent --json` prints to stdout: {runId, status, summary, result:
//     {payloads, meta:{agentMeta, finalAssistantVisibleText}}} — verified by
//     probing a live gateway with `openclaw gateway call agent --params
//     '{"idempotencyKey":"...","message":"...","sessionKey":"agent:main:..."}'
//     --expect-final --json`. This is why openclaw-response-parser.ts is
//     shared unchanged between the CLI client and this one.

import { randomUUID } from "node:crypto";

import { getEnv, isIntegrationConfigured } from "@/lib/env";
import { AgentelseError } from "@/server/security/errors";
import { parseAgentResultPayload } from "@/server/execution/providers/openclaw/openclaw-response-parser";
import { openClawAgentListSchema } from "@/server/execution/providers/openclaw/openclaw-schemas";
import type { OpenClawAgentResult } from "@/server/execution/providers/openclaw/openclaw-types";

const CONNECT_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 30_000; // covers "connect"/"agent" ACK only, never the full run
const AGENT_LIST_CACHE_TTL_MS = 60_000;

// Statuses OpenClaw uses for a run that hasn't produced a final result yet.
// Anything NOT in this set (ok/error/timeout/anything else unrecognized) is
// treated as terminal — deliberately permissive so an OpenClaw version that
// adds a new terminal status string doesn't get stuck as "still running"
// forever. This is the one part of the protocol that wasn't directly
// observable without triggering a real failure, so it's the most likely
// spot to need adjustment once this runs against real long browser tasks.
const NON_TERMINAL_STATUSES = new Set([
  "accepted",
  "queued",
  "running",
  "in_progress",
  "streaming",
  "pending",
]);

type RunState =
  | { kind: "pending"; startedAt: number }
  | { kind: "done"; result: OpenClawAgentResult };

type PendingRequest = {
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
};

// Module-level singleton: ONE persistent WebSocket connection per process,
// reused across every agent run and every worker tick. Safe because
// `npm run start` (railway.json) is a long-running Node process, not a
// per-request serverless function — the connection (and runStates below)
// survive across ticks and only need to be (re)established on cold start or
// after a drop.
let socket: WebSocket | null = null;
let connecting: Promise<WebSocket> | null = null;
let reqCounter = 0;
const pendingRequests = new Map<string, PendingRequest>();
const runStates = new Map<string, RunState>();
let agentIdCache: { ids: ReadonlySet<string>; fetchedAt: number } | null = null;

function nextRequestId(): string {
  reqCounter += 1;
  return `req-${reqCounter}-${randomUUID()}`;
}

function requireGatewayConfig(): { url: string; token: string } {
  const env = getEnv();
  if (!env.OPENCLAW_GATEWAY_URL || !env.OPENCLAW_GATEWAY_TOKEN) {
    throw new AgentelseError(
      "PROVIDER_UNAVAILABLE",
      "OPENCLAW_GATEWAY_URL/OPENCLAW_GATEWAY_TOKEN is not configured",
    );
  }
  return { url: env.OPENCLAW_GATEWAY_URL, token: env.OPENCLAW_GATEWAY_TOKEN };
}

function failAllPending(reason: string): void {
  for (const [id, pending] of pendingRequests) {
    pending.reject(new AgentelseError("PROVIDER_UNAVAILABLE", reason));
    pendingRequests.delete(id);
  }
}

function handleMessage(raw: string): void {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  if (msg.type === "res") {
    const id = String(msg.id);
    const pending = pendingRequests.get(id);
    if (!pending) return;
    pendingRequests.delete(id);
    if (msg.ok) {
      pending.resolve(msg.payload);
    } else {
      const error = msg.error as { message?: string } | undefined;
      pending.reject(
        new AgentelseError(
          "INVALID_PROVIDER_RESULT",
          error?.message ?? "OpenClaw Gateway request failed",
        ),
      );
    }
    return;
  }

  if (msg.type === "event") {
    const payload = msg.payload as Record<string, unknown> | undefined;
    const runId = typeof payload?.runId === "string" ? payload.runId : null;
    if (!runId) return;

    const status = payload?.status;
    if (typeof status === "string" && NON_TERMINAL_STATUSES.has(status)) {
      return; // still in progress — leave runStates as "pending"
    }

    const result = parseAgentResultPayload(payload);
    if (!result) return; // doesn't match the confirmed schema yet — stay pending
    runStates.set(runId, { kind: "done", result });
  }
}

async function connect(): Promise<WebSocket> {
  if (socket && socket.readyState === WebSocket.OPEN) return socket;
  if (connecting) return connecting;

  const { url, token } = requireGatewayConfig();

  connecting = new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url);
    const settleTimer = setTimeout(() => {
      ws.close();
      reject(
        new AgentelseError(
          "PROVIDER_UNAVAILABLE",
          `OpenClaw Gateway connect timed out (${CONNECT_TIMEOUT_MS}ms)`,
        ),
      );
    }, CONNECT_TIMEOUT_MS);

    ws.addEventListener("open", () => {
      const id = nextRequestId();
      pendingRequests.set(id, {
        resolve: () => {
          clearTimeout(settleTimer);
          socket = ws;
          connecting = null;
          resolve(ws);
        },
        reject: (error) => {
          clearTimeout(settleTimer);
          connecting = null;
          ws.close();
          reject(error);
        },
      });
      // The deployed Gateway now rejects a connect request that omits
      // minProtocol/maxProtocol/client (confirmed in prod logs, 2026-09-07:
      // "invalid connect params: must have required property 'minProtocol'
      // ..."). This app previously only sent `auth`, which is why every
      // reconnect since has failed — and because `socket` is a singleton
      // reused for the process lifetime, a single dropped connection
      // silently stranded every in-flight run for good (see runStates'
      // module comment). Per docs.openclaw.ai/gateway/protocol/handshake's
      // documented connect params for a `role:"operator"` client.
      //
      // client.id/client.mode are a const-paired discriminator, not free
      // text (confirmed in prod logs, 2026-09-08: "invalid connect params:
      // at /client/id: must be equal to constant; ... /client/mode: must be
      // equal to constant" — the previous "agentelse"/"operator" values
      // don't match any of the schema's known pairs). The docs' three known
      // pairs are cli+operator (human CLI), ios-node+node (mobile), and
      // gateway-client+backend — the last being explicitly documented as
      // "trusted local backend clients ... authenticating with the shared
      // gateway token", which is exactly this server-to-server integration.
      ws.send(
        JSON.stringify({
          type: "req",
          id,
          method: "connect",
          params: {
            minProtocol: 4,
            maxProtocol: 4,
            client: {
              id: "gateway-client",
              version: "0.1.0",
              platform: "node",
              mode: "backend",
            },
            role: "operator",
            scopes: ["operator.read", "operator.write"],
            auth: { token },
          },
        }),
      );
    });

    ws.addEventListener("message", (event) => {
      handleMessage(String(event.data));
    });

    ws.addEventListener("close", () => {
      if (socket === ws) socket = null;
      failAllPending("OpenClaw Gateway connection closed");
    });

    ws.addEventListener("error", () => {
      // "close" always fires right after "error" on WS — cleanup happens
      // there; this handler only exists so an unhandled-error isn't logged.
    });
  });

  return connecting;
}

async function sendRequest(
  method: string,
  params: unknown,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<unknown> {
  const ws = await connect();
  const id = nextRequestId();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(
        new AgentelseError(
          "PROVIDER_UNAVAILABLE",
          `OpenClaw Gateway method "${method}" timed out (${timeoutMs}ms)`,
        ),
      );
    }, timeoutMs);

    pendingRequests.set(id, {
      resolve: (payload) => {
        clearTimeout(timer);
        resolve(payload);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });

    ws.send(JSON.stringify({ type: "req", id, method, params }));
  });
}

export const OpenClawGatewayClient = {
  get isConfigured(): boolean {
    return isIntegrationConfigured("OPENCLAW_GATEWAY");
  },

  // Starts a run and returns as soon as the Gateway ACKs it — never waits
  // for the agent turn to finish. Real completion is read back later via
  // getRunState(), polled from OpenClawProvider.getStatus() (see
  // ExecutionWorker.pollRunningJobs, which already existed for this exact
  // purpose but no provider used it before this one).
  async startAgentRun(input: {
    agentId: string;
    message: string;
    sessionKey: string;
    idempotencyKey: string;
  }): Promise<{ runId: string }> {
    runStates.set(input.idempotencyKey, {
      kind: "pending",
      startedAt: Date.now(),
    });

    let payload: unknown;
    try {
      payload = await sendRequest("agent", {
        idempotencyKey: input.idempotencyKey,
        message: input.message,
        sessionKey: `agent:${input.agentId}:${input.sessionKey}`,
      });
    } catch (error) {
      runStates.delete(input.idempotencyKey);
      throw error;
    }

    // Confirmed against a live gateway: runId echoes idempotencyKey. Keyed
    // by whatever the Gateway actually returns (not just the idempotencyKey
    // we sent) so this stays correct if that ever changes.
    const ack = payload as { runId?: string } | null;
    const runId = ack?.runId ?? input.idempotencyKey;
    if (runId !== input.idempotencyKey) {
      const pending = runStates.get(input.idempotencyKey);
      runStates.delete(input.idempotencyKey);
      runStates.set(
        runId,
        pending ?? { kind: "pending", startedAt: Date.now() },
      );
    }
    return { runId };
  },

  // Sends a follow-up message on the SAME session — this is how a paused
  // browser-control run (waiting on an OTP/2FA value) is resumed. Starts a
  // new run (new idempotencyKey/runId) against the same sessionKey, exactly
  // like the CLI's resume() path does by re-invoking `agent` with the same
  // --session-key.
  async sendFollowUp(input: {
    agentId: string;
    sessionKey: string;
    message: string;
  }): Promise<{ runId: string }> {
    return this.startAgentRun({
      agentId: input.agentId,
      sessionKey: input.sessionKey,
      message: input.message,
      idempotencyKey: randomUUID(),
    });
  },

  // Synchronous read of whatever this run's latest known state is — never
  // itself waits on the network. "RUNNING" (pending, not yet timed out) vs
  // a terminal OpenClawAgentResult once one has arrived via a Gateway event.
  getRunState(
    runId: string,
    timeoutSeconds: number,
  ): { kind: "running" } | { kind: "done"; result: OpenClawAgentResult } {
    const state = runStates.get(runId);
    if (!state) return { kind: "running" }; // not observed yet — caller retries next poll
    if (state.kind === "done") return state;

    if (Date.now() - state.startedAt > timeoutSeconds * 1000) {
      const timedOut: OpenClawAgentResult = {
        ok: false,
        status: "timeout",
        error: {
          message: `OpenClaw Gateway run exceeded ${timeoutSeconds}s with no final event`,
          kind: "gateway_timeout",
        },
      };
      runStates.set(runId, { kind: "done", result: timedOut });
      return { kind: "done", result: timedOut };
    }
    return { kind: "running" };
  },

  // Agent ids configured on the Gateway's side — confirmed via
  // `openclaw gateway call agents.list --json` against a live gateway:
  // returns { defaultId, mainKey, scope, agents: [{id, workspace, ...}] }.
  // Cached because resolveAgentId() (openclaw-provider.ts) consults this on
  // every dispatch; a newly provisioned agent shows up after the TTL.
  async listAgentIds(): Promise<ReadonlySet<string>> {
    const now = Date.now();
    if (
      agentIdCache &&
      now - agentIdCache.fetchedAt < AGENT_LIST_CACHE_TTL_MS
    ) {
      return agentIdCache.ids;
    }

    try {
      const payload = await sendRequest("agents.list", {});
      const agents = (payload as { agents?: unknown } | null)?.agents;
      const parsed = openClawAgentListSchema.safeParse(agents);
      if (!parsed.success) return agentIdCache?.ids ?? new Set();
      const ids = new Set(parsed.data.map((agent) => agent.id));
      agentIdCache = { ids, fetchedAt: now };
      return ids;
    } catch {
      // Gateway unreachable/misconfigured — keep whatever we knew, and let
      // the caller fall back to the default agent rather than hard-failing.
      return agentIdCache?.ids ?? new Set();
    }
  },

  // Provisions a dedicated OpenClaw agent for a project — confirmed via
  // live probing that `agents.create` exists and requires {name, workspace}
  // (params validation rejected calls missing either, in that order).
  // `workspace` is resolved against OPENCLAW_GATEWAY_WORKSPACE_ROOT because
  // it's interpreted by the Gateway process's own filesystem, not this
  // app's — see that env var's doc comment in env.ts.
  async createAgent(input: {
    id: string;
    workspace: string;
  }): Promise<boolean> {
    try {
      await sendRequest("agents.create", {
        name: input.id,
        workspace: input.workspace,
      });
      return true;
    } catch (error) {
      console.error(
        `[openclaw-gateway-client] failed to create agent "${input.id}"`,
        error,
      );
      return false;
    }
  },
};
