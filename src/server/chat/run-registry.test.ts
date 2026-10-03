import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { ChatAgentInput } from "./chat-agent";
import {
  __resetChatRunsForTests,
  cancelRun,
  findActiveRun,
  isRunLive,
  listActiveRuns,
  startChatRun,
  subscribe,
  type ChatRunAgent,
} from "./run-registry";
import type { ChatStreamEvent } from "./types";

const input: Omit<ChatAgentInput, "signal"> = {
  workspaceId: "ws",
  projectId: "p1",
  userId: "u1",
  message: "hi",
  workId: "w1",
};

// An agent the test drives by hand: it yields what is pushed, ends on close().
function manualAgent() {
  const queue: ChatStreamEvent[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  let signal: AbortSignal | undefined;
  const agent: ChatRunAgent = async function* (turn) {
    signal = turn.signal;
    for (;;) {
      while (queue.length) yield queue.shift()!;
      if (closed || turn.signal?.aborted) {
        if (turn.signal?.aborted) {
          yield { type: "done", commandId: "c1", status: "STOPPED", reply: "x" };
        }
        return;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
        turn.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    }
  };
  return {
    agent,
    push(event: ChatStreamEvent) {
      queue.push(event);
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
    signal: () => signal,
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => __resetChatRunsForTests());

describe("run registry", () => {
  it("allows one running turn per chat, and finds it by its row once started", async () => {
    const fake = manualAgent();
    const first = startChatRun(input, { agent: fake.agent });
    expect(first.ok).toBe(true);
    expect(startChatRun(input, { agent: fake.agent })).toMatchObject({
      ok: false,
      reason: "busy",
    });
    // Another chat of the project is free.
    const other = startChatRun({ ...input, workId: "w2" }, { agent: manualAgent().agent });
    expect(other.ok).toBe(true);

    fake.push({ type: "start", commandId: "c1" });
    await tick();
    expect(isRunLive("c1")).toBe(true);
    expect(listActiveRuns("p1").map((run) => run.commandId)).toEqual(["c1"]);

    fake.close();
    await tick();
    expect(isRunLive("c1")).toBe(false);
    expect(findActiveRun("p1", "w1")).toBeUndefined();
  });

  it("replays what a late subscriber missed, compacted, then follows live", async () => {
    const fake = manualAgent();
    const started = startChatRun(input, { agent: fake.agent });
    if (!started.ok) throw new Error("not started");
    fake.push({ type: "start", commandId: "c1" });
    fake.push({ type: "text.delta", text: "Hel" });
    fake.push({ type: "text.delta", text: "lo" });
    fake.push({ type: "image.partial", index: 0, dataUrl: "a" });
    fake.push({ type: "image.partial", index: 1, dataUrl: "b" });
    await tick();

    const seen: ChatStreamEvent[] = [];
    const ended = vi.fn();
    subscribe(started.run, { onEvent: (e) => seen.push(e), onEnd: ended });
    expect(seen).toEqual([
      { type: "start", commandId: "c1" },
      { type: "text.delta", text: "Hello" },
      { type: "image.partial", index: 1, dataUrl: "b" },
    ]);

    fake.push({ type: "text.delta", text: "!" });
    fake.close();
    await tick();
    expect(seen.at(-1)).toEqual({ type: "text.delta", text: "!" });
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it("a subscriber that leaves does not stop the turn; Stop does", async () => {
    const fake = manualAgent();
    const started = startChatRun(input, { agent: fake.agent });
    if (!started.ok) throw new Error("not started");
    fake.push({ type: "start", commandId: "c1" });
    await tick();

    const unsubscribe = subscribe(started.run, {
      onEvent: () => undefined,
      onEnd: () => undefined,
    });
    unsubscribe();
    expect(fake.signal()?.aborted).toBe(false);
    expect(isRunLive("c1")).toBe(true);

    cancelRun(started.run, "user");
    cancelRun(started.run, "user");
    await tick();
    expect(fake.signal()?.aborted).toBe(true);
    expect(started.run.cancelReason).toBe("user");
    expect(started.run.events.at(-1)).toMatchObject({ type: "done", status: "STOPPED" });
    expect(isRunLive("c1")).toBe(false);
  });

  it("turns an agent crash into a final error event", async () => {
    const crash: ChatRunAgent = async function* () {
      yield { type: "start", commandId: "c9" };
      throw new Error("boom");
    };
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const started = startChatRun(input, { agent: crash });
    if (!started.ok) throw new Error("not started");
    await tick();
    expect(started.run.events.at(-1)).toMatchObject({ type: "error", code: "FAILED", message: "boom" });
    expect(started.run.endedAt).not.toBeNull();
  });
});
