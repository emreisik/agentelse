import { afterEach, describe, expect, it, vi } from "vitest";

import {
  WORK_ACTIVITY_EVENT,
  WORK_SETTLED_EVENT,
  activityOf,
  announceWorkActivity,
  announceWorkSettled,
  isWorkActivity,
  isWorkSettled,
  settledOf,
} from "./work-activity";

describe("isWorkActivity", () => {
  it("accepts what the chat screen announces", () => {
    expect(
      isWorkActivity({
        projectId: "p1",
        workId: "w1",
        title: "Plan the week.",
      }),
    ).toBe(true);
    expect(isWorkActivity({ projectId: "p1", workId: "w1", title: "" })).toBe(
      true,
    );
  });

  it("rejects anything else on the event", () => {
    for (const value of [
      null,
      undefined,
      "w1",
      { projectId: "p1", workId: "", title: "x" },
      { projectId: "p1", title: "x" },
      { projectId: 1, workId: "w1", title: "x" },
      { projectId: "p1", workId: "w1" },
    ]) {
      expect(isWorkActivity(value)).toBe(false);
    }
  });
});

describe("announceWorkActivity", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("dispatches the activity on window", () => {
    const target = new EventTarget();
    vi.stubGlobal("window", target);
    const seen: unknown[] = [];
    target.addEventListener(WORK_ACTIVITY_EVENT, (event) => {
      seen.push((event as CustomEvent).detail);
    });
    announceWorkActivity({ projectId: "p1", workId: "w1", title: "Hi" });
    expect(seen).toEqual([{ projectId: "p1", workId: "w1", title: "Hi" }]);
  });

  it("does nothing during a server render (no window)", () => {
    expect(typeof window).toBe("undefined");
    expect(() =>
      announceWorkActivity({ projectId: "p1", workId: "w1", title: "Hi" }),
    ).not.toThrow();
  });
});

describe("isWorkSettled", () => {
  it("accepts a project and a chat, rejects the rest", () => {
    expect(isWorkSettled({ projectId: "p1", workId: "w1" })).toBe(true);
    for (const value of [null, "w1", { projectId: "p1" }, { projectId: "p1", workId: "" }, { workId: "w1" }]) {
      expect(isWorkSettled(value)).toBe(false);
    }
  });
});

describe("what one project's sidebar takes from an event", () => {
  const sent = { projectId: "p1", workId: "w1", title: "Hi" };

  it("only its own project's well-formed activity", () => {
    expect(activityOf("p1", sent)).toEqual(sent);
    expect(activityOf("p2", sent)).toBeNull();
    expect(activityOf("p1", { projectId: "p1", workId: "" , title: "x" })).toBeNull();
    expect(activityOf("p1", undefined)).toBeNull();
  });

  it("only its own project's settled turns", () => {
    const done = { projectId: "p1", workId: "w1" };
    expect(settledOf("p1", done)).toEqual(done);
    expect(settledOf("p2", done)).toBeNull();
    expect(settledOf("p1", { projectId: "p1" })).toBeNull();
  });
});

describe("announceWorkSettled", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("dispatches the settled turn on window, on its own event", () => {
    const target = new EventTarget();
    vi.stubGlobal("window", target);
    const settled: unknown[] = [];
    const sent: unknown[] = [];
    target.addEventListener(WORK_SETTLED_EVENT, (event) => {
      settled.push((event as CustomEvent).detail);
    });
    target.addEventListener(WORK_ACTIVITY_EVENT, (event) => {
      sent.push((event as CustomEvent).detail);
    });
    announceWorkSettled({ projectId: "p1", workId: "w1" });
    expect(settled).toEqual([{ projectId: "p1", workId: "w1" }]);
    expect(sent).toEqual([]);
  });

  it("does nothing during a server render (no window)", () => {
    expect(() =>
      announceWorkSettled({ projectId: "p1", workId: "w1" }),
    ).not.toThrow();
  });
});
