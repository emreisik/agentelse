import "server-only";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { getEnv, isIntegrationConfigured } from "@/lib/env";
import { AgentelseError } from "@/server/security/errors";
import {
  openClawAgentListSchema,
  openClawRawAgentResponseSchema,
} from "@/server/execution/providers/openclaw/openclaw-schemas";
import type {
  OpenClawAgentRequest,
  OpenClawAgentResult,
} from "@/server/execution/providers/openclaw/openclaw-types";

const execFileAsync = promisify(execFile);

const AGENT_CACHE_TTL_MS = 60_000;
let agentIdCache: { ids: ReadonlySet<string>; fetchedAt: number } | null = null;

type ExecError = {
  stdout?: string;
  stderr?: string;
  message: string;
  killed?: boolean;
};

function tryParseAgentResult(text: string): OpenClawAgentResult | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }

  const parsed = openClawRawAgentResponseSchema.safeParse(json);
  if (!parsed.success) return null;

  const raw = parsed.data;
  if (raw.status !== "ok") {
    return {
      ok: false,
      status: raw.status === "timeout" ? "timeout" : "error",
      error: {
        message:
          raw.summary ?? `openclaw agent returned status "${raw.status}"`,
        kind: "agent_error",
      },
    };
  }

  const finalText =
    raw.result?.meta?.finalAssistantVisibleText ??
    raw.result?.payloads?.map((p) => p.text ?? "").join("\n") ??
    "";

  return {
    ok: true,
    runId: raw.runId,
    finalText,
    sessionId: raw.result?.meta?.agentMeta?.sessionId,
    model: raw.result?.meta?.agentMeta?.model,
    provider: raw.result?.meta?.agentMeta?.provider,
  };
}

// Thin wrapper over the real OpenClaw CLI (`openclaw agent --json`) — not an
// HTTP API. Schema confirmed against a live local gateway (openclaw
// 2026.7.1-2) while building this adapter; see openclaw-types.ts for why the
// real shape diverges from docs.openclaw.ai.
//
// NOTE on blocking: `openclaw agent` is synchronous — it doesn't return
// until the agent turn finishes, which can take minutes for a real browser
// task. execFileAsync here blocks the calling ExecutionWorker tick for that
// entire duration, unlike every other provider in this codebase. A
// production-grade version should spawn detached + poll a result file
// instead of awaiting inline; left as-is for now since OpenClaw is opt-in
// (isConfigured is false until OPENCLAW_CLI_PATH is set) and this is the
// only provider with this constraint.
export class OpenClawClient {
  get isConfigured(): boolean {
    return isIntegrationConfigured("OPENCLAW");
  }

  // Agent ids configured in the local OpenClaw install. Cached because the
  // provider consults it on every dispatch; a newly added agent shows up
  // after the TTL (or a server restart), which is fine for a config list.
  async listAgentIds(): Promise<ReadonlySet<string>> {
    const now = Date.now();
    if (agentIdCache && now - agentIdCache.fetchedAt < AGENT_CACHE_TTL_MS) {
      return agentIdCache.ids;
    }

    const env = getEnv();
    if (!env.OPENCLAW_CLI_PATH) return new Set();

    const command = env.OPENCLAW_NODE_PATH || env.OPENCLAW_CLI_PATH;
    const commandArgs = env.OPENCLAW_NODE_PATH
      ? [env.OPENCLAW_CLI_PATH, "agents", "list", "--json"]
      : ["agents", "list", "--json"];

    try {
      const { stdout } = await execFileAsync(command, commandArgs, {
        timeout: 20_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      const parsed = openClawAgentListSchema.safeParse(JSON.parse(stdout));
      if (!parsed.success) return agentIdCache?.ids ?? new Set();
      const ids = new Set(parsed.data.map((agent) => agent.id));
      agentIdCache = { ids, fetchedAt: now };
      return ids;
    } catch {
      // Gateway down / CLI unusable — keep whatever we knew, and let the
      // caller fall back to the default agent rather than hard-failing.
      return agentIdCache?.ids ?? new Set();
    }
  }

  async runAgentTurn(
    input: OpenClawAgentRequest,
  ): Promise<OpenClawAgentResult> {
    const env = getEnv();
    if (!env.OPENCLAW_CLI_PATH) {
      throw new AgentelseError(
        "PROVIDER_UNAVAILABLE",
        "OPENCLAW_CLI_PATH is not configured",
      );
    }

    const timeoutSeconds = input.timeoutSeconds ?? env.OPENCLAW_TIMEOUT_SECONDS;
    const args = [
      "agent",
      "--agent",
      input.agentId,
      "--message",
      input.message,
      "--json",
      "--timeout",
      String(timeoutSeconds),
    ];
    if (input.sessionKey) args.push("--session-key", input.sessionKey);
    if (input.model) args.push("--model", input.model);

    const command = env.OPENCLAW_NODE_PATH || env.OPENCLAW_CLI_PATH;
    const commandArgs = env.OPENCLAW_NODE_PATH
      ? [env.OPENCLAW_CLI_PATH, ...args]
      : args;

    try {
      const { stdout } = await execFileAsync(command, commandArgs, {
        timeout: (timeoutSeconds + 15) * 1000,
        maxBuffer: 10 * 1024 * 1024,
      });
      const result = tryParseAgentResult(stdout);
      if (!result) {
        throw new AgentelseError(
          "INVALID_PROVIDER_RESULT",
          "openclaw agent --json did not return the confirmed schema",
        );
      }
      return result;
    } catch (error) {
      if (error instanceof AgentelseError) throw error;

      // execFile rejects on non-zero exit / timeout. In practice a
      // pre-flight failure (missing model auth, gateway unreachable) never
      // prints JSON at all — just a raw stderr string — so this is the
      // primary error path, not a fallback.
      const execError = error as ExecError;
      const parsedFromFailure = execError.stdout
        ? tryParseAgentResult(execError.stdout)
        : null;
      if (parsedFromFailure) return parsedFromFailure;

      return {
        ok: false,
        status: execError.killed ? "timeout" : "error",
        error: {
          message: execError.stderr?.trim() || execError.message,
          kind: execError.killed ? "cli_timeout" : "cli_error",
        },
      };
    }
  }
}
