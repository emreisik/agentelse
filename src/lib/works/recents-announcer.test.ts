import { describe, expect, it, vi } from "vitest";

import {
  createRecentsAnnouncer,
  visibleRecents,
  type RecentRow,
} from "./recents-announcer";

const row = (id: string, title = id): RecentRow => ({
  id,
  title,
  summary: null,
  status: "ACTIVE",
});
const activity = (workId: string, title = "Plan the week.") => ({
  projectId: "p1",
  workId,
  title,
});

const L0 = [row("w1"), row("w2")];

describe("visibleRecents", () => {
  it("is the server list when nothing is announced", () => {
    expect(visibleRecents(L0, [])).toEqual(L0);
  });

  it("leads with the announced chats the server list does not have", () => {
    const a = createRecentsAnnouncer();
    a.sync(L0);
    a.announce(activity("wNew"));
    expect(visibleRecents(L0, a.getSnapshot()).map((r) => r.id)).toEqual([
      "wNew",
      "w1",
      "w2",
    ]);
    expect(a.getSnapshot()[0]?.row).toEqual({
      id: "wNew",
      title: "Plan the week.",
      summary: null,
      status: "ACTIVE",
    });
  });

  it("never lists a chat twice: the server's row wins once it has it", () => {
    const a = createRecentsAnnouncer();
    a.sync(L0);
    a.announce(activity("wNew"));
    const L1 = [row("wNew", "Plan the week."), ...L0];
    expect(visibleRecents(L1, a.getSnapshot()).map((r) => r.id)).toEqual([
      "wNew",
      "w1",
      "w2",
    ]);
  });
});

describe("the row's life", () => {
  it("a chat already in Recents is not announced again", () => {
    const a = createRecentsAnnouncer();
    a.sync(L0);
    a.announce(activity("w2"));
    expect(a.getSnapshot()).toEqual([]);
  });

  it("survives server lists that do not have the chat yet while its turn runs (a channel save, a refresh)", () => {
    const a = createRecentsAnnouncer();
    a.sync(L0);
    a.announce(activity("wNew"));
    // The page re-rendered twice before the first message was stored.
    const L1 = [...L0];
    a.sync(L1);
    const L2 = [...L0];
    a.sync(L2);
    expect(visibleRecents(L2, a.getSnapshot()).map((r) => r.id)).toEqual([
      "wNew",
      "w1",
      "w2",
    ]);
  });

  it("when the turn ends and the server has the chat, its stored row is shown", () => {
    const a = createRecentsAnnouncer();
    a.sync(L0);
    a.announce(activity("wNew"));
    a.settle("wNew");
    const L1 = [row("wNew", "Stored title"), ...L0];
    a.sync(L1);
    expect(a.getSnapshot()).toEqual([]);
    expect(visibleRecents(L1, a.getSnapshot())[0]?.title).toBe("Stored title");
  });

  it("when the turn ends without the server ever having the chat (the send failed), the row goes with the next list", () => {
    const a = createRecentsAnnouncer();
    a.sync(L0);
    a.announce(activity("wNew"));
    a.settle("wNew");
    // Settled, but the page still shows the list it showed: the row stays...
    expect(visibleRecents(L0, a.getSnapshot()).map((r) => r.id)).toContain("wNew");
    // ...until the page's next list, which is the truth, lacks it.
    const L1 = [...L0];
    expect(visibleRecents(L1, a.getSnapshot()).map((r) => r.id)).not.toContain("wNew");
    a.sync(L1);
    expect(a.getSnapshot()).toEqual([]);
  });

  it("a second message while the row is shown adds nothing, and re-opens a settled one", () => {
    const a = createRecentsAnnouncer();
    a.sync(L0);
    a.announce(activity("wNew", "First"));
    a.announce(activity("wNew", "Second"));
    expect(a.getSnapshot()).toHaveLength(1);
    expect(a.getSnapshot()[0]?.row.title).toBe("First");
    a.settle("wNew");
    expect(a.getSnapshot()[0]?.settledAgainst).not.toBeNull();
    a.announce(activity("wNew", "Third"));
    expect(a.getSnapshot()[0]?.settledAgainst).toBeNull();
  });

  it("settling a chat that was never announced (an existing chat) does nothing", () => {
    const a = createRecentsAnnouncer();
    a.sync(L0);
    const listener = vi.fn();
    a.subscribe(listener);
    a.settle("w1");
    expect(listener).not.toHaveBeenCalled();
    expect(a.getSnapshot()).toEqual([]);
  });

  it("notifies subscribers on change only, and stops after unsubscribe", () => {
    const a = createRecentsAnnouncer();
    a.sync(L0);
    const listener = vi.fn();
    const off = a.subscribe(listener);
    a.sync(L0);
    expect(listener).not.toHaveBeenCalled();
    a.announce(activity("wNew"));
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    a.settle("wNew");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("keeps the snapshot identity until something changes (useSyncExternalStore needs it)", () => {
    const a = createRecentsAnnouncer();
    a.sync(L0);
    const before = a.getSnapshot();
    a.sync(L0);
    a.settle("nope");
    expect(a.getSnapshot()).toBe(before);
  });

  it("announced rows lead in the order they were announced, newest first", () => {
    const a = createRecentsAnnouncer();
    a.sync(L0);
    a.announce(activity("wA"));
    a.announce(activity("wB"));
    expect(visibleRecents(L0, a.getSnapshot()).map((r) => r.id)).toEqual([
      "wB",
      "wA",
      "w1",
      "w2",
    ]);
  });
});
