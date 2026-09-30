import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  EMPTY_IDEA_OPTIONS,
  POLL,
  SAVE_RETRY,
  type ApplyResult,
  type GuidedSetupHost,
  type GuidedSetupView,
  type IdeasView,
  type SaveResponse,
} from "@/lib/guided-setup/contract";

import type { ApiResult } from "./guided-setup-client";
import {
  guidedSetupReducer,
  initialModel,
  type Action,
  type Model,
} from "./guided-setup-state";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/server/actions/guided-setup-actions", () => ({
  applyGuidedSetupAction: vi.fn(),
}));

const { CLOSE_WAIT_MS, closesOn, createController, makeFinalFocus } =
  await import("./guided-setup-sheet");

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const host: GuidedSetupHost = {
  summary: {
    status: "NONE",
    answered: 0,
    total: 5,
    position: 1,
    started: false,
    hasProfile: false,
  },
  seedFirst: false,
  languageCode: "en",
  requested: false,
};

const ideasView = (over: Partial<IdeasView> = {}): IdeasView => ({
  status: "IDLE",
  source: "none",
  attempts: 0,
  canStart: true,
  canRetry: false,
  options: EMPTY_IDEA_OPTIONS,
  ...over,
});

const view = (over: Partial<GuidedSetupView> = {}): GuidedSetupView => ({
  rev: "rev001",
  status: "OPEN",
  step: null,
  more: false,
  answers: {},
  brand: { name: "Qr Hub Menu", host: "qrhubmenu.com", languageCode: "en" },
  current: {},
  seedFirst: false,
  staticFirst: false,
  hasProfile: false,
  projectActive: true,
  goalMode: "proposed",
  handsOn: "AUTOPILOT",
  channels: [],
  ideas: ideasView(),
  ...over,
});

const SAVED: SaveResponse = {
  rev: "rev002",
  status: "OPEN",
  ideas: ideasView(),
};

const okResult: Extract<ApplyResult, { ok: true }> = {
  ok: true,
  parts: ["profile", "goal"],
  unchanged: false,
  goalMode: "proposed",
  unconnected: [],
};

function good<T>(data: T): ApiResult<T> {
  return { ok: true, data };
}
const bad = (kind: "NETWORK" | "SESSION" | "NOT_FOUND" | "RATE" | "HTTP") =>
  ({ ok: false, kind }) as const;

const run = (model: Model, ...actions: Action[]): Model =>
  actions.reduce(guidedSetupReducer, model);

const fresh = (): Model =>
  initialModel({
    projectId: "p1",
    brandName: "Qr Hub Menu",
    languageCode: "en",
    host,
    canDraftPlan: true,
  });

// A hydrated model with one answer: an edit is pending and Approve is possible.
const edited = (): Model =>
  run(
    fresh(),
    { type: "hydrated", view: view({ rev: "rev777" }) },
    { type: "pick", id: "goal.sales" },
  );

// -----------------------------------------------------------------------------
// Harness: a controller wired to a reducer, like the component does
// -----------------------------------------------------------------------------

type Client = Parameters<typeof createController>[0]["client"];

function harness(
  opts: {
    model?: Model;
    open?: boolean;
    throwOn?: Action["type"];
    // React commits (and runs the sync effect) after the current microtasks,
    // never inside dispatch: model the real timing.
    lazySync?: boolean;
  } = {},
) {
  const client = {
    start: vi.fn<Client["start"]>(async () => good(view())),
    save: vi.fn<Client["save"]>(async () => good(SAVED)),
    discover: vi.fn<Client["discover"]>(async () =>
      good({ outcome: "STARTED" as const, ideas: ideasView() }),
    ),
    draftPlan: vi.fn<Client["draftPlan"]>(),
    poll: vi.fn<Client["poll"]>(),
  } satisfies Client;
  const apply = vi.fn<(rev: string) => Promise<ApplyResult>>(
    async () => okResult,
  );
  const dispatched: Action[] = [];
  let model = opts.model ?? fresh();
  const state = { open: opts.open ?? true };
  const ctl = createController({
    initial: model,
    client,
    dispatch: (action) => {
      if (action.type === opts.throwOn) throw new Error("reducer bug");
      dispatched.push(action);
      model = guidedSetupReducer(model, action);
      if (opts.lazySync) setTimeout(() => ctl.sync(model, state.open), 0);
      else ctl.sync(model, state.open);
    },
    apply,
  });
  ctl.sync(model, state.open);
  const detach = ctl.attach();
  return {
    client,
    apply,
    ctl,
    dispatched,
    state,
    detach,
    model: () => model,
    // Mirrors the component's per-commit sync.
    commit: (next: Model) => {
      model = next;
      ctl.sync(model, state.open);
    },
    actions: (type: Action["type"]) =>
      dispatched.filter((action) => action.type === type),
  };
}

let windowEvents: EventTarget;
let doc: EventTarget & { hidden: boolean };

beforeEach(() => {
  vi.useFakeTimers();
  windowEvents = new EventTarget();
  doc = Object.assign(new EventTarget(), { hidden: false });
  vi.stubGlobal("window", windowEvents);
  vi.stubGlobal("document", doc);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const settle = () => vi.advanceTimersByTimeAsync(0);

// -----------------------------------------------------------------------------
// Save queue
// -----------------------------------------------------------------------------

describe("save queue", () => {
  it("awaits the start promise before the first save (a pick made during boot)", async () => {
    const h = harness({
      model: run(fresh(), { type: "pick", id: "goal.sales" }),
    });
    let release: (value: ApiResult<GuidedSetupView>) => void = () => {};
    h.client.start.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    h.ctl.opened(true, undefined);
    void h.ctl.enqueueSave(true);
    await settle();
    expect(h.client.save).not.toHaveBeenCalled();

    release(good(view()));
    await settle();
    expect(h.client.save).toHaveBeenCalledTimes(1);
    expect(h.client.save.mock.calls[0]?.[0].answers.goal).toEqual({
      picked: ["goal.sales"],
    });
  });

  it("latest wins: a superseded save is never sent", async () => {
    const h = harness({ model: edited() });
    let release: (value: ApiResult<GuidedSetupView>) => void = () => {};
    h.client.start.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    h.ctl.opened(true, undefined);
    const first = h.ctl.enqueueSave(true);
    const second = h.ctl.enqueueSave(true);
    release(good(view()));
    await settle();
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(h.client.save).toHaveBeenCalledTimes(1);
    expect(h.actions("saved")).toHaveLength(1);
  });

  it("retries at the SAVE_RETRY delays, then reports the failure", async () => {
    const h = harness({ model: edited() });
    h.client.save.mockResolvedValue(bad("NETWORK"));
    const result = h.ctl.enqueueSave(true);
    await settle();
    expect(h.client.save).toHaveBeenCalledTimes(1);

    let elapsed = 0;
    for (const [i, delay] of SAVE_RETRY.delaysMs.entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(h.client.save).toHaveBeenCalledTimes(i + 1);
      await vi.advanceTimersByTimeAsync(1);
      elapsed += delay;
      expect(h.client.save).toHaveBeenCalledTimes(i + 2);
    }
    expect(elapsed).toBe(12_000);
    await expect(result).resolves.toBe(false);
    expect(h.client.save).toHaveBeenCalledTimes(SAVE_RETRY.delaysMs.length + 1);
    expect(h.actions("saveFailed")).toHaveLength(1);
    expect(h.model().save).toBe("failed");
  });

  it("an 'online' event retries immediately instead of waiting out the delay", async () => {
    const h = harness({ model: edited() });
    h.client.save.mockResolvedValueOnce(bad("NETWORK"));
    const result = h.ctl.enqueueSave(true);
    await settle();
    expect(h.client.save).toHaveBeenCalledTimes(1);

    windowEvents.dispatchEvent(new Event("online"));
    await settle();
    expect(h.client.save).toHaveBeenCalledTimes(2);
    await expect(result).resolves.toBe(true);
    expect(h.actions("saved")).toHaveLength(1);
  });

  it("'online' after a final failure starts a fresh attempt", async () => {
    const h = harness({ model: edited() });
    h.client.save.mockResolvedValue(bad("NETWORK"));
    void h.ctl.enqueueSave(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.model().save).toBe("failed");
    const calls = h.client.save.mock.calls.length;

    h.client.save.mockResolvedValue(good(SAVED));
    windowEvents.dispatchEvent(new Event("online"));
    await settle();
    expect(h.client.save).toHaveBeenCalledTimes(calls + 1);
    expect(h.model().save).toBe("idle");
  });

  it("a signed-out answer ends the queue at once (no retries)", async () => {
    const h = harness({ model: edited() });
    h.client.save.mockResolvedValue(bad("SESSION"));
    await expect(h.ctl.enqueueSave(true)).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.client.save).toHaveBeenCalledTimes(1);
    expect(h.model().phase).toBe("expired");
  });

  it("flush after a failure makes ONE fresh attempt (no backoff)", async () => {
    const h = harness({ model: edited() });
    h.client.save.mockResolvedValue(bad("NETWORK"));
    void h.ctl.enqueueSave(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.model().save).toBe("failed");
    const calls = h.client.save.mock.calls.length;

    await expect(h.ctl.flush()).resolves.toBe(false);
    expect(h.client.save).toHaveBeenCalledTimes(calls + 1);

    h.client.save.mockResolvedValue(good(SAVED));
    await expect(h.ctl.flush()).resolves.toBe(true);
    expect(h.model().save).toBe("idle");
  });

  it("an unexpected throw inside a save is a failed save, never an unhandled rejection", async () => {
    const h = harness({ model: edited() });
    h.client.save.mockRejectedValue(new Error("boom"));
    await expect(h.ctl.enqueueSave(true)).resolves.toBe(false);
    expect(h.model().save).toBe("failed");
    // The chain keeps working afterwards.
    h.client.save.mockResolvedValue(good(SAVED));
    await expect(h.ctl.flush()).resolves.toBe(true);
  });

  it("flush with nothing wrong sends nothing", async () => {
    const h = harness({ model: edited() });
    h.commit({ ...h.model(), save: "idle" });
    await expect(h.ctl.flush()).resolves.toBe(true);
    expect(h.client.save).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// Boot: POST start once per open
// -----------------------------------------------------------------------------

describe("boot", () => {
  it("starts once per open, again on reopen", async () => {
    const h = harness();
    h.ctl.opened(true, "cmd1");
    h.ctl.opened(true, "cmd1");
    await settle();
    expect(h.client.start).toHaveBeenCalledTimes(1);
    expect(h.client.start).toHaveBeenCalledWith("cmd1");

    h.ctl.opened(false, "cmd1");
    h.ctl.opened(true, "cmd1");
    await settle();
    expect(h.client.start).toHaveBeenCalledTimes(2);
  });

  it("a closed sheet never starts", async () => {
    const h = harness({ open: false });
    h.ctl.opened(false, undefined);
    await settle();
    expect(h.client.start).not.toHaveBeenCalled();
  });

  it("the first open keeps what was typed while booting; a settled reopen takes the server state", async () => {
    const h = harness();
    h.ctl.opened(true, undefined);
    await settle();
    expect((h.actions("hydrated")[0] as { reload?: boolean }).reload).toBe(
      false,
    );

    h.ctl.opened(false, undefined);
    h.commit({ ...h.model(), save: "idle" });
    h.ctl.opened(true, undefined);
    await settle();
    expect((h.actions("hydrated")[1] as { reload?: boolean }).reload).toBe(
      true,
    );
  });

  it("a reopen with an unsaved (failed) selection keeps the local state", async () => {
    const h = harness();
    h.ctl.opened(true, undefined);
    await settle();
    h.ctl.opened(false, undefined);
    h.commit({ ...h.model(), save: "failed" });
    h.ctl.opened(true, undefined);
    await settle();
    expect((h.actions("hydrated")[1] as { reload?: boolean }).reload).toBe(
      false,
    );
  });

  it("maps start failures: network -> boot error, removed feature -> unavailable, signed out -> expired", async () => {
    for (const [result, phase] of [
      [bad("NETWORK"), "bootError"],
      [bad("NOT_FOUND"), "unavailable"],
      [bad("SESSION"), "expired"],
    ] as const) {
      const h = harness({ model: run(fresh()) });
      h.client.start.mockResolvedValue(result);
      h.ctl.opened(true, undefined);
      await settle();
      expect(h.model().phase).toBe(phase);
    }
  });

  it("a save after a failed start still goes out when the session is known (reopen)", async () => {
    const h = harness({ model: edited() });
    h.client.start.mockResolvedValue(bad("NETWORK"));
    h.ctl.opened(true, undefined);
    await h.ctl.enqueueSave(true);
    expect(h.client.save).toHaveBeenCalledTimes(1);
  });
});

// -----------------------------------------------------------------------------
// Closing is always available and never loses the selection
// -----------------------------------------------------------------------------

describe("requestClose", () => {
  it("closes at once when nothing is unsaved", () => {
    const h = harness({ model: edited() });
    h.commit({ ...h.model(), save: "idle" });
    const close = vi.fn();
    h.ctl.requestClose(close);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("flushes the save queue first, then closes", async () => {
    const h = harness({ model: edited() });
    let release: (value: ApiResult<SaveResponse>) => void = () => {};
    h.client.save.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    void h.ctl.enqueueSave(true);
    await settle();
    const close = vi.fn();
    h.ctl.requestClose(close);
    await settle();
    expect(close).not.toHaveBeenCalled();

    release(good(SAVED));
    await settle();
    expect(close).toHaveBeenCalledTimes(1);
    expect(h.client.save).toHaveBeenCalledTimes(1);
  });

  it("closes anyway when the queue is slow: the person is never trapped, the queue keeps running", async () => {
    const h = harness({ model: edited() });
    h.client.save.mockReturnValue(new Promise(() => {}));
    void h.ctl.enqueueSave(true);
    await settle();
    const close = vi.fn();
    h.ctl.requestClose(close);
    await vi.advanceTimersByTimeAsync(CLOSE_WAIT_MS - 1);
    expect(close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes when the flush fails, and keeps the local selection", async () => {
    const h = harness({ model: edited() });
    h.client.save.mockResolvedValue(bad("NETWORK"));
    void h.ctl.enqueueSave(true);
    await vi.advanceTimersByTimeAsync(20_000);
    const close = vi.fn();
    h.ctl.requestClose(close);
    await settle();
    expect(close).toHaveBeenCalledTimes(1);
    expect(h.model().answers.goal).toEqual({ picked: ["goal.sales"] });
  });

  it("closes while applying (the shell owns the action)", () => {
    const h = harness({ model: edited() });
    h.commit({ ...h.model(), phase: "applying", save: "idle" });
    const close = vi.fn();
    h.ctl.requestClose(close);
    expect(close).toHaveBeenCalledTimes(1);
  });
});

// -----------------------------------------------------------------------------
// Approve
// -----------------------------------------------------------------------------

describe("approve", () => {
  it("applies at the reviewed revision and moves to done", async () => {
    const h = harness({ model: edited() });
    h.ctl.approve();
    await settle();
    expect(h.apply).toHaveBeenCalledWith("rev777");
    expect(h.model().phase).toBe("done");
  });

  it("a throwing Server Action can never leave the sheet stuck in 'applying'", async () => {
    const h = harness({ model: edited() });
    h.apply.mockRejectedValue(new Error("Failed to find Server Action"));
    h.ctl.approve();
    await settle();
    expect(h.actions("applyStarted")).toHaveLength(1);
    expect(h.model().phase).toBe("ready");
    expect(h.model().inline).toEqual({ kind: "failed", retry: true });
    expect(h.model().toast).toBeNull();

    // The same call again is possible (Try again).
    h.apply.mockResolvedValue(okResult);
    h.ctl.approve();
    await settle();
    expect(h.model().phase).toBe("done");
  });

  it("a throw while the sheet is closed becomes the late toast intent", async () => {
    const h = harness({ model: edited(), open: false });
    h.apply.mockRejectedValue(new Error("boom"));
    h.ctl.approve();
    await settle();
    expect(h.model().phase).toBe("ready");
    expect(h.model().toast).toMatchObject({ kind: "partial" });
  });

  it("a result that arrives while the sheet is closed is a toast intent; while open it is not", async () => {
    const closed = harness({ model: edited(), open: false });
    closed.ctl.approve();
    await settle();
    expect(closed.model().toast).toMatchObject({ kind: "saved" });

    const open = harness({ model: edited() });
    open.ctl.approve();
    await settle();
    expect(open.model().toast).toBeNull();
  });

  it("flushes first and stops at the inline alert when the flush fails", async () => {
    const h = harness({ model: edited() });
    h.client.save.mockResolvedValue(bad("NETWORK"));
    void h.ctl.enqueueSave(true);
    await vi.advanceTimersByTimeAsync(20_000);

    h.ctl.approve();
    await settle();
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.model().phase).toBe("ready");
    expect(h.model().save).toBe("failed");
  });

  it("any unexpected throw in the chain is mapped to applyFailed, never a stuck sheet", async () => {
    const h = harness({ model: edited(), throwOn: "applyStarted" });
    h.ctl.approve();
    await settle();
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.model().phase).toBe("ready");
    expect(h.actions("applyFailed")).toEqual([
      { type: "applyFailed", code: "FAILED", closed: false },
    ]);

    const closed = harness({
      model: edited(),
      open: false,
      throwOn: "applyStarted",
    });
    closed.ctl.approve();
    await settle();
    expect(closed.actions("applyFailed")).toEqual([
      { type: "applyFailed", code: "FAILED", closed: true },
    ]);
  });

  it("sends the rev the in-flight save just returned, even before React commits it", async () => {
    // The person changed the last answer and tapped Approve while the save was
    // still in flight: the server answers the save with a new rev, and Approve
    // must use that one or claimApply answers STALE.
    const h = harness({ model: edited(), lazySync: true });
    let release: (value: ApiResult<SaveResponse>) => void = () => {};
    h.client.save.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    void h.ctl.enqueueSave(true);
    await settle();
    h.ctl.approve();
    await settle();
    release(good({ ...SAVED, rev: "rev888" }));
    await settle();
    expect(h.apply).toHaveBeenCalledWith("rev888");
  });

  it("a double tap applies once", async () => {
    const h = harness({ model: edited() });
    let release: (result: ApplyResult) => void = () => {};
    h.apply.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    h.ctl.approve();
    h.ctl.approve();
    await settle();
    release(okResult);
    await settle();
    expect(h.apply).toHaveBeenCalledTimes(1);
  });
});

// -----------------------------------------------------------------------------
// Discover
// -----------------------------------------------------------------------------

describe("discover", () => {
  it("flushes the queue first; a failed flush never starts a paid run", async () => {
    const h = harness({ model: edited() });
    h.client.save.mockResolvedValue(bad("NETWORK"));
    void h.ctl.enqueueSave(true);
    await vi.advanceTimersByTimeAsync(20_000);

    await h.ctl.discover();
    expect(h.client.discover).not.toHaveBeenCalled();
  });

  it("hands the ideas to the reducer as a discover update", async () => {
    const h = harness({ model: edited() });
    h.commit({ ...h.model(), save: "idle" });
    const running = ideasView({ status: "RUNNING", canStart: false });
    h.client.discover.mockResolvedValue(
      good({ outcome: "STARTED", ideas: running }),
    );
    await h.ctl.discover();
    expect(h.client.discover).toHaveBeenCalledTimes(1);
    expect(h.actions("ideasUpdated")).toEqual([
      { type: "ideasUpdated", ideas: running, from: "discover" },
    ]);
  });

  it("maps failures: signed out -> expired, anything else -> inline retry", async () => {
    const h = harness({ model: edited() });
    h.commit({ ...h.model(), save: "idle" });
    h.client.discover.mockResolvedValue(bad("RATE"));
    await h.ctl.discover();
    expect(h.actions("discoverFailed")).toHaveLength(1);

    h.client.discover.mockResolvedValue(bad("SESSION"));
    await h.ctl.discover();
    expect(h.model().phase).toBe("expired");
  });

  it("a double tap starts one request", async () => {
    const h = harness({ model: edited() });
    h.commit({ ...h.model(), save: "idle" });
    let release: (value: ApiResult<never>) => void = () => {};
    h.client.discover.mockReturnValue(
      new Promise((resolve) => {
        release = resolve as typeof release;
      }),
    );
    const first = h.ctl.discover();
    const second = h.ctl.discover();
    await settle();
    release(bad("NETWORK"));
    await Promise.all([first, second]);
    expect(h.client.discover).toHaveBeenCalledTimes(1);
  });
});

// -----------------------------------------------------------------------------
// Polling
// -----------------------------------------------------------------------------

describe("polling", () => {
  const running = ideasView({ status: "RUNNING", canStart: false, ageSec: 5 });
  const ready = ideasView({ status: "READY", source: "discovery" });
  const pollOk = (ideas: IdeasView) =>
    good({ rev: "rev001", status: "OPEN" as const, ideas });

  it("polls every interval while RUNNING and stops at a terminal state", async () => {
    const h = harness();
    h.client.poll
      .mockResolvedValueOnce(pollOk(running))
      .mockResolvedValueOnce(pollOk(ready));
    h.ctl.startPolling();
    await vi.advanceTimersByTimeAsync(POLL.intervalMs - 1);
    expect(h.client.poll).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.client.poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(POLL.intervalMs);
    expect(h.client.poll).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.client.poll).toHaveBeenCalledTimes(2);
    expect(
      h.actions("ideasUpdated").map((a) => (a as { from: string }).from),
    ).toEqual(["poll", "poll"]);
  });

  it("skips ticks while the tab is hidden and resumes when visible", async () => {
    const h = harness();
    h.client.poll.mockResolvedValue(pollOk(running));
    doc.hidden = true;
    h.ctl.startPolling();
    await vi.advanceTimersByTimeAsync(POLL.intervalMs * 5);
    expect(h.client.poll).not.toHaveBeenCalled();

    doc.hidden = false;
    await vi.advanceTimersByTimeAsync(POLL.intervalMs);
    expect(h.client.poll).toHaveBeenCalledTimes(1);
  });

  it("time spent in a hidden tab does not count against POLL.maxMs", async () => {
    const h = harness();
    h.client.poll.mockResolvedValue(pollOk(running));
    doc.hidden = true;
    h.ctl.startPolling();
    await vi.advanceTimersByTimeAsync(POLL.maxMs * 2);
    expect(h.client.poll).not.toHaveBeenCalled();

    doc.hidden = false;
    await vi.advanceTimersByTimeAsync(POLL.intervalMs * 3);
    // Still polling: the hidden minutes were not a budget spent.
    expect(h.client.poll.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("coming back to the tab polls right away, even after the loop gave up", async () => {
    const h = harness();
    h.client.poll.mockResolvedValue(bad("NETWORK"));
    h.ctl.startPolling();
    await vi.advanceTimersByTimeAsync(120_000);
    const before = h.client.poll.mock.calls.length;
    expect(before).toBe(POLL.maxConsecutiveFailures);

    h.client.poll.mockResolvedValue(pollOk(ready));
    doc.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(h.client.poll).toHaveBeenCalledTimes(before + 1);
    expect(h.model().ideas?.status).toBe("READY");
  });

  it("a visibilitychange to hidden, or after stop(), polls nothing", async () => {
    const h = harness();
    h.client.poll.mockResolvedValue(pollOk(running));
    const stop = h.ctl.startPolling();
    doc.hidden = true;
    doc.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(h.client.poll).not.toHaveBeenCalled();
    doc.hidden = false;
    stop();
    doc.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(h.client.poll).not.toHaveBeenCalled();
  });

  it("backs off silently and gives up after the allowed consecutive failures", async () => {
    const h = harness();
    h.client.poll.mockResolvedValue(bad("NETWORK"));
    h.ctl.startPolling();
    await vi.advanceTimersByTimeAsync(POLL.intervalMs);
    expect(h.client.poll).toHaveBeenCalledTimes(1);
    // The delay doubled after the first failure.
    await vi.advanceTimersByTimeAsync(POLL.intervalMs * 2 - 1);
    expect(h.client.poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.client.poll).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.client.poll).toHaveBeenCalledTimes(POLL.maxConsecutiveFailures);
    // Silent: no notice reaches the model.
    expect(h.dispatched).toEqual([]);
  });

  it("stops after POLL.maxMs of RUNNING", async () => {
    const h = harness();
    h.client.poll.mockResolvedValue(pollOk(running));
    h.ctl.startPolling();
    await vi.advanceTimersByTimeAsync(POLL.maxMs + POLL.intervalMs * 3);
    const calls = h.client.poll.mock.calls.length;
    expect(calls).toBeGreaterThan(10);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.client.poll).toHaveBeenCalledTimes(calls);
  });

  it("the returned stop function ends the loop", async () => {
    const h = harness();
    h.client.poll.mockResolvedValue(pollOk(running));
    const stop = h.ctl.startPolling();
    await vi.advanceTimersByTimeAsync(POLL.intervalMs);
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.client.poll).toHaveBeenCalledTimes(1);
  });

  it("a poll that comes back after stop() is ignored", async () => {
    const h = harness();
    let release: (value: ApiResult<never>) => void = () => {};
    h.client.poll.mockReturnValue(
      new Promise((resolve) => {
        release = resolve as typeof release;
      }),
    );
    const stop = h.ctl.startPolling();
    await vi.advanceTimersByTimeAsync(POLL.intervalMs);
    expect(h.client.poll).toHaveBeenCalledTimes(1);
    stop();
    release(pollOk(running) as never);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.client.poll).toHaveBeenCalledTimes(1);
    expect(h.dispatched).toEqual([]);
  });

  it("a signed-out poll marks the session expired and stops", async () => {
    const h = harness();
    h.client.poll.mockResolvedValue(bad("SESSION"));
    h.ctl.startPolling();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.client.poll).toHaveBeenCalledTimes(1);
    expect(h.model().phase).toBe("expired");
  });
});

// -----------------------------------------------------------------------------
// Focus return
// -----------------------------------------------------------------------------

describe("finalFocus", () => {
  const viewport = { tabIndex: 0 };
  const queries: string[] = [];
  beforeEach(() => {
    queries.length = 0;
    viewport.tabIndex = 0;
    vi.stubGlobal("document", {
      hidden: false,
      querySelector: (selector: string) => {
        queries.push(selector);
        return selector === '[data-slot="aui_thread-viewport"]'
          ? viewport
          : null;
      },
    });
  });

  it("returns the opener while it is still connected", () => {
    const opener = { isConnected: true } as HTMLElement;
    expect(makeFinalFocus({ current: opener })()).toBe(opener);
    expect(queries).toEqual([]);
  });

  it("falls back to the thread viewport (tabIndex -1) when the opener is gone", () => {
    const opener = { isConnected: false } as HTMLElement;
    expect(makeFinalFocus({ current: opener })()).toBe(viewport);
    expect(viewport.tabIndex).toBe(-1);
    expect(makeFinalFocus(undefined)()).toBe(viewport);
  });

  it("never reaches for the composer; with no viewport it moves nothing", () => {
    vi.stubGlobal("document", { querySelector: () => null });
    expect(makeFinalFocus(undefined)()).toBe(false);
    expect(
      queries.every((selector) => !/composer|textarea|input/i.test(selector)),
    ).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Dismissal policy (spec 3.5, device checklist 2 and 14)
// -----------------------------------------------------------------------------

describe("dismissal policy", () => {
  it("Esc, X, swipe and Android Back close; a backdrop tap and anything else does not", () => {
    for (const reason of [
      "escape-key",
      "close-press",
      "swipe",
      "close-watcher",
    ]) {
      expect(closesOn(reason), reason).toBe(true);
    }
    for (const reason of ["outside-press", "focus-out", "none", ""]) {
      expect(closesOn(reason), reason).toBe(false);
    }
  });

  it("the Drawer disables pointer dismissal and routes its reasons through closesOn", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      "src/components/guide/guided-setup-sheet.tsx",
      "utf8",
    );
    expect(source).toContain("disablePointerDismissal");
    expect(source).toContain("closesOn(details.reason)");
  });
});
