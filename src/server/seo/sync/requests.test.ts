import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GscSiteLink } from "@prisma/client";

import { periodRequest, totalsRequest } from "@/lib/seo/catalog";
import { GoogleApiError } from "@/server/integrations/google/errors";
import type { GscPagedResult } from "@/server/integrations/search-console/search-analytics";

// Bu dosyanın kanıtladığı: bütçe ya da süre bitince Google'a gitmeden tur
// yumuşakça durur; kota bloğu varken istek ertelenir, ağır blok yalnız ağır
// isteği durdurur; "load" kota hatası aynı sitenin aynı kipteki birincil
// bağlarına yazılır ve ikincisinde ağır isteklere gece yarısına kadar kapanır;
// dakikalık sınır süre içinde açılıyorsa beklenir, açılmıyorsa tur biter;
// mock kipte sınır yoktur; site başına en çok 2 eşzamanlı istek.

const mocks = vi.hoisted(() => ({
  updateMany: vi.fn(),
  mockMode: vi.fn(() => false),
  fetched: vi.fn(),
  paged: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { gscSiteLink: { updateMany: mocks.updateMany } },
}));
vi.mock("@/server/integrations/search-console/search-analytics", () => ({
  gscMockMode: mocks.mockMode,
  querySearchAnalyticsPaged: mocks.paged,
}));

const { GscQuotaDeferred, GscRunBudgetSpent, runGscQuery } =
  await import("./requests");
type Context = Parameters<typeof runGscQuery>[0];

const RESULT: GscPagedResult = {
  rows: [],
  pages: 1,
  truncated: false,
  firstIncompleteDate: null,
  responseAggregationType: "byProperty",
};

let siteCounter = 0;

function ctx(overrides: Partial<Context> = {}): Context {
  siteCounter += 1;
  return {
    link: {
      id: "link-1",
      siteUrl: `sc-domain:site${siteCounter}.example.com`,
      isMock: false,
    } as GscSiteLink,
    accessToken: "token",
    now: new Date(),
    today: "2026-10-06",
    lane: "P2",
    deadline: Date.now() + 90_000,
    quota: {
      rateLimitedUntil: null,
      loadLimitedUntil: null,
      heavyLimitedUntil: null,
      loadErrors: null,
    },
    requestsLeft: 45,
    brand: null,
    searchTypes: {
      empty: new Set(),
      disabledSlices: new Set(),
      appearancePerDay: false,
    },
    ...overrides,
  };
}

const light = totalsRequest("web", "2026-09-26", "2026-10-05", "final");
const heavy = periodRequest("query_page", "2026-09-21", "2026-09-27");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mockMode.mockReturnValue(false);
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.paged.mockImplementation(
    async (
      _token: string,
      _site: string,
      _request: unknown,
      options: { beforePage?: (index: number) => Promise<void> | void },
    ) => {
      await options.beforePage?.(0);
      mocks.fetched();
      return RESULT;
    },
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe("runGscQuery budget", () => {
  it("ends the run before calling Google when the request budget is spent", async () => {
    await expect(
      runGscQuery(ctx({ requestsLeft: 0 }), light, { maxPages: 1 }),
    ).rejects.toBeInstanceOf(GscRunBudgetSpent);
    expect(mocks.fetched).not.toHaveBeenCalled();
  });

  it("ends the run when the deadline has passed", async () => {
    await expect(
      runGscQuery(ctx({ deadline: Date.now() - 1 }), light, { maxPages: 1 }),
    ).rejects.toBeInstanceOf(GscRunBudgetSpent);
    expect(mocks.fetched).not.toHaveBeenCalled();
  });

  it("counts every page request", async () => {
    const context = ctx();
    await runGscQuery(context, light, { maxPages: 1 });
    expect(context.requestsLeft).toBe(44);
    expect(mocks.fetched).toHaveBeenCalledTimes(1);
  });
});

describe("runGscQuery quota decision", () => {
  it("defers while the site is rate limited", async () => {
    const until = new Date(Date.now() + 60_000);
    const error = await runGscQuery(
      ctx({
        quota: {
          rateLimitedUntil: until,
          loadLimitedUntil: null,
          heavyLimitedUntil: null,
          loadErrors: null,
        },
      }),
      light,
      { maxPages: 1 },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GscQuotaDeferred);
    expect(error).toMatchObject({ reason: "RATE", retryAt: until });
    expect(mocks.fetched).not.toHaveBeenCalled();
  });

  it("defers only heavy requests while heavy is blocked", async () => {
    const quota = {
      rateLimitedUntil: null,
      loadLimitedUntil: null,
      heavyLimitedUntil: new Date(Date.now() + 3_600_000),
      loadErrors: null,
    };
    await expect(
      runGscQuery(ctx({ quota }), heavy, { maxPages: 1 }),
    ).rejects.toMatchObject({ reason: "HEAVY" });
    await expect(
      runGscQuery(ctx({ quota }), light, { maxPages: 1 }),
    ).resolves.toBe(RESULT);
    await expect(
      runGscQuery(
        ctx({
          quota: { ...quota, heavyLimitedUntil: new Date(Date.now() - 1) },
        }),
        heavy,
        { maxPages: 1 },
      ),
    ).resolves.toBe(RESULT);
  });
});

describe("runGscQuery quota errors", () => {
  it("stores a load error on the site's primary links of the same mode and escalates on the second", async () => {
    const load = new GoogleApiError(
      "Search Analytics load quota exceeded",
      "RESOURCE_EXHAUSTED",
      { httpStatus: 429 },
    );
    mocks.paged.mockRejectedValue(load);
    const context = ctx();
    await expect(runGscQuery(context, light, { maxPages: 1 })).rejects.toBe(
      load,
    );
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { siteUrl: context.link.siteUrl, isPrimary: true, isMock: false },
      data: expect.objectContaining({
        loadLimitedUntil: expect.any(Date),
        heavyLimitedUntil: null,
        loadErrors: expect.objectContaining({ count: 1 }),
      }),
    });
    expect(context.quota.loadLimitedUntil).toBeInstanceOf(Date);

    // İkinci hata: blok sürerken karar Google'a gitmeden ertelerdi; süre
    // geçmiş sayılır.
    context.quota = { ...context.quota, loadLimitedUntil: null };
    await expect(runGscQuery(context, light, { maxPages: 1 })).rejects.toBe(
      load,
    );
    expect(context.quota.heavyLimitedUntil).toBeInstanceOf(Date);
    expect(context.quota.loadErrors?.count).toBe(2);
    expect(mocks.updateMany).toHaveBeenLastCalledWith({
      where: { siteUrl: context.link.siteUrl, isPrimary: true, isMock: false },
      data: expect.objectContaining({ heavyLimitedUntil: expect.any(Date) }),
    });
  });

  it("does not touch the quota for other Google errors", async () => {
    const denied = new GoogleApiError("Forbidden", "PERMISSION_DENIED", {
      httpStatus: 403,
    });
    mocks.paged.mockRejectedValue(denied);
    await expect(runGscQuery(ctx(), light, { maxPages: 1 })).rejects.toBe(
      denied,
    );
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });
});

describe("runGscQuery minute limiter", () => {
  it("waits for a free slot when it opens before the deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-06T15:00:00Z"));
    const context = ctx({ requestsLeft: 100, deadline: Date.now() + 90_000 });
    for (let index = 0; index < 30; index += 1) {
      await runGscQuery(context, light, { maxPages: 1 });
    }
    let done = false;
    const pending = runGscQuery(context, light, { maxPages: 1 }).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;
    expect(done).toBe(true);
    expect(mocks.fetched).toHaveBeenCalledTimes(31);
  });

  it("ends the run softly when the slot opens after the deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-06T15:00:00Z"));
    const context = ctx({ requestsLeft: 100, deadline: Date.now() + 30_000 });
    for (let index = 0; index < 30; index += 1) {
      await runGscQuery(context, light, { maxPages: 1 });
    }
    await expect(
      runGscQuery(context, light, { maxPages: 1 }),
    ).rejects.toBeInstanceOf(GscRunBudgetSpent);
    expect(mocks.fetched).toHaveBeenCalledTimes(30);
  });

  it("is bypassed in mock mode", async () => {
    mocks.mockMode.mockReturnValue(true);
    const context = ctx({ requestsLeft: 100 });
    for (let index = 0; index < 40; index += 1) {
      await runGscQuery(context, light, { maxPages: 1 });
    }
    expect(mocks.fetched).toHaveBeenCalledTimes(40);
  });
});

describe("runGscQuery concurrency", () => {
  it("allows two requests per site at a time", async () => {
    const releases: (() => void)[] = [];
    mocks.paged.mockImplementation(
      () =>
        new Promise<GscPagedResult>((resolve) => {
          releases.push(() => resolve(RESULT));
        }),
    );
    const context = ctx();
    const first = runGscQuery(context, light, { maxPages: 1 });
    const second = runGscQuery(context, light, { maxPages: 1 });
    await expect(
      runGscQuery(context, light, { maxPages: 1 }),
    ).rejects.toMatchObject({ reason: "CONCURRENCY" });
    for (const release of releases) release();
    await expect(Promise.all([first, second])).resolves.toEqual([
      RESULT,
      RESULT,
    ]);
    mocks.paged.mockResolvedValue(RESULT);
    await expect(runGscQuery(context, light, { maxPages: 1 })).resolves.toBe(
      RESULT,
    );
  });
});
