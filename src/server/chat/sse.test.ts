import { describe, expect, it } from "vitest";

import { createSseParser, encodeSseEvent } from "./sse";
import type { ChatStreamEvent } from "./types";

describe("sse", () => {
  it("round-trips events, including ones split across chunks", () => {
    const events: ChatStreamEvent[] = [
      { type: "start", commandId: "c1" },
      { type: "text.delta", text: "Merhaba\nDünya" },
      { type: "done", commandId: "c1", status: "ANSWERED", reply: "Merhaba" },
    ];
    const wire = events.map(encodeSseEvent).join("");
    const parse = createSseParser();

    const out: ChatStreamEvent[] = [];
    // Feed in awkward 7-char slices, splitting frames mid-way.
    for (let i = 0; i < wire.length; i += 7) {
      out.push(...parse(wire.slice(i, i + 7)));
    }
    expect(out).toEqual(events);
  });

  it("round-trips the tagged content-package events, heartbeats in between", () => {
    const events: ChatStreamEvent[] = [
      { type: "item.start", itemId: "post", taskId: "task-1" },
      {
        type: "item.partial",
        itemId: "post",
        index: 1,
        dataUrl: "data:image/png;base64,AAAA",
      },
      {
        type: "item.done",
        itemId: "post",
        ok: true,
        reply: "Creative ready",
        commandId: "row-1",
        card: { kind: "creative-failed", taskId: "task-1", title: "Post" },
      },
      { type: "package.done", started: 1, failed: 0 },
    ];
    // The route interleaves ": ping" comments; they carry no data line.
    const wire = events.map((e) => `: ping\n\n${encodeSseEvent(e)}`).join("");
    expect(createSseParser()(wire)).toEqual(events);
  });

  it("drops a malformed frame without breaking the stream", () => {
    const parse = createSseParser();
    const out = parse(
      `event: x\ndata: {not json\n\n${encodeSseEvent({ type: "start", commandId: "c2" })}`,
    );
    expect(out).toEqual([{ type: "start", commandId: "c2" }]);
  });
});
