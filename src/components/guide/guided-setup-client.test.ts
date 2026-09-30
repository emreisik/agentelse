import { describe, expect, it, vi } from "vitest";
import { POLL } from "@/lib/guided-setup/contract";
import { api, nextPollDelay, requestJson, type FetchLike } from "./guided-setup-client";

const json = (body: unknown, status = 200, extra: Partial<Response> = {}) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    redirected: false,
    json: async () => body,
    ...extra,
  }) as Response;
const html = (status: number, extra: Partial<Response> = {}) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    redirected: false,
    json: async () => {
      throw new SyntaxError("Unexpected token <");
    },
    ...extra,
  }) as Response;
const run = (res: Response | Error) =>
  requestJson<{ a: number }>(
    (async () => {
      if (res instanceof Error) throw res;
      return res;
    }) as FetchLike,
    "/x",
    undefined,
    1000,
  );

describe("requestJson mapping (G38, G68)", () => {
  it("returns data on OK JSON", async () => {
    expect(await run(json({ a: 1 }))).toEqual({ ok: true, data: { a: 1 } });
  });
  it("maps a redirected answer to SESSION", async () => {
    // JSON body on purpose: only the redirect flag can produce SESSION here.
    expect(await run(json({ a: 1 }, 200, { redirected: true }))).toMatchObject({ ok: false, kind: "SESSION" });
  });
  it("maps an OK non-JSON answer to SESSION", async () => {
    expect(await run(html(200))).toMatchObject({ ok: false, kind: "SESSION" });
  });
  it("maps an unfollowed 307 to SESSION", async () => {
    expect(await run(html(307))).toMatchObject({ ok: false, kind: "SESSION" });
  });
  it("maps a 502 HTML page to HTTP with its status, never SESSION", async () => {
    expect(await run(html(502))).toEqual({ ok: false, kind: "HTTP", status: 502 });
  });
  it.each([
    [401, "SESSION"],
    [404, "NOT_FOUND"],
    [429, "RATE"],
    [409, "BUSY"],
    [400, "INVALID"],
    [413, "INVALID"],
    [404, "DISABLED"],
    [500, "FAILED"],
  ])("maps %i with code %s", async (status, code) => {
    expect(await run(json({ error: "x", code }, status))).toEqual({ ok: false, kind: code, status });
  });
  it("maps a JSON error without a known code to HTTP", async () => {
    expect(await run(json({ error: "x" }, 503))).toEqual({ ok: false, kind: "HTTP", status: 503 });
  });
  it("maps a thrown fetch to NETWORK", async () => {
    expect(await run(new TypeError("Failed to fetch"))).toEqual({ ok: false, kind: "NETWORK" });
  });
  it("maps an abort by the timeout to TIMEOUT", async () => {
    vi.useFakeTimers();
    const fetchImpl: FetchLike = (_u, init) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
      });
    const p = requestJson(fetchImpl, "/x", undefined, 500);
    await vi.advanceTimersByTimeAsync(600);
    expect(await p).toEqual({ ok: false, kind: "TIMEOUT" });
    vi.useRealTimers();
  });
});

describe("api", () => {
  it("draftPlan is a plain POST of the draft_plan action", async () => {
    const fetchImpl = vi.fn(async () => json({ ok: true, message: "m" }));
    const res = await api("p1", fetchImpl).draftPlan();
    expect(res).toEqual({ ok: true, data: { ok: true, message: "m" } });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/projects/p1/guided-setup");
    expect(init.method).toBe("POST");
    // The route answers 415 to anything but JSON: the two halves must agree.
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(init.cache).toBe("no-store");
    expect(JSON.parse(init.body as string)).toEqual({ action: "draft_plan" });
  });
  it("start, discover and poll use the right verbs and bodies", async () => {
    const fetchImpl = vi.fn(async () => json({}));
    const c = api("p1", fetchImpl);
    await c.start("cmd1");
    await c.discover();
    await c.poll();
    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    const [c0, c1, c2] = calls as [
      [string, RequestInit],
      [string, RequestInit],
      [string, RequestInit],
    ];
    expect(JSON.parse(c0[1].body as string)).toEqual({ action: "start", seedCommandId: "cmd1" });
    expect(JSON.parse(c1[1].body as string)).toEqual({ action: "discover" });
    expect(c2[1].method).toBe("GET");
    expect(c2[1].cache).toBe("no-store");
    expect(c0[1].headers).toEqual({ "Content-Type": "application/json" });
    expect(c1[1].headers).toEqual({ "Content-Type": "application/json" });
  });
});

describe("nextPollDelay (G38, G68)", () => {
  const base = { elapsedMs: 0, status: "RUNNING" as const, hidden: false, failures: 0 };
  it("polls every interval while RUNNING and visible", () => {
    expect(nextPollDelay(base)).toBe(POLL.intervalMs);
  });
  it("stops on terminal states", () => {
    for (const status of ["READY", "FAILED", "IDLE", "UNAVAILABLE"] as const) {
      expect(nextPollDelay({ ...base, status })).toBeNull();
    }
  });
  it("stops while hidden", () => {
    expect(nextPollDelay({ ...base, hidden: true })).toBeNull();
  });
  it("stops after the 5 minute cap", () => {
    expect(nextPollDelay({ ...base, elapsedMs: POLL.maxMs - 1 })).toBe(POLL.intervalMs);
    expect(nextPollDelay({ ...base, elapsedMs: POLL.maxMs })).toBeNull();
  });
  it("doubles on repeated failures, capped, and gives up after three", () => {
    expect(nextPollDelay({ ...base, failures: 1 })).toBe(4000);
    expect(nextPollDelay({ ...base, failures: 2 })).toBe(8000);
    expect(nextPollDelay({ ...base, failures: 3 })).toBeNull();
  });
  it("never exceeds maxDelayMs", () => {
    expect(POLL.intervalMs * 2 ** 3).toBeGreaterThan(POLL.maxDelayMs);
    expect(nextPollDelay({ ...base, failures: 2 })).toBeLessThanOrEqual(POLL.maxDelayMs);
  });
});
