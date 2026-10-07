import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: sonuç API'si ve optimizer kanıt okuyucusu bayrak
// kapalıyken sorgusuz null döner; okuyucu oluşturulurken sorgu yapmaz, proje
// ve kampanya başına bir kez okur, düz ga4_* ilkelleri döndürür ve paylaşılan
// reklam hesabında başka projenin sayısını vermez.

const mocks = vi.hoisted(() => ({
  primaryGaLink: vi.fn(),
  gaDataThrough: vi.fn(),
  attributeWindow: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: new Proxy(
    {},
    {
      get() {
        throw new Error("prisma must not be touched");
      },
    },
  ),
}));
vi.mock("@/server/website-analytics/store", () => ({
  primaryGaLink: mocks.primaryGaLink,
  gaDataThrough: mocks.gaDataThrough,
}));
vi.mock("@/server/website-analytics/attribution/data", () => ({
  attributeWindow: mocks.attributeWindow,
}));

import {
  createGaCampaignEvidenceReader,
  GA_DECISION_EVIDENCE_PREFIX,
  getGaOutcomesForCampaign,
} from "./outcomes";

const RANGE = { from: "2026-09-22", to: "2026-09-28" };
const NOW = new Date("2026-09-30T08:00:00Z");

function attribution(
  campaigns: Record<string, { sessions: number; keyEvents: number }>,
  options: { coveredDays?: number; links?: unknown[]; legacy?: unknown[] } = {},
) {
  const byCampaign: Record<string, unknown> = {};
  const groups: unknown[] = [];
  for (const [id, figures] of Object.entries(campaigns)) {
    const metrics = {
      sessions: figures.sessions,
      engagedSessions: Math.round(figures.sessions * 0.6),
      keyEvents: figures.keyEvents,
      revenue: 12.5,
    };
    byCampaign[id] = metrics;
    groups.push({
      key: `meta:${id}`,
      campaignExternalId: id,
      adExternalIds: ["ad1", "ad2"],
      metrics,
    });
  }
  return {
    result: { groups, byCampaign },
    window: {
      rows: [],
      days: 7,
      coveredDays: options.coveredDays ?? 7,
      truncated: false,
    },
    links: options.links ?? [],
    legacy: options.legacy ?? [],
  };
}

function link(id: string, isMock = false) {
  return { id, isMock, currencyCode: "EUR" };
}

describe("createGaCampaignEvidenceReader", () => {
  beforeEach(() => {
    vi.stubEnv("GA_UTM", "true");
    vi.stubEnv("GA_SYNC", "true");
    for (const fn of Object.values(mocks)) fn.mockReset();
    mocks.primaryGaLink.mockImplementation(async (projectId: string) =>
      link(`link-${projectId}`),
    );
    mocks.gaDataThrough.mockResolvedValue({
      through: "2026-09-28",
      finalThrough: "2026-09-21",
    });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("runs no query when it is created", () => {
    createGaCampaignEvidenceReader({ now: NOW });
    expect(mocks.primaryGaLink).not.toHaveBeenCalled();
    expect(mocks.attributeWindow).not.toHaveBeenCalled();
  });

  it("returns null for a null campaign id without a query", async () => {
    const read = createGaCampaignEvidenceReader({ now: NOW });
    expect(await read("p1", null)).toBeNull();
    expect(mocks.primaryGaLink).not.toHaveBeenCalled();
  });

  it("returns null without a query when the flag is off", async () => {
    vi.stubEnv("GA_UTM", "false");
    const read = createGaCampaignEvidenceReader({ now: NOW });
    expect(await read("p1", "cmp1")).toBeNull();
    expect(mocks.primaryGaLink).not.toHaveBeenCalled();
  });

  it("returns flat ga4_* primitives and memoizes the result", async () => {
    mocks.attributeWindow.mockResolvedValue(
      attribution({ cmp1: { sessions: 120.4, keyEvents: 3.14159 } }),
    );
    const read = createGaCampaignEvidenceReader({ now: NOW });
    const first = await read("p1", "cmp1");
    expect(first).toEqual({
      ga4_source: "GA4",
      ga4_from: "2026-09-22",
      ga4_to: "2026-09-28",
      ga4_sessions: 120,
      ga4_engaged_sessions: 72,
      ga4_key_events: 3.14,
      ga4_covered_days: 7,
    });
    for (const [key, value] of Object.entries(first ?? {})) {
      expect(key.startsWith(GA_DECISION_EVIDENCE_PREFIX)).toBe(true);
      expect(key).not.toMatch(/offsite/i);
      expect(["string", "number"]).toContain(typeof value);
    }
    expect(mocks.attributeWindow).toHaveBeenCalledWith({
      projectId: "p1",
      linkId: "link-p1",
      range: RANGE,
    });

    await read("p1", "cmp1");
    expect(mocks.attributeWindow).toHaveBeenCalledTimes(1);
    expect(mocks.primaryGaLink).toHaveBeenCalledTimes(1);
  });

  it("reads the project once for several campaigns", async () => {
    mocks.attributeWindow.mockResolvedValue(
      attribution({
        cmp1: { sessions: 10, keyEvents: 1 },
        cmp2: { sessions: 20, keyEvents: 2 },
      }),
    );
    const read = createGaCampaignEvidenceReader({ now: NOW });
    const [one, two] = await Promise.all([
      read("p1", "cmp1"),
      read("p1", "cmp2"),
    ]);
    expect(one?.ga4_sessions).toBe(10);
    expect(two?.ga4_sessions).toBe(20);
    expect(mocks.attributeWindow).toHaveBeenCalledTimes(1);
  });

  it("returns null for fewer than 5 covered days", async () => {
    mocks.attributeWindow.mockResolvedValue(
      attribution({ cmp1: { sessions: 10, keyEvents: 1 } }, { coveredDays: 4 }),
    );
    const read = createGaCampaignEvidenceReader({ now: NOW });
    expect(await read("p1", "cmp1")).toBeNull();
  });

  it("returns null for a mock link, an unmapped campaign and no data", async () => {
    mocks.primaryGaLink.mockImplementation(async (projectId: string) =>
      projectId === "mock" ? link("link-mock", true) : link(`link-${projectId}`),
    );
    mocks.attributeWindow.mockResolvedValue(
      attribution({ cmp1: { sessions: 10, keyEvents: 1 } }),
    );
    const read = createGaCampaignEvidenceReader({ now: NOW });
    expect(await read("mock", "cmp1")).toBeNull();
    expect(await read("p1", "unknown")).toBeNull();

    mocks.gaDataThrough.mockResolvedValue({ through: null, finalThrough: null });
    expect(await createGaCampaignEvidenceReader({ now: NOW })("p2", "cmp1")).toBeNull();
  });

  it("never mixes the numbers of two projects on a shared ad account", async () => {
    mocks.attributeWindow.mockImplementation(
      async (input: { projectId: string }) =>
        input.projectId === "a"
          ? attribution({ cmpA: { sessions: 500, keyEvents: 20 } })
          : attribution({ cmpB: { sessions: 40, keyEvents: 2 } }),
    );
    const read = createGaCampaignEvidenceReader({ now: NOW });
    expect(await read("b", "cmpA")).toBeNull();
    expect((await read("a", "cmpA"))?.ga4_sessions).toBe(500);
    expect((await read("b", "cmpB"))?.ga4_sessions).toBe(40);
  });

  it("returns null instead of throwing", async () => {
    mocks.attributeWindow.mockRejectedValue(new Error("boom"));
    const read = createGaCampaignEvidenceReader({ now: NOW });
    expect(await read("p1", "cmp1")).toBeNull();
  });
});

describe("getGaOutcomesForCampaign", () => {
  beforeEach(() => {
    vi.stubEnv("GA_UTM", "true");
    vi.stubEnv("GA_SYNC", "true");
    for (const fn of Object.values(mocks)) fn.mockReset();
    mocks.primaryGaLink.mockResolvedValue(link("link-1"));
  });
  afterEach(() => vi.unstubAllEnvs());

  it("returns null without a query when the flag is off", async () => {
    vi.stubEnv("GA_UTM", "");
    expect(await getGaOutcomesForCampaign("p1", "cmp1", RANGE)).toBeNull();
    expect(mocks.primaryGaLink).not.toHaveBeenCalled();
  });

  it("returns the campaign's numbers and counts links plus a legacy match", async () => {
    mocks.attributeWindow.mockResolvedValue(
      attribution(
        { cmp1: { sessions: 300, keyEvents: 18 } },
        {
          links: [
            { campaignExternalId: "cmp1" },
            { campaignExternalId: "cmp1" },
            { campaignExternalId: "other" },
          ],
          legacy: [{ adExternalId: "ad1", campaignExternalId: "cmp1" }],
        },
      ),
    );
    expect(await getGaOutcomesForCampaign("p1", "cmp1", RANGE)).toEqual({
      source: "GA4",
      campaignExternalId: "cmp1",
      range: RANGE,
      currency: "EUR",
      sessions: 300,
      engagedSessions: 180,
      keyEvents: 18,
      revenue: 12.5,
      trackedLinks: 3,
      days: 7,
      coveredDays: 7,
    });
  });

  it("returns zeros for a mapped campaign without sessions", async () => {
    mocks.attributeWindow.mockResolvedValue(
      attribution({ cmp1: { sessions: 0, keyEvents: 0 } }),
    );
    const result = await getGaOutcomesForCampaign("p1", "cmp1", RANGE);
    expect(result?.sessions).toBe(0);
    expect(result?.keyEvents).toBe(0);
  });

  it("returns null for an unknown campaign, a mock link and errors", async () => {
    mocks.attributeWindow.mockResolvedValue(
      attribution({ cmp1: { sessions: 5, keyEvents: 1 } }),
    );
    expect(await getGaOutcomesForCampaign("p1", "nope", RANGE)).toBeNull();

    mocks.primaryGaLink.mockResolvedValue(link("link-1", true));
    expect(await getGaOutcomesForCampaign("p1", "cmp1", RANGE)).toBeNull();

    mocks.primaryGaLink.mockResolvedValue(null);
    expect(await getGaOutcomesForCampaign("p1", "cmp1", RANGE)).toBeNull();

    mocks.primaryGaLink.mockRejectedValue(new Error("db down"));
    expect(await getGaOutcomesForCampaign("p1", "cmp1", RANGE)).toBeNull();
  });
});
