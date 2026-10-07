import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı (SC-F8 AI trafiği köprüsü): bayrak kapalıyken
// (SEO_GEO ya da GA_SYNC) hiçbir okuma yok; toplama YALNIZ paylaşılan
// assistantTotals ile yapılır; iki pencere (son 28 gün ve önceki 28 gün) bağın
// son günüyle biter; alan adı eşleşmesi (bilinmeyen serbest, uyumsuz null);
// sağlıksız bağ null; hiçbir şey yazılmaz.

const mocks = vi.hoisted(() => ({
  primaryGaLink: vi.fn(),
  readState: vi.fn(),
  loadTables: vi.fn(),
  totals: vi.fn(),
}));

vi.mock("@/server/website-analytics/store", () => ({
  primaryGaLink: mocks.primaryGaLink,
}));
vi.mock("@/server/seo/site/sites", () => ({
  SeoSites: { readState: mocks.readState },
}));
vi.mock("@/server/website-analytics/analysis/windows", () => ({
  loadGaWindowTables: mocks.loadTables,
}));
vi.mock("@/lib/website-analytics/analysis/ai-referrals", () => ({
  assistantTotals: mocks.totals,
}));

import { readAiTraffic } from "./ai-traffic";

const SCOPE = {
  kind: "VERIFIED_DOMAIN" as const,
  root: "shop.com",
  prefix: null,
  key: "VERIFIED_DOMAIN:shop.com:",
};

function link(overrides: Record<string, unknown> = {}) {
  return {
    id: "link-1",
    health: "OK",
    lastDailyDate: "2026-10-05",
    streamUri: "https://www.shop.com",
    ...overrides,
  };
}

const CURRENT = { totals: { sessions: 1000 }, tag: "current" };
const PREVIOUS = { totals: { sessions: 900 }, tag: "previous" };

beforeEach(() => {
  vi.stubEnv("SEO_HEALTH", "true");
  vi.stubEnv("SEO_CRAWL", "true");
  vi.stubEnv("SEO_GEO", "true");
  vi.stubEnv("GA_SYNC", "true");
  vi.stubEnv("SEO_DEV_PROJECTS", "");
  vi.stubEnv("SEO_ROLLOUT_PROJECTS", "");
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.primaryGaLink.mockResolvedValue(link());
  mocks.readState.mockResolvedValue({ scope: SCOPE });
  mocks.loadTables.mockImplementation(async (_id: string, range: { from: string }) =>
    range.from === "2026-09-08" ? CURRENT : PREVIOUS,
  );
  mocks.totals.mockImplementation((tables: { tag: string }) =>
    tables.tag === "current"
      ? new Map([
          ["ChatGPT", { sessions: 30, keyEvents: 3 }],
          ["Perplexity", { sessions: 10, keyEvents: 1 }],
        ])
      : new Map([
          ["ChatGPT", { sessions: 12, keyEvents: 0 }],
          ["Claude", { sessions: 4, keyEvents: 0 }],
        ]),
  );
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("readAiTraffic", () => {
  it.each([
    ["SEO_GEO", "false"],
    ["GA_SYNC", "false"],
    ["SEO_CRAWL", "false"],
  ])("returns null without any read when %s is off", async (name, value) => {
    vi.stubEnv(name, value);
    expect(await readAiTraffic("p1")).toBeNull();
    expect(mocks.primaryGaLink).not.toHaveBeenCalled();
    expect(mocks.readState).not.toHaveBeenCalled();
    expect(mocks.loadTables).not.toHaveBeenCalled();
  });

  it("aggregates through assistantTotals for the current and previous 28 days", async () => {
    const view = await readAiTraffic("p1");
    expect(mocks.loadTables).toHaveBeenCalledTimes(2);
    const calls = mocks.loadTables.mock.calls.map((call) => ({
      linkId: call[0],
      range: call[1],
      options: call[2],
    }));
    expect(calls.map((call) => call.range)).toEqual([
      { from: "2026-09-08", to: "2026-10-05" },
      { from: "2026-08-11", to: "2026-09-07" },
    ]);
    for (const call of calls) {
      expect(call.linkId).toBe("link-1");
      expect([...call.options.reports]).toEqual(["sourceMedium"]);
      expect(call.options.exclude.size).toBe(0);
    }
    expect(mocks.totals).toHaveBeenCalledTimes(2);
    expect(view).toEqual({
      from: "2026-09-08",
      to: "2026-10-05",
      sessions: 40,
      previousSessions: 16,
      keyEvents: 4,
      sharePct: 4,
      assistants: [
        { name: "ChatGPT", sessions: 30, previousSessions: 12 },
        { name: "Perplexity", sessions: 10, previousSessions: 0 },
        { name: "Claude", sessions: 0, previousSessions: 4 },
      ],
      domainMatch: "match",
    });
  });

  it("allows an unknown stream host and a www twin, rejects another site", async () => {
    mocks.primaryGaLink.mockResolvedValue(link({ streamUri: null }));
    expect((await readAiTraffic("p1"))?.domainMatch).toBe("unknown");
    mocks.primaryGaLink.mockResolvedValue(link({ streamUri: "https://shop.com" }));
    expect((await readAiTraffic("p1"))?.domainMatch).toBe("match");
    mocks.primaryGaLink.mockResolvedValue(link({ streamUri: "https://other-site.com" }));
    expect(await readAiTraffic("p1")).toBeNull();
    expect(mocks.loadTables).toHaveBeenCalledTimes(4);
  });

  it("returns null without a link, a last day, a scope or a healthy link", async () => {
    mocks.primaryGaLink.mockResolvedValue(null);
    expect(await readAiTraffic("p1")).toBeNull();
    mocks.primaryGaLink.mockResolvedValue(link({ lastDailyDate: null }));
    expect(await readAiTraffic("p1")).toBeNull();
    mocks.primaryGaLink.mockResolvedValue(link({ health: "ACCESS_LOST" }));
    expect(await readAiTraffic("p1")).toBeNull();
    mocks.primaryGaLink.mockResolvedValue(link());
    mocks.readState.mockResolvedValue({ scope: null });
    expect(await readAiTraffic("p1")).toBeNull();
    mocks.readState.mockResolvedValue(null);
    expect(await readAiTraffic("p1")).toBeNull();
    expect(mocks.loadTables).not.toHaveBeenCalled();
  });

  it("has no share when the site had no sessions and keeps zero visits", async () => {
    mocks.loadTables.mockResolvedValue({ totals: { sessions: 0 }, tag: "current" });
    mocks.totals.mockReturnValue(new Map());
    const view = await readAiTraffic("p1");
    expect(view).toMatchObject({ sessions: 0, previousSessions: 0, sharePct: null, assistants: [] });
  });

  it("caps the assistants list at eight", async () => {
    mocks.totals.mockImplementation(
      () => new Map(Array.from({ length: 12 }, (_, index) => [`A${index}`, { sessions: 12 - index, keyEvents: 0 }])),
    );
    expect((await readAiTraffic("p1"))?.assistants).toHaveLength(8);
  });

  it("returns null and logs only the error name when a read fails", async () => {
    mocks.loadTables.mockRejectedValue(new RangeError("secret detail"));
    expect(await readAiTraffic("p1")).toBeNull();
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("secret");
  });
});

describe("nothing is persisted", () => {
  it("never imports the database client or the key-value stores", () => {
    const source = readFileSync(new URL("./ai-traffic.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/@\/lib\/prisma/);
    expect(source).not.toMatch(/\.(create|update|upsert|delete)(Many)?\(/);
    expect(source).not.toMatch(/localStorage|sessionStorage|writeFile/);
  });
});
