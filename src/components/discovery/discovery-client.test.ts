import { afterEach, describe, expect, it, vi } from "vitest";

import type { DiscoveryView } from "@/lib/guided-discovery/contract";
import {
  DISCOVERY_POLL,
  discoveryApi,
  nextPollDelay,
  requestView,
  type FetchLike,
} from "./discovery-client";

const VIEW: DiscoveryView = {
  rev: "abcdef012345",
  status: "RUNNING",
  stages: {
    site: "running",
    identity: "pending",
    research: "pending",
    profile: "pending",
  },
  identity: null,
  rows: [],
  host: "example.com",
  failure: null,
  canRetry: false,
  brandName: "Example",
};

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
  requestView(
    (async () => {
      if (res instanceof Error) throw res;
      return res;
    }) as FetchLike,
    "/x",
    undefined,
    1000,
  );

afterEach(() => vi.useRealTimers());

describe("requestView mapping", () => {
  it("returns the view on an OK answer", async () => {
    expect(await run(json({ view: VIEW }))).toEqual({ ok: true, view: VIEW });
  });
  it("returns a null view when the project has no row", async () => {
    expect(await run(json({ view: null }))).toEqual({ ok: true, view: null });
  });
  it("maps a redirected answer to SESSION", async () => {
    expect(
      await run(json({ view: VIEW }, 200, { redirected: true })),
    ).toMatchObject({ ok: false, code: "SESSION" });
  });
  it("maps an OK non-JSON answer to SESSION", async () => {
    expect(await run(html(200))).toMatchObject({ ok: false, code: "SESSION" });
  });
  it("maps 401 and an unfollowed 307 to SESSION", async () => {
    expect(await run(json({}, 401))).toMatchObject({ code: "SESSION" });
    expect(await run(html(307))).toMatchObject({ code: "SESSION" });
  });
  it("maps 404 (flag off, route gone) to DISABLED", async () => {
    expect(await run(json({}, 404))).toMatchObject({
      ok: false,
      code: "DISABLED",
    });
  });
  it("maps a 502 HTML page and a 500 to HTTP, never SESSION", async () => {
    expect(await run(html(502))).toEqual({
      ok: false,
      code: "HTTP",
      status: 502,
    });
    expect(await run(json({ error: "x" }, 500))).toMatchObject({
      code: "HTTP",
    });
    expect(await run(json({}, 429))).toMatchObject({ code: "HTTP" });
  });
  it("refuses an OK answer that is not a view", async () => {
    expect(await run(json({ ok: true }))).toMatchObject({
      ok: false,
      code: "HTTP",
    });
    expect(await run(json({ view: { rev: 1 } }))).toMatchObject({
      code: "HTTP",
    });
    expect(
      await run(json({ view: { ...VIEW, status: "WEIRD" } })),
    ).toMatchObject({ code: "HTTP" });
  });
  it("maps a thrown fetch to NETWORK", async () => {
    expect(await run(new TypeError("Failed to fetch"))).toEqual({
      ok: false,
      code: "NETWORK",
    });
  });
  it("maps an aborted request to TIMEOUT after the deadline", async () => {
    vi.useFakeTimers();
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    const pending = requestView(hang, "/x", undefined, 15_000);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toEqual({ ok: false, code: "TIMEOUT" });
  });
});

describe("discoveryApi", () => {
  it("GETs with same-origin credentials and no-store", async () => {
    const fetchImpl = vi.fn(async () => json({ view: VIEW }));
    const result = await discoveryApi("p 1", fetchImpl).get();
    expect(result).toEqual({ ok: true, view: VIEW });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/api/projects/p%201/guided-discovery");
    expect(init).toMatchObject({
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
  it("POSTs ids-only bodies", async () => {
    const fetchImpl = vi.fn(async () => json({ view: VIEW }));
    const api = discoveryApi("p1", fetchImpl);
    await api.add("c_0123456789");
    await api.confirm();
    await api.retry();
    const bodies = fetchImpl.mock.calls.map((call) =>
      JSON.parse(String((call as unknown as [string, RequestInit])[1].body)),
    );
    expect(bodies).toEqual([
      { action: "add", candidateId: "c_0123456789" },
      { action: "confirm" },
      { action: "retry" },
    ]);
    const init = (
      fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    )[1];
    expect(init).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
    });
  });
});

describe("nextPollDelay", () => {
  it("polls every 2 s while everything works", () => {
    expect(nextPollDelay(0, false, 0)).toBe(2_000);
    expect(nextPollDelay(0, false, 299_999)).toBe(2_000);
  });
  it("stops after 5 minutes", () => {
    expect(nextPollDelay(0, false, DISCOVERY_POLL.maxMs)).toBeNull();
  });
  it("stops while the tab is hidden", () => {
    expect(nextPollDelay(0, true, 0)).toBeNull();
  });
  it("backs off to 10 s after a failure and stops after 3", () => {
    expect(nextPollDelay(1, false, 0)).toBe(10_000);
    expect(nextPollDelay(2, false, 0)).toBe(10_000);
    expect(nextPollDelay(3, false, 0)).toBeNull();
  });
});
