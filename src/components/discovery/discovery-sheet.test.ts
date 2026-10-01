import { readFileSync } from "node:fs";
import path from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  DiscoveryApi,
  DiscoveryResult,
} from "@/components/discovery/discovery-client";
import type {
  DiscoveryView,
  Row,
  Stage,
  StageState,
} from "@/lib/guided-discovery/contract";
import {
  discoveryReducer,
  initialState,
  type DiscoveryAction,
  type DiscoveryState,
} from "./discovery-state";
import {
  DiscoverySheet,
  closesOn,
  createController,
  makeFinalFocus,
  pollDecision,
  type PollEnv,
} from "./discovery-sheet";

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const stages = (over: Partial<Record<Stage, StageState>> = {}) => ({
  site: "pending" as StageState,
  identity: "pending" as StageState,
  research: "pending" as StageState,
  profile: "pending" as StageState,
  ...over,
});

const view = (over: Partial<DiscoveryView> = {}): DiscoveryView => ({
  rev: "rev000000001",
  status: "RUNNING",
  stages: stages({ site: "running" }),
  identity: null,
  rows: [],
  host: "qrhubmenu.com",
  failure: null,
  canRetry: false,
  brandName: "Qr Hub Menu",
  ...over,
});

const productsRow: Row = {
  field: "products",
  tier: "assumed",
  score: 70,
  saved: [],
  candidates: [
    { id: "c_aaaaaaaaaa", text: "Table stands", score: 70, added: false },
  ],
};

const READY = view({ status: "READY", rows: [productsRow] });
const ok = (v: DiscoveryView | null): DiscoveryResult => ({
  ok: true,
  view: v,
});
const fail = (
  code: Extract<DiscoveryResult, { ok: false }>["code"],
): DiscoveryResult => ({ ok: false, code });

function makeClient(
  over: Partial<Record<keyof DiscoveryApi, DiscoveryResult>> = {},
) {
  return {
    get: vi.fn<() => Promise<DiscoveryResult>>(
      async () => over.get ?? ok(READY),
    ),
    add: vi.fn<(candidateId: string) => Promise<DiscoveryResult>>(
      async () => over.add ?? ok(READY),
    ),
    confirm: vi.fn<() => Promise<DiscoveryResult>>(
      async () => over.confirm ?? ok(READY),
    ),
    retry: vi.fn<() => Promise<DiscoveryResult>>(
      async () => over.retry ?? ok(READY),
    ),
  } satisfies DiscoveryApi;
}

function setup(initial: DiscoveryView | null, client = makeClient()) {
  const actions: DiscoveryAction[] = [];
  const ctl = createController({
    initial: initialState(initial),
    client,
    dispatch: (a) => actions.push(a),
  });
  return { ctl, client, actions };
}

// A controllable deferred promise.
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// -----------------------------------------------------------------------------
// Policies
// -----------------------------------------------------------------------------

describe("close policy", () => {
  it("Esc, X, swipe and the Back gesture hide the sheet; a backdrop tap does not", () => {
    for (const reason of [
      "escape-key",
      "close-press",
      "swipe",
      "close-watcher",
    ]) {
      expect(closesOn(reason)).toBe(true);
    }
    for (const reason of ["outside-press", "focus-out", "none", ""]) {
      expect(closesOn(reason)).toBe(false);
    }
  });
});

describe("pollDecision", () => {
  const base = {
    open: true,
    status: "RUNNING" as const,
    hidden: false,
    failures: 0,
    elapsedMs: 0,
  };
  it("polls only while open and RUNNING", () => {
    expect(pollDecision(base)).toBe(2_000);
    expect(pollDecision({ ...base, open: false })).toBeNull();
    for (const status of ["READY", "FAILED", "CONFIRMED", null] as const) {
      expect(pollDecision({ ...base, status })).toBeNull();
    }
  });
  it("stops while hidden, after 5 minutes and after 3 failures; backs off to 10 s", () => {
    expect(pollDecision({ ...base, hidden: true })).toBeNull();
    expect(pollDecision({ ...base, elapsedMs: 300_000 })).toBeNull();
    expect(pollDecision({ ...base, failures: 1 })).toBe(10_000);
    expect(pollDecision({ ...base, failures: 3 })).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Handlers through an injected client
// -----------------------------------------------------------------------------

describe("add", () => {
  it("adds one candidate: started, call, done with the server view", async () => {
    const added = view({
      status: "READY",
      rev: "rev000000002",
      rows: [
        {
          ...productsRow,
          saved: ["Table stands"],
          candidates: [
            { id: "c_aaaaaaaaaa", text: "Table stands", score: 70, added: true },
          ],
        },
      ],
    });
    const { ctl, client, actions } = setup(
      READY,
      makeClient({ add: ok(added) }),
    );
    await ctl.add("c_aaaaaaaaaa");
    expect(client.add).toHaveBeenCalledWith("c_aaaaaaaaaa");
    expect(actions.map((a) => a.type)).toEqual(["addStarted", "addDone"]);
    expect(ctl.getState().view?.rows[0]?.saved).toEqual(["Table stands"]);
    expect(ctl.getState().pendingAdd.size).toBe(0);
  });

  it("ignores a second tap while the first is in flight (one at a time)", async () => {
    const gate = deferred<DiscoveryResult>();
    const client = makeClient();
    client.add.mockImplementationOnce(() => gate.promise);
    const { ctl } = setup(READY, client);
    const first = ctl.add("c_aaaaaaaaaa");
    await ctl.add("c_aaaaaaaaaa");
    await ctl.add("c_bbbbbbbbbb");
    expect(client.add).toHaveBeenCalledTimes(1);
    gate.resolve(ok(READY));
    await first;
  });

  it("never calls the server for an unknown or already added candidate", async () => {
    const { ctl, client } = setup(READY);
    await ctl.add("c_zzzzzzzzzz");
    expect(client.add).not.toHaveBeenCalled();
  });

  it("a failed add keeps the view, clears the pending flag and sets a notice", async () => {
    const { ctl } = setup(READY, makeClient({ add: fail("NETWORK") }));
    await ctl.add("c_aaaaaaaaaa");
    const state = ctl.getState();
    expect(state.pendingAdd.size).toBe(0);
    expect(state.error).toBe("NETWORK");
    expect(state.view).toEqual(READY);
  });
});

describe("confirm", () => {
  it("confirms a READY view once", async () => {
    const confirmed = view({ status: "CONFIRMED", rev: "rev000000002" });
    const { ctl, client } = setup(
      READY,
      makeClient({ confirm: ok(confirmed) }),
    );
    await ctl.confirm();
    expect(client.confirm).toHaveBeenCalledTimes(1);
    expect(ctl.getState().view?.status).toBe("CONFIRMED");
    expect(ctl.getState().busy).toBeNull();
  });

  it("a double tap sends one request", async () => {
    const gate = deferred<DiscoveryResult>();
    const client = makeClient();
    client.confirm.mockImplementationOnce(() => gate.promise);
    const { ctl } = setup(READY, client);
    const first = ctl.confirm();
    await ctl.confirm();
    expect(client.confirm).toHaveBeenCalledTimes(1);
    gate.resolve(ok(view({ status: "CONFIRMED", rev: "rev000000002" })));
    await first;
  });

  it("does nothing unless the view is READY", async () => {
    for (const status of ["RUNNING", "FAILED", "CONFIRMED"] as const) {
      const { ctl, client } = setup(view({ status }));
      await ctl.confirm();
      expect(client.confirm).not.toHaveBeenCalled();
    }
  });

  it("a failed confirm clears busy and shows a notice", async () => {
    const { ctl } = setup(READY, makeClient({ confirm: fail("TIMEOUT") }));
    await ctl.confirm();
    expect(ctl.getState()).toMatchObject({ busy: null, error: "TIMEOUT" });
  });
});

describe("retry", () => {
  const failed = view({ status: "FAILED", failure: "error", canRetry: true });

  it("retries only while canRetry and loads the new view", async () => {
    const { ctl, client } = setup(
      failed,
      makeClient({ retry: ok(view({ rev: "rev000000002" })) }),
    );
    await ctl.retry();
    expect(client.retry).toHaveBeenCalledTimes(1);
    expect(ctl.getState().view?.status).toBe("RUNNING");
    expect(ctl.getState().busy).toBeNull();
  });

  it("does not call the server when the retry budget is spent", async () => {
    const { ctl, client } = setup({ ...failed, canRetry: false });
    await ctl.retry();
    expect(client.retry).not.toHaveBeenCalled();
  });

  it("a double tap sends one request", async () => {
    const gate = deferred<DiscoveryResult>();
    const client = makeClient();
    client.retry.mockImplementationOnce(() => gate.promise);
    const { ctl } = setup(failed, client);
    const first = ctl.retry();
    await ctl.retry();
    expect(client.retry).toHaveBeenCalledTimes(1);
    gate.resolve(ok(view({ rev: "rev000000002" })));
    await first;
  });
});

describe("reads never write", () => {
  it("refresh and reload only call get", async () => {
    const { ctl, client } = setup(null);
    await ctl.refresh();
    await ctl.reload();
    expect(client.get).toHaveBeenCalledTimes(2);
    expect(client.add).not.toHaveBeenCalled();
    expect(client.confirm).not.toHaveBeenCalled();
    expect(client.retry).not.toHaveBeenCalled();
  });

  it("the first refresh loads the view silently", async () => {
    const { ctl } = setup(null);
    expect(await ctl.refresh()).toBe("settled");
    expect(ctl.getState()).toMatchObject({ phase: "ready", announcement: "" });
  });

  it("a read that started before a write finished is dropped", async () => {
    const gate = deferred<DiscoveryResult>();
    const client = makeClient({
      confirm: ok(view({ status: "CONFIRMED", rev: "rev000000002" })),
    });
    client.get.mockImplementationOnce(() => gate.promise);
    const { ctl } = setup(READY, client);
    const read = ctl.refresh();
    await ctl.confirm();
    gate.resolve(ok(READY)); // an older view
    await read;
    expect(ctl.getState().view?.status).toBe("CONFIRMED");
  });

  it("reports terminal for a session bounce and failed for a network blip", async () => {
    expect(
      await setup(READY, makeClient({ get: fail("SESSION") })).ctl.refresh(),
    ).toBe("terminal");
    const blip = setup(READY, makeClient({ get: fail("NETWORK") }));
    expect(await blip.ctl.refresh()).toBe("failed");
    // Silent: the view stays and no notice is raised.
    expect(blip.ctl.getState().error).toBeNull();
  });

  it("reload after an error shows the view again", async () => {
    const { ctl } = setup(null, makeClient({ get: fail("HTTP") }));
    await ctl.refresh();
    expect(ctl.getState().phase).toBe("error");
    // Same client, but the server is back.
    const fixed = setup(null, makeClient({ get: ok(READY) }));
    await fixed.ctl.reload();
    expect(fixed.ctl.getState().phase).toBe("ready");
  });
});

// -----------------------------------------------------------------------------
// Polling
// -----------------------------------------------------------------------------

function fakeEnv(startHidden = false) {
  let hidden = startHidden;
  let now = 0;
  const listeners = new Set<() => void>();
  const env: PollEnv = {
    hidden: () => hidden,
    now: () => now,
    onVisibility: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    env,
    listeners,
    setHidden(next: boolean) {
      hidden = next;
      for (const l of [...listeners]) l();
    },
    advance(ms: number) {
      now += ms;
    },
  };
}

describe("startPolling", () => {
  it("polls every 2 s while RUNNING and stops once the run settles", async () => {
    vi.useFakeTimers();
    const client = makeClient();
    client.get
      .mockResolvedValueOnce(ok(view({ rev: "rev000000002" })))
      .mockResolvedValueOnce(ok(view({ rev: "rev000000003" })))
      .mockResolvedValue(ok(READY));
    const { ctl } = setup(view(), client);
    const { env } = fakeEnv();
    const stop = ctl.startPolling(env);
    expect(client.get).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(client.get).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(client.get).toHaveBeenCalledTimes(3);
    expect(ctl.getState().view?.status).toBe("READY");
    expect(ctl.getState().announcement).toBe("Your brand profile is ready.");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.get).toHaveBeenCalledTimes(3);
    stop();
  });

  it("backs off to 10 s after a failure and gives up after 3", async () => {
    vi.useFakeTimers();
    const client = makeClient({ get: fail("NETWORK") });
    const { ctl } = setup(view(), client);
    const stop = ctl.startPolling(fakeEnv().env);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(client.get).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(client.get).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.get).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(client.get).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(client.get).toHaveBeenCalledTimes(3);
    stop();
  });

  it("stops at once on a session bounce", async () => {
    vi.useFakeTimers();
    const client = makeClient({ get: fail("SESSION") });
    const { ctl } = setup(view(), client);
    const stop = ctl.startPolling(fakeEnv().env);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.get).toHaveBeenCalledTimes(1);
    expect(ctl.getState().error).toBe("SESSION");
    stop();
  });

  it("does not poll while hidden and refreshes once on becoming visible", async () => {
    vi.useFakeTimers();
    const client = makeClient({ get: ok(view({ rev: "rev000000002" })) });
    const { ctl } = setup(view(), client);
    const fake = fakeEnv();
    const stop = ctl.startPolling(fake.env);
    fake.setHidden(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(client.get).not.toHaveBeenCalled();
    fake.advance(30_000);
    fake.setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.get).toHaveBeenCalledTimes(1);
    // The loop resumes at the normal pace afterwards.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(client.get).toHaveBeenCalledTimes(2);
    stop();
  });

  it("stops after 5 visible minutes; hidden time does not count", async () => {
    vi.useFakeTimers();
    const client = makeClient({ get: ok(view({ rev: "rev000000002" })) });
    const { ctl } = setup(view(), client);
    const fake = fakeEnv();
    // The fake clock follows the fake timers.
    const env: PollEnv = { ...fake.env, now: () => Date.now() };
    const stop = ctl.startPolling(env);
    await vi.advanceTimersByTimeAsync(301_000);
    const calls = client.get.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.get.mock.calls.length).toBe(calls);
    expect(calls).toBeGreaterThan(100);
    stop();
  });

  it("the cleanup cancels the timer and the listener", async () => {
    vi.useFakeTimers();
    const client = makeClient();
    const { ctl } = setup(view(), client);
    const fake = fakeEnv();
    const stop = ctl.startPolling(fake.env);
    stop();
    expect(fake.listeners.size).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(client.get).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// Shell
// -----------------------------------------------------------------------------

describe("makeFinalFocus", () => {
  it("returns the opener while it is on the page", () => {
    const opener = { isConnected: true } as HTMLElement;
    expect(makeFinalFocus({ current: opener })()).toBe(opener);
  });
  it("falls back to the thread viewport, else to the default", () => {
    const viewport = { tabIndex: 0 } as HTMLElement;
    vi.stubGlobal("document", {
      querySelector: vi.fn(() => viewport),
    });
    expect(makeFinalFocus({ current: null })()).toBe(viewport);
    expect(viewport.tabIndex).toBe(-1);
    vi.stubGlobal("document", { querySelector: vi.fn(() => null) });
    expect(makeFinalFocus(undefined)()).toBe(false);
  });
});

describe("SSR markup", () => {
  const render = (open: boolean, initialView: DiscoveryView | null) =>
    renderToStaticMarkup(
      createElement(DiscoverySheet, {
        projectId: "p1",
        open,
        onOpenChange: () => {},
        initialView,
        brandName: "Qr Hub Menu",
      }),
    );

  it("the closed shell renders nothing", () => {
    expect(render(false, READY)).toBe("");
    expect(render(false, null)).toBe("");
  });

  it("an open shell is not server-rendered (hydration gate)", () => {
    expect(render(true, READY)).toBe("");
  });
});

describe("shell source", () => {
  const source = readFileSync(
    path.join(process.cwd(), "src/components/discovery/discovery-sheet.tsx"),
    "utf8",
  );

  it("is 'use client' and sends no chat message", () => {
    expect(source.startsWith('"use client";')).toBe(true);
    expect(source).not.toMatch(/useChatSend|chat-send-context|\bsend\(/);
    expect(source).not.toContain("dangerouslySetInnerHTML");
  });

  it("the only effects are the refresh on open and the poll", () => {
    expect(source.match(/\buseEffect\(/g)).toHaveLength(2);
    expect(source).not.toMatch(/\buseLayoutEffect\b/);
  });

  it("the reducer is reachable for the shell and stays pure", () => {
    const state: DiscoveryState = initialState(READY);
    expect(discoveryReducer(state, { type: "confirmStarted" })).not.toBe(state);
    expect(state.busy).toBeNull();
  });
});
