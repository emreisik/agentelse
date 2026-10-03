import { describe, expect, it, vi } from "vitest";

import {
  createDetailStore,
  detailIsGone,
  isDetailOpen,
  togglePanel,
} from "./detail-pane";

describe("open and close", () => {
  it("opens one card at a time, the newest replacing the one before", () => {
    const store = createDetailStore();
    store.open("c1", "Plan");
    expect(store.getSnapshot().detail).toEqual({ id: "c1", title: "Plan" });
    store.open("c2", "Ideas");
    expect(store.getSnapshot().detail).toEqual({ id: "c2", title: "Ideas" });
    store.close();
    expect(store.getSnapshot().detail).toBeNull();
  });

  it("opening the same card with a new title (it changed in place) updates the title", () => {
    const store = createDetailStore();
    store.open("c1", "Directions");
    store.open("c1", "Autumn week");
    expect(store.getSnapshot().detail).toEqual({ id: "c1", title: "Autumn week" });
  });

  it("notifies only on a real change", () => {
    const store = createDetailStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.close();
    expect(listener).not.toHaveBeenCalled();
    store.open("c1", "Plan");
    store.open("c1", "Plan");
    expect(listener).toHaveBeenCalledTimes(1);
    store.close();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("keeps the snapshot identity until something changes", () => {
    const store = createDetailStore();
    const before = store.getSnapshot();
    store.close();
    expect(store.getSnapshot()).toBe(before);
    store.open("c1", "Plan");
    expect(store.getSnapshot()).not.toBe(before);
  });

  it("stops notifying after unsubscribe", () => {
    const store = createDetailStore();
    const listener = vi.fn();
    const off = store.subscribe(listener);
    off();
    store.open("c1", "Plan");
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("isDetailOpen", () => {
  it("is true only for the open card", () => {
    const store = createDetailStore();
    expect(isDetailOpen(store.getSnapshot(), "c1")).toBe(false);
    store.open("c1", "Plan");
    expect(isDetailOpen(store.getSnapshot(), "c1")).toBe(true);
    expect(isDetailOpen(store.getSnapshot(), "c2")).toBe(false);
  });
});

describe("the element the card is shown in", () => {
  it("is handed over by the pane and taken back when the pane goes", () => {
    const store = createDetailStore<{ id: string }>();
    const element = { id: "pane" };
    store.setContainer(element);
    expect(store.getSnapshot().container).toBe(element);
    store.setContainer(null);
    expect(store.getSnapshot().container).toBeNull();
  });

  it("is not announced again when it is the same element", () => {
    const store = createDetailStore<object>();
    const listener = vi.fn();
    const element = {};
    store.setContainer(element);
    store.subscribe(listener);
    store.setContainer(element);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("which cards are in the chat", () => {
  it("a card is present while it is registered", () => {
    const store = createDetailStore();
    const take = store.register("c1");
    expect(store.getSnapshot().present.has("c1")).toBe(true);
    take();
    expect(store.getSnapshot().present.has("c1")).toBe(false);
  });

  it("two cards with one id (the streamed copy and the stored one) keep it present until both are gone", () => {
    const store = createDetailStore();
    const first = store.register("c1");
    const second = store.register("c1");
    first();
    expect(store.getSnapshot().present.has("c1")).toBe(true);
    second();
    expect(store.getSnapshot().present.has("c1")).toBe(false);
  });

  it("taking a card back twice does nothing the second time", () => {
    const store = createDetailStore();
    const first = store.register("c1");
    store.register("c1");
    first();
    first();
    expect(store.getSnapshot().present.has("c1")).toBe(true);
  });
});

describe("detailIsGone", () => {
  it("is true only when a card is open and not in the chat", () => {
    const store = createDetailStore();
    expect(detailIsGone(store.getSnapshot())).toBe(false);
    store.open("c1", "Plan");
    expect(detailIsGone(store.getSnapshot())).toBe(true);
    const take = store.register("c1");
    expect(detailIsGone(store.getSnapshot())).toBe(false);
    take();
    expect(detailIsGone(store.getSnapshot())).toBe(true);
    store.close();
    expect(detailIsGone(store.getSnapshot())).toBe(false);
  });
});

describe("togglePanel (the header's hide button)", () => {
  it("with a card open it closes the card and hides the panel with it", () => {
    expect(togglePanel({ detailOpen: true, collapsed: false })).toEqual({
      closeDetail: true,
      collapsed: true,
    });
    expect(togglePanel({ detailOpen: true, collapsed: true })).toEqual({
      closeDetail: true,
      collapsed: true,
    });
  });

  it("without one it flips the panel, as before", () => {
    expect(togglePanel({ detailOpen: false, collapsed: false })).toEqual({
      closeDetail: false,
      collapsed: true,
    });
    expect(togglePanel({ detailOpen: false, collapsed: true })).toEqual({
      closeDetail: false,
      collapsed: false,
    });
  });
});
