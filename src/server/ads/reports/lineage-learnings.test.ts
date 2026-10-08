import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  launches: vi.fn(),
  groupBy: vi.fn(),
  brand: vi.fn(),
  findLearning: vi.fn(),
  createLearning: vi.fn(),
  updateLearning: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    adsLaunch: { findMany: db.launches },
    adsInsightDaily: { groupBy: db.groupBy },
    brand: { findFirst: db.brand },
    brandLearning: {
      findFirst: db.findLearning,
      create: db.createLearning,
      update: db.updateLearning,
    },
  },
}));

import { AdsLineageLearnings } from "./lineage-learnings";

const NOW = new Date("2026-10-08T10:00:00Z");

function spec(adTags: Record<string, string>[]) {
  return {
    version: 1,
    adAccountId: "act_1",
    currency: "EUR",
    timezone: "UTC",
    pageId: "p",
    objective: "OUTCOME_LEADS",
    recipe: "leads_instant_form",
    specialAdCategories: [],
    campaignName: "C",
    budget: { mode: "DAILY", dailyMinor: 1000, durationDays: 7 },
    adSets: [
      {
        name: "S",
        optimizationGoal: "LEAD_GENERATION",
        billingEvent: "IMPRESSIONS",
        targeting: { countries: ["TR"] },
        advantageAudience: 1,
      },
    ],
    ads: adTags.map((tags, index) => ({
      name: `Ad ${index}`,
      adSetIndex: 0,
      creative: {
        imageAssetId: "a",
        message: "m",
        link: "https://x.test",
        callToAction: "LEARN_MORE",
      },
      urlTags: "",
      lineage: { creativeIds: [], ideaIds: [], tags },
    })),
    guards: { campaignSpendCapMinor: null },
    creativeFeatures: { send: true, multiAdvertiser: "OPT_OUT" },
    activate: true,
  };
}

function setup() {
  db.launches.mockResolvedValue([
    {
      projectId: "proj",
      adsAccountId: "acc",
      spec: spec([
        { hook: "question" },
        { hook: "question" },
        { hook: "statement" },
        { hook: "statement" },
      ]),
      progress: { ads: { 0: "ad0", 1: "ad1", 2: "ad2", 3: "ad3" } },
    },
  ]);
  const sum = (externalId: string, spendMinor: number, results: number) => ({
    externalId,
    _sum: { spendMinor: BigInt(spendMinor), results },
  });
  db.groupBy.mockResolvedValue([
    sum("ad0", 10_000, 40),
    sum("ad1", 10_000, 38),
    sum("ad2", 10_000, 20),
    sum("ad3", 10_000, 22),
  ]);
  db.brand.mockResolvedValue({ id: "brand", workspaceId: "ws" });
  db.findLearning.mockResolvedValue(null);
  db.createLearning.mockResolvedValue({});
  db.updateLearning.mockResolvedValue({});
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AdsLineageLearnings.writeDue", () => {
  it("writes a learning for a hook that clearly works and one to avoid", async () => {
    setup();
    const written = await AdsLineageLearnings.writeDue(NOW);
    expect(written).toBe(2);
    const created = db.createLearning.mock.calls.map(
      (call) => (call[0] as { data: Record<string, unknown> }).data,
    );
    const works = created.find((d) => d.polarity === "WORKS")!;
    expect(works).toMatchObject({
      projectId: "proj",
      brandId: "brand",
      sourceType: "META_ADS_LINEAGE",
      sourceRef: "lineage:leads_instant_form:hook:question",
    });
    expect(String(works.insight)).toContain("Ads that open with a question");
    expect(created.some((d) => d.polarity === "AVOID")).toBe(true);
  });

  it("updates the same learning instead of adding a second one", async () => {
    setup();
    db.findLearning.mockResolvedValue({
      id: "l1",
      polarity: "WORKS",
      evidenceCount: 2,
    });
    await AdsLineageLearnings.writeDue(NOW);
    expect(db.createLearning).not.toHaveBeenCalled();
    const update = db.updateLearning.mock.calls.find(
      (call) =>
        (call[0] as { data: { polarity: string } }).data.polarity === "WORKS",
    )![0] as { data: { evidenceCount: number } };
    expect(update.data.evidenceCount).toBe(3);
  });

  it("writes nothing when no launched ad carries a lineage", async () => {
    db.launches.mockResolvedValue([]);
    expect(await AdsLineageLearnings.writeDue(NOW)).toBe(0);
    expect(db.groupBy).not.toHaveBeenCalled();
  });

  it("writes nothing when the evidence is not enough", async () => {
    setup();
    db.groupBy.mockResolvedValue([
      { externalId: "ad0", _sum: { spendMinor: BigInt(10_000), results: 4 } },
      { externalId: "ad1", _sum: { spendMinor: BigInt(10_000), results: 3 } },
      { externalId: "ad2", _sum: { spendMinor: BigInt(10_000), results: 1 } },
      { externalId: "ad3", _sum: { spendMinor: BigInt(10_000), results: 1 } },
    ]);
    expect(await AdsLineageLearnings.writeDue(NOW)).toBe(0);
    expect(db.createLearning).not.toHaveBeenCalled();
  });
});
