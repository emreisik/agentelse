import { openClawRawAgentResponseSchema } from "@/server/execution/providers/openclaw/openclaw-schemas";
import type { OpenClawAgentResult } from "@/server/execution/providers/openclaw/openclaw-types";

// Shared between openclaw-client.ts (CLI subprocess, `agent --json` stdout)
// and openclaw-gateway-client.ts (WebSocket Gateway, the `agent` RPC's final
// event payload) — confirmed by directly probing a live Gateway
// (`openclaw gateway call agent --params ... --expect-final --json`) that
// the two carry the IDENTICAL {runId, status, summary, result: {payloads,
// meta: {agentMeta, finalAssistantVisibleText}}} shape. The CLI is just a
// thin wrapper around this same RPC, so there was never a second schema to
// maintain.
export function tryParseAgentResult(text: string): OpenClawAgentResult | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  return parseAgentResultPayload(json);
}

// Gateway callers already have a parsed object (from a WS JSON frame), not a
// string — this is the JSON.parse-free half of tryParseAgentResult.
export function parseAgentResultPayload(
  json: unknown,
): OpenClawAgentResult | null {
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
