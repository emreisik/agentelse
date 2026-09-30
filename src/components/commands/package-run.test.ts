import { describe, expect, it } from "vitest";

import type { ChatStreamEvent } from "@/server/chat/types";

import {
  failPendingItems,
  finalTaskIds,
  isFinalTaskCard,
  isLocalItemSuperseded,
  isServerRowHidden,
  localItemTaskIds,
  needsProgressPoll,
  reduceItemEvent,
  taskIdOfCard,
  type ItemTurnFields,
} from "./package-run";

const image = (): ItemTurnFields => ({
  state: "pending",
  itemId: "post",
  itemTitle: "Post",
  department: "CREATIVE",
  imageGen: { startedAt: 1000, partials: 0, done: false },
});
const text = (): ItemTurnFields => ({
  state: "pending",
  itemId: "seo",
  itemTitle: "Yazı",
  department: "SEO",
});

describe("reduceItemEvent", () => {
  it("gives a text item the running card once its task exists", () => {
    const turn = reduceItemEvent(text(), {
      type: "item.start",
      itemId: "seo",
      taskId: "task-1",
    });
    expect(turn.taskId).toBe("task-1");
    expect(turn.card).toEqual({
      kind: "task-running",
      taskId: "task-1",
      title: "Yazı",
      department: "SEO",
    });
  });

  it("keeps an image item on its live render block instead of a running card", () => {
    const turn = reduceItemEvent(image(), {
      type: "item.start",
      itemId: "post",
      taskId: "task-2",
    });
    expect(turn.taskId).toBe("task-2");
    expect(turn.card).toBeUndefined();
    expect(turn.imageGen).toBeDefined();
  });

  it("sharpens the preview as partials arrive, never moving backwards", () => {
    let turn = reduceItemEvent(image(), {
      type: "item.partial",
      itemId: "post",
      index: 1,
      dataUrl: "data:image/png;base64,B",
    });
    expect(turn.previewUrl).toBe("data:image/png;base64,B");
    expect(turn.imageGen).toEqual({ startedAt: 1000, partials: 2, done: false });

    turn = reduceItemEvent(turn, {
      type: "item.partial",
      itemId: "post",
      index: 0,
      dataUrl: "data:image/png;base64,A",
    });
    expect(turn.imageGen?.partials).toBe(2);
  });

  it("settles on the final card and remembers the persisted row", () => {
    const turn = reduceItemEvent(
      { ...image(), taskId: "task-2", previewUrl: "data:x" },
      {
        type: "item.done",
        itemId: "post",
        ok: true,
        reply: "Creative ready",
        commandId: "row-1",
        card: { kind: "creative-ready", taskId: "task-2", title: "Post" } as never,
      },
    );
    expect(turn).toMatchObject({
      state: "done",
      reply: "Creative ready",
      commandId: "row-1",
      previewUrl: undefined,
      imageGen: undefined,
      card: { kind: "creative-ready" },
    });
  });

  it("marks a failed item as an error and drops its running card", () => {
    const turn = reduceItemEvent(
      reduceItemEvent(text(), {
        type: "item.start",
        itemId: "seo",
        taskId: "task-1",
      }),
      { type: "item.done", itemId: "seo", ok: false, reply: "Could not make it" },
    );
    expect(turn).toMatchObject({ state: "error", reply: "Could not make it" });
    expect(turn.card).toBeUndefined();
  });

  it("ignores events for other items and non-item events", () => {
    const turn = text();
    const other: ChatStreamEvent = {
      type: "item.done",
      itemId: "post",
      ok: true,
      reply: "x",
    };
    expect(reduceItemEvent(turn, other)).toBe(turn);
    expect(reduceItemEvent(turn, { type: "text.delta", text: "hi" })).toBe(turn);
  });
});

describe("failPendingItems", () => {
  it("settles only the pending items of the given run", () => {
    const turns: ItemTurnFields[] = [
      text(),
      { ...image(), state: "done", reply: "ok" },
      { ...text(), itemId: "seo", taskId: "other-run" },
    ];
    // Two runs can reuse the same item ids: only the run's own turns count.
    const result = failPendingItems(
      turns,
      (turn) => turn.taskId !== "other-run",
      "Dropped",
    );
    expect(result[0]).toMatchObject({ state: "error", reply: "Dropped" });
    expect(result[1]).toMatchObject({ state: "done", reply: "ok" });
    expect(result[2]).toMatchObject({ state: "pending" });
  });
});

describe("visibility of an item between local and persisted", () => {
  const running = { kind: "task-running", taskId: "task-1", title: "t" } as const;
  const result = {
    kind: "task-result",
    taskId: "task-1",
    title: "t",
    status: "COMPLETED",
  } as const;

  it("reads the task id off any card that has one", () => {
    expect(taskIdOfCard(running)).toBe("task-1");
    expect(taskIdOfCard({ kind: "idea", title: "t", description: "d" })).toBeUndefined();
    expect(taskIdOfCard(undefined)).toBeUndefined();
  });

  it("tells final task cards from in-progress ones", () => {
    expect(isFinalTaskCard(result)).toBe(true);
    expect(isFinalTaskCard(running)).toBe(false);
    expect(isFinalTaskCard(undefined)).toBe(false);
    expect([...finalTaskIds([running, result, undefined])]).toEqual(["task-1"]);
    expect([...finalTaskIds([running])]).toEqual([]);
  });

  it("hides a persisted running row while its item lives in the chat", () => {
    const local: ItemTurnFields[] = [
      { ...text(), taskId: "task-1" },
      { ...image(), state: "done", taskId: "task-2" },
      text(), // no task yet
    ];
    const ids = localItemTaskIds(local);
    expect([...ids]).toEqual(["task-1", "task-2"]);
    expect(isServerRowHidden(running, ids)).toBe(true);
    // The final row is never hidden — it is what replaces the local copy.
    expect(isServerRowHidden(result, ids)).toBe(false);
    expect(isServerRowHidden({ ...running, taskId: "task-9" }, ids)).toBe(false);
    // Only a task's own in-progress states are hidden: an approval card of the
    // same task is a decision, not a duplicate of the item.
    expect(
      isServerRowHidden(
        {
          kind: "approval-request",
          approvalId: "a1",
          taskId: "task-1",
          title: "t",
          riskLevel: "LOW",
        },
        ids,
      ),
    ).toBe(false);
  });

  it("drops a local item once the persisted row of its task is final", () => {
    const local: ItemTurnFields = { ...text(), taskId: "task-1" };
    expect(isLocalItemSuperseded(local, new Set(["task-1"]))).toBe(true);
    // Also a still-pending one: the persisted truth wins.
    expect(isLocalItemSuperseded({ ...local, state: "done" }, new Set(["task-1"]))).toBe(true);
    expect(isLocalItemSuperseded(local, new Set(["task-9"]))).toBe(false);
    // A plain chat turn is not an item, and an item without a task has no row.
    expect(isLocalItemSuperseded({ state: "done", taskId: "task-1" }, new Set(["task-1"]))).toBe(false);
    expect(isLocalItemSuperseded(text(), new Set(["task-1"]))).toBe(false);
  });
});

describe("needsProgressPoll", () => {
  const NOW = Date.parse("2026-09-30T12:00:00.000Z");
  const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
  const started = (over: Record<string, unknown> = {}) =>
    ({
      source: "WEB",
      createdAt: iso(60 * 60_000),
      card: {
        kind: "content-package",
        topic: "t",
        state: "started",
        startedAt: iso(20_000),
        startedCount: 2,
        items: [],
        ...over,
      },
    }) as never;
  const row = (msAgo: number) =>
    ({
      source: "SYSTEM",
      createdAt: iso(msAgo),
      card: { kind: "creative-ready", taskId: `t${msAgo}`, title: "x" },
    }) as never;

  it("polls while a fresh generating / running row is in the chat", () => {
    const turn = (kind: string, msAgo: number) =>
      ({
        source: "SYSTEM",
        createdAt: iso(msAgo),
        card: { kind, taskId: "task-1", title: "t" },
      }) as never;
    expect(needsProgressPoll([turn("creative-loading", 30_000)], NOW)).toBe(true);
    expect(needsProgressPoll([turn("task-running", 30_000)], NOW)).toBe(true);
    // A stale leftover (never resolved) is not work in flight.
    expect(needsProgressPoll([turn("task-running", 11 * 60_000)], NOW)).toBe(false);
    expect(needsProgressPoll([turn("task-result", 30_000)], NOW)).toBe(false);
  });

  it("polls right after a package started, until every item has a row", () => {
    // Started 20 s ago, none of the 2 items has a row yet: the reload window.
    expect(needsProgressPoll([started()], NOW)).toBe(true);
    // One row so far.
    expect(needsProgressPoll([started(), row(10_000)], NOW)).toBe(true);
    // Both items have rows (running or finished): the rows themselves decide.
    expect(needsProgressPoll([started(), row(10_000), row(9_000)], NOW)).toBe(false);
  });

  it("does not count rows that predate the start, and stops after two minutes", () => {
    expect(needsProgressPoll([started(), row(5 * 60_000), row(6 * 60_000)], NOW)).toBe(true);
    expect(needsProgressPoll([started({ startedAt: iso(3 * 60_000) })], NOW)).toBe(false);
  });

  it("polls right after a saved plan started producing, until every piece has a row", () => {
    const plan = (over: Record<string, unknown> = {}) =>
      ({
        source: "WEB",
        createdAt: iso(60 * 60_000),
        card: {
          kind: "content-plan-draft",
          title: "p",
          timezone: "UTC",
          state: "saved",
          items: [],
          production: {
            state: "running",
            creativeIds: ["a", "b"],
            startedAt: iso(20_000),
          },
          ...over,
        },
      }) as never;
    expect(needsProgressPoll([plan()], NOW)).toBe(true);
    expect(needsProgressPoll([plan(), row(10_000)], NOW)).toBe(true);
    expect(needsProgressPoll([plan(), row(10_000), row(9_000)], NOW)).toBe(false);
    // A finished production, or one claimed long ago, is not in flight.
    expect(
      needsProgressPoll(
        [plan({ production: { state: "done", creativeIds: ["a"], startedAt: iso(20_000) } })],
        NOW,
      ),
    ).toBe(false);
    expect(
      needsProgressPoll(
        [plan({ production: { state: "running", creativeIds: ["a"], startedAt: iso(3 * 60_000) } })],
        NOW,
      ),
    ).toBe(false);
  });

  it("ignores drafts and packages without a start time", () => {
    expect(needsProgressPoll([started({ state: "draft" })], NOW)).toBe(false);
    expect(needsProgressPoll([started({ startedAt: undefined })], NOW)).toBe(false);
    expect(needsProgressPoll([], NOW)).toBe(false);
  });
});
