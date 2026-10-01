import { afterEach, describe, expect, it, vi } from "vitest";

import { copyText } from "@/lib/works/copy";
import { encodeSseEvent } from "@/server/chat/sse";
import type { ChatStreamEvent } from "@/server/chat/types";

import { postVariants } from "./variants-client";

const body = { commandId: "c1", creativeId: "k1", more: false };

function stubFetch(response: Response): void {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
}

// The same bytes the route's refuse() / run stream write.
function sse(events: ChatStreamEvent[]): Response {
  return new Response(events.map(encodeSseEvent).join(""), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("postVariants", () => {
  it("reports a refusal that arrives as an SSE error event on HTTP 200", async () => {
    stubFetch(
      sse([{ type: "error", code: "BUSY", message: "This piece is busy." }]),
    );
    const result = await postVariants("p1", body);
    expect(result).toEqual({ ok: false, message: copyText("variants.failed") });
  });

  it("maps LIMIT to the limit copy and a crash (FAILED) to the generic copy", async () => {
    stubFetch(sse([{ type: "error", code: "LIMIT", message: "raw" }]));
    expect(await postVariants("p1", body)).toEqual({
      ok: false,
      message: copyText("variants.limit"),
    });
    stubFetch(sse([{ type: "error", code: "FAILED", message: "TypeError: x" }]));
    expect(await postVariants("p1", body)).toEqual({
      ok: false,
      message: copyText("variants.failed"),
    });
  });

  it("keeps the budget refusal's own text", async () => {
    stubFetch(
      sse([
        { type: "error", code: "BUDGET", message: "Daily budget reached." },
      ]),
    );
    expect(await postVariants("p1", body)).toEqual({
      ok: false,
      message: "Daily budget reached.",
    });
  });

  it("is ok when the stream starts a job and carries no error event", async () => {
    stubFetch(sse([{ type: "package.done", started: 1, failed: 0 }]));
    expect(await postVariants("p1", body)).toEqual({ ok: true });
  });

  it("is not a success when nothing started", async () => {
    stubFetch(sse([{ type: "package.done", started: 0, failed: 1 }]));
    expect(await postVariants("p1", body)).toEqual({
      ok: false,
      message: copyText("variants.failed"),
    });
  });

  it("fails on a non-2xx status and when the network throws", async () => {
    stubFetch(Response.json({ error: "Not found" }, { status: 404 }));
    expect(await postVariants("p1", body)).toEqual({
      ok: false,
      message: copyText("variants.failed"),
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    expect(await postVariants("p1", body)).toEqual({
      ok: false,
      message: copyText("variants.failed"),
    });
  });
});
