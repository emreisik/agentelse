import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const {
  INITIAL_LIVE_STATE,
  liveStateReducer,
  liveUrlOf,
  parseLiveEvent,
} = await import("./use-seo-live");

const run = (
  phase: "reading_page" | "researching" | "writing" | "checking" | null,
  runId = "r1",
) =>
  ({
    type: "run",
    runId,
    running: true,
    kind: "research",
    phase,
  }) as const;

describe("liveStateReducer", () => {
  it("run: phase and kind of the current run", () => {
    const state = liveStateReducer(INITIAL_LIVE_STATE, run("reading_page"));
    expect(state).toMatchObject({
      runId: "r1",
      kind: "research",
      phase: "reading_page",
      ended: null,
      fallback: false,
    });
    expect(liveStateReducer(state, run("writing")).phase).toBe("writing");
  });

  it("a run event without a phase keeps the last phase", () => {
    const first = liveStateReducer(INITIAL_LIVE_STATE, run("researching"));
    expect(liveStateReducer(first, run(null)).phase).toBe("researching");
  });

  it("end: records the result and clears the phase", () => {
    const first = liveStateReducer(INITIAL_LIVE_STATE, run("writing"));
    const done = liveStateReducer(first, {
      type: "end",
      runId: "r1",
      ok: false,
      message: "It stopped.",
    });
    expect(done.phase).toBeNull();
    expect(done.ended).toEqual({ ok: false, message: "It stopped." });
    // A late run event never undoes the end.
    expect(liveStateReducer(done, run("checking"))).toBe(done);
  });

  it("error: falls back to polling, unless the run already ended", () => {
    const running = liveStateReducer(INITIAL_LIVE_STATE, run("writing"));
    expect(
      liveStateReducer(running, { type: "error", runId: "r1" }).fallback,
    ).toBe(true);
    const ended = liveStateReducer(running, {
      type: "end",
      runId: "r1",
      ok: true,
      message: null,
    });
    expect(liveStateReducer(ended, { type: "error", runId: "r1" })).toBe(ended);
  });

  it("an event of another run starts that run's state from scratch", () => {
    const first = liveStateReducer(INITIAL_LIVE_STATE, run("writing", "r1"));
    const failed = liveStateReducer(first, { type: "error", runId: "r1" });
    const next = liveStateReducer(failed, run("reading_page", "r2"));
    expect(next).toMatchObject({
      runId: "r2",
      phase: "reading_page",
      fallback: false,
      ended: null,
    });
  });

  it("a live event clears an earlier fallback", () => {
    const failed = liveStateReducer(INITIAL_LIVE_STATE, {
      type: "error",
      runId: "r1",
    });
    expect(failed.fallback).toBe(true);
    expect(liveStateReducer(failed, run("writing")).fallback).toBe(false);
  });
});

describe("parseLiveEvent", () => {
  it("reads the run event of the live route", () => {
    expect(
      parseLiveEvent(
        "run",
        '{"running":true,"kind":"snippet","phase":"reading_page"}',
      ),
    ).toEqual({
      type: "run",
      running: true,
      kind: "snippet",
      phase: "reading_page",
    });
    // Unknown phase and kind are dropped, not trusted.
    expect(
      parseLiveEvent("run", '{"running":true,"kind":"x","phase":"y"}'),
    ).toEqual({ type: "run", running: true, kind: null, phase: null });
  });

  it("reads both shapes of the end event", () => {
    expect(parseLiveEvent("end", '{"ok":true,"step":"plan"}')).toEqual({
      type: "end",
      ok: true,
      message: null,
    });
    expect(parseLiveEvent("end", '{"ok":false,"message":"Nope."}')).toEqual({
      type: "end",
      ok: false,
      message: "Nope.",
    });
  });

  it("ignores broken events", () => {
    expect(parseLiveEvent("run", "not json")).toBeNull();
    expect(parseLiveEvent("end", "[]")).toBeNull();
    expect(parseLiveEvent("end", '{"step":"plan"}')).toBeNull();
    expect(parseLiveEvent("ping", "{}")).toBeNull();
  });
});

describe("liveUrlOf", () => {
  it("addresses the card's live route with the run id", () => {
    expect(liveUrlOf("p1", "c1", "run 1")).toBe(
      "/api/projects/p1/seo/cards/c1/live?run=run%201",
    );
  });
});
