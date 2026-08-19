import { describe, expect, it } from "vitest";

import {
  parseAgentResultPayload,
  tryParseAgentResult,
} from "@/server/execution/providers/openclaw/openclaw-response-parser";

// Fixture confirmed directly against a live OpenClaw Gateway (`openclaw
// gateway call agent --params '...' --expect-final --json`, OpenClaw
// 2026.7.1-2) — see openclaw-gateway-client.ts's header comment.
const LIVE_SUCCESS_PAYLOAD = {
  runId: "test-schema-probe-2",
  status: "ok",
  summary: "completed",
  result: {
    payloads: [{ text: "pong", mediaUrl: null }],
    meta: {
      finalAssistantVisibleText: "pong",
      agentMeta: {
        sessionId: "15138f89-5669-47a1-9840-881d70d79587",
        provider: "google",
        model: "gemini-3.5-flash",
      },
    },
  },
};

describe("parseAgentResultPayload", () => {
  it("parses a confirmed live-gateway success payload", () => {
    const result = parseAgentResultPayload(LIVE_SUCCESS_PAYLOAD);
    expect(result).toEqual({
      ok: true,
      runId: "test-schema-probe-2",
      finalText: "pong",
      sessionId: "15138f89-5669-47a1-9840-881d70d79587",
      model: "gemini-3.5-flash",
      provider: "google",
    });
  });

  it("maps a non-ok status to a FAILED-shaped result", () => {
    const result = parseAgentResultPayload({
      runId: "run-1",
      status: "error",
      summary: "model auth failed",
    });
    expect(result).toEqual({
      ok: false,
      status: "error",
      error: { message: "model auth failed", kind: "agent_error" },
    });
  });

  it("maps a timeout status distinctly from a generic error", () => {
    const result = parseAgentResultPayload({
      runId: "run-1",
      status: "timeout",
    });
    expect(result?.ok).toBe(false);
    expect(result && !result.ok && result.status).toBe("timeout");
  });

  it("falls back to joined payload text when finalAssistantVisibleText is absent", () => {
    const result = parseAgentResultPayload({
      runId: "run-1",
      status: "ok",
      result: { payloads: [{ text: "hello" }, { text: "world" }] },
    });
    expect(result?.ok).toBe(true);
    expect(result && result.ok && result.finalText).toBe("hello\nworld");
  });

  it("returns null for a payload that doesn't match the schema at all", () => {
    expect(parseAgentResultPayload({ foo: "bar" })).toBeNull();
    expect(parseAgentResultPayload(null)).toBeNull();
    expect(parseAgentResultPayload("not an object")).toBeNull();
  });
});

describe("tryParseAgentResult", () => {
  it("parses a JSON string the same way parseAgentResultPayload does", () => {
    const result = tryParseAgentResult(JSON.stringify(LIVE_SUCCESS_PAYLOAD));
    expect(result?.ok).toBe(true);
  });

  it("returns null for invalid JSON", () => {
    expect(tryParseAgentResult("not json")).toBeNull();
  });
});
