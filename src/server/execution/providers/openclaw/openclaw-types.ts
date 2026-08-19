// Real OpenClaw contract — `openclaw agent --json` (CLI subprocess, not
// HTTP). IMPORTANT: this does NOT match what docs.openclaw.ai/cli/agent
// describes (that page documents a flat {ok, status, final, sessionId, ...}
// envelope) — the installed CLI (2026.7.1-2) actually returns a nested
// {runId, status, summary, result: {payloads, meta: {agentMeta, ...}}}
// shape. This file reflects the schema confirmed by actually running the
// command against a live gateway while building this adapter — trust this
// over the docs site until OpenClaw's docs catch up to its CLI.
//
// Failures are worse: a pre-flight error (missing model auth, gateway
// unreachable) doesn't print JSON at all — just a raw string to stderr and a
// non-zero exit. openclaw-client.ts's catch path constructs the error shape
// itself from stderr; there is no confirmed real JSON error envelope to
// validate against.

export type OpenClawAgentSuccessResult = {
  ok: true;
  runId: string;
  finalText: string;
  sessionId?: string;
  model?: string;
  provider?: string;
  costUsd?: number;
};

export type OpenClawAgentErrorResult = {
  ok: false;
  status: "error" | "timeout";
  error: { message: string; kind: string };
};

export type OpenClawAgentResult =
  OpenClawAgentSuccessResult | OpenClawAgentErrorResult;
