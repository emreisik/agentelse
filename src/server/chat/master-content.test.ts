import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BrandRuleSet } from "@/lib/works/brand-rules";
import type { MasterContentCardData } from "@/lib/works/master-content";

vi.mock("server-only", () => ({}));

const creativeFindMany = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    creative: { findMany: (...args: unknown[]) => creativeFindMany(...args) },
  },
}));

const getBrandTwin = vi.fn();
vi.mock("@/server/brand-twin/brand-twin", () => ({
  getBrandTwin: (...args: unknown[]) => getBrandTwin(...args),
}));

const isMockMode = vi.fn();
const run = vi.fn();
vi.mock("@/server/reasoning/reasoning-service", () => ({
  ReasoningService: {
    isMockMode: () => isMockMode(),
    run: (...args: unknown[]) => run(...args),
  },
}));

import { AgentelseError } from "@/server/security/errors";
import { runMasterAdapt } from "./master-content";

const scope = { workspaceId: "w1", projectId: "p1", brandId: "b1" };

function card(
  overrides: Partial<MasterContentCardData> = {},
): MasterContentCardData {
  return {
    kind: "master-content",
    title: "Autumn menu",
    state: "draft",
    master: {
      title: "Autumn menu",
      message: "The autumn menu starts on Friday with three new dishes.",
      goal: "awareness",
    },
    targets: [
      { channel: "instagram", formatKey: "instagram.post", included: true },
      { channel: "x", formatKey: "x.post", included: true },
      { channel: "ads", formatKey: "ads.campaign", included: false },
    ],
    ...overrides,
  };
}

const rules: BrandRuleSet = {
  language: "tr",
  never: [
    { text: "Never mention competitors by name", origin: "client-rule" },
    { text: "garanti", origin: "forbidden-claim" },
  ],
  approvedClaims: ["Family owned since 1999"],
  competitors: [],
};

function answer(
  rows: {
    channel: string;
    formatKey: string;
    topic: string;
    captionIdea: string;
  }[],
) {
  return { output: { adaptations: rows }, isMock: false, reasoningCallId: "r" };
}

const igRow = {
  channel: "instagram",
  formatKey: "instagram.post",
  topic: "Autumn is on the plate",
  captionIdea: "Three new dishes, one Friday.",
};
const xRow = {
  channel: "x",
  formatKey: "x.post",
  topic: "New menu Friday",
  captionIdea: "Autumn menu lands Friday.",
};

function call(extra: Partial<Parameters<typeof runMasterAdapt>[0]> = {}) {
  return runMasterAdapt({
    scope,
    card: card(),
    commandId: "cmd1",
    language: "en",
    rules,
    ...extra,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  isMockMode.mockReturnValue(false);
  getBrandTwin.mockResolvedValue({
    voice: { personality: "Warm", toneOfVoice: "Friendly" },
    positioning: "Neighbourhood bistro",
    currentFocus: { title: "Fill weekday dinners" },
  });
  creativeFindMany.mockResolvedValue([]);
});

describe("runMasterAdapt", () => {
  it("answers MOCK in mock mode and calls nothing", async () => {
    isMockMode.mockReturnValue(true);
    const result = await call();
    expect(result).toMatchObject({ ok: false, code: "MOCK" });
    expect(run).not.toHaveBeenCalled();
    expect(creativeFindMany).not.toHaveBeenCalled();
  });

  it("adapts the asked targets only and sets state adapted", async () => {
    run.mockResolvedValueOnce(answer([igRow, xRow]));
    const result = await call({
      targets: [{ channel: "instagram", formatKey: "instagram.post" }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.card.state).toBe("adapted");
    expect(result.card.targets[0]?.adaptation).toEqual({
      topic: igRow.topic,
      captionIdea: igRow.captionIdea,
    });
    // x was not asked for: the model's row for it is ignored.
    expect(result.card.targets[1]?.adaptation).toBeUndefined();
    expect(result.card.targets[2]?.adaptation).toBeUndefined();
    const facts = run.mock.calls[0]?.[1].context.facts;
    expect(facts.targets).toHaveLength(1);
  });

  it("defaults to every ticked target and leaves unticked ads out", async () => {
    run.mockResolvedValueOnce(answer([igRow, xRow]));
    await call();
    const facts = run.mock.calls[0]?.[1].context.facts;
    expect(facts.targets.map((t: { channel: string }) => t.channel)).toEqual([
      "instagram",
      "x",
    ]);
    expect(facts.targets[1].limit).toBe(240);
  });

  it("cleans text and clamps captionIdea to the format limit", async () => {
    run.mockResolvedValueOnce(
      answer([
        {
          ...igRow,
          topic: "  #Autumn *menu*  ",
          captionIdea: `Hello #autumn ${"a".repeat(400)}`,
        },
        { ...xRow, captionIdea: "b".repeat(500) },
      ]),
    );
    const result = await call();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [ig, x] = result.card.targets;
    expect(ig?.adaptation?.topic).not.toMatch(/[#*]/);
    expect(ig?.adaptation?.topic).toContain("Autumn");
    expect(ig?.adaptation?.captionIdea.length).toBeLessThanOrEqual(200);
    expect(x?.adaptation?.captionIdea.length).toBeLessThanOrEqual(240);
    expect(x?.adaptation?.captionIdea.length).toBeGreaterThan(200);
  });

  it("drops rows the catalog does not know and rows nobody asked for", async () => {
    run.mockResolvedValueOnce(
      answer([
        igRow,
        // formatKey does not belong to the channel
        { ...xRow, formatKey: "instagram.reel" },
        // channel not on the card
        { ...xRow, channel: "tiktok", formatKey: "tiktok.video" },
        // a duplicate of an accepted row
        { ...igRow, topic: "Second take" },
      ]),
    );
    const result = await call();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.card.targets[0]?.adaptation?.topic).toBe(igRow.topic);
    expect(result.card.targets[1]?.adaptation).toBeUndefined();
  });

  it("answers FAILED when nothing usable came back", async () => {
    run.mockResolvedValueOnce(answer([{ ...xRow, formatKey: "nope" }]));
    const result = await call();
    expect(result).toMatchObject({ ok: false, code: "FAILED" });
  });

  it("answers NOTHING without a ticked, known target (no model call)", async () => {
    const result = await call({
      card: card({
        targets: [
          { channel: "x", formatKey: "x.post", included: false },
          { channel: "x", formatKey: "bogus", included: true },
        ],
      }),
    });
    expect(result).toMatchObject({ ok: false, code: "NOTHING" });
    expect(run).not.toHaveBeenCalled();
  });

  it("hands the rules to the model verbatim, including a Never rule", async () => {
    run.mockResolvedValueOnce(answer([igRow, xRow]));
    await call();
    const facts = run.mock.calls[0]?.[1].context.facts;
    expect(facts.neverRules).toEqual([
      "Never mention competitors by name",
      "garanti",
    ]);
    expect(facts.approvedClaims).toEqual(["Family owned since 1999"]);
    expect(facts.language).toBe("en");
    expect(facts.voice.personality).toBe("Warm");
    expect(facts.positioning).toBe("Neighbourhood bistro");
    expect(facts.currentFocus).toBe("Fill weekday dinners");
    expect(facts.master.message).toContain("three new dishes");
  });

  it("sends at most ten calendar topics and skips this card's own posts", async () => {
    creativeFindMany.mockResolvedValue([
      { title: "Own post", planId: "cmd1" },
      ...Array.from({ length: 14 }, (_, i) => ({
        title: `Topic ${i}`,
        planId: "other",
      })),
    ]);
    run.mockResolvedValueOnce(answer([igRow, xRow]));
    await call();
    const facts = run.mock.calls[0]?.[1].context.facts;
    expect(facts.calendarTopics).toHaveLength(10);
    expect(facts.calendarTopics).not.toContain("Own post");
    const where = creativeFindMany.mock.calls[0]?.[0].where;
    expect(where.projectId).toBe("p1");
    expect(where.channel).toEqual({ in: ["instagram", "x"] });
  });

  it("works without rules, a twin or a calendar (fail open)", async () => {
    getBrandTwin.mockRejectedValue(new Error("cold"));
    creativeFindMany.mockRejectedValue(new Error("cold"));
    run.mockResolvedValueOnce(answer([igRow, xRow]));
    const result = await call({ rules: null });
    expect(result.ok).toBe(true);
    const facts = run.mock.calls[0]?.[1].context.facts;
    expect(facts.neverRules).toEqual([]);
    expect(facts.calendarTopics).toEqual([]);
  });

  it("repairs ONCE with the aggregated hit list and keeps the clean result", async () => {
    run
      .mockResolvedValueOnce(
        answer([{ ...igRow, captionIdea: "Kesin garanti lezzet" }, xRow]),
      )
      .mockResolvedValueOnce(answer([igRow, xRow]));
    const result = await call();
    expect(run).toHaveBeenCalledTimes(2);
    const repair = run.mock.calls[1]?.[1].context.repair as string;
    expect(repair).toContain("garanti");
    expect(repair).toContain("instagram.post");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.card.targets[0]?.adaptation?.captionIdea).toBe(
      igRow.captionIdea,
    );
    expect(result.card.targets[0]?.adaptation?.issues).toBeUndefined();
  });

  it("keeps what results after the repair and marks the offending row", async () => {
    const bad = { ...igRow, captionIdea: "Kesin garanti lezzet" };
    run
      .mockResolvedValueOnce(answer([bad, xRow]))
      .mockResolvedValueOnce(answer([bad, xRow]));
    const result = await call();
    // One repair, never a loop.
    expect(run).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [ig, x] = result.card.targets;
    expect(ig?.adaptation?.issues?.[0]).toContain("garanti");
    expect(x?.adaptation?.issues).toBeUndefined();
  });

  it("keeps the first answer with issues when the repair call fails", async () => {
    const bad = { ...igRow, captionIdea: "Kesin garanti lezzet" };
    run
      .mockResolvedValueOnce(answer([bad, xRow]))
      .mockRejectedValueOnce(new Error("boom"));
    const result = await call();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.card.targets[0]?.adaptation?.issues).toBeDefined();
  });

  it("does not repair on a warn-only hit but still marks the row", async () => {
    run.mockResolvedValueOnce(
      answer([{ ...igRow, captionIdea: "The best dishes in town" }, xRow]),
    );
    const result = await call();
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.card.targets[0]?.adaptation?.issues?.[0]).toContain(
      "absolute claim",
    );
  });

  it("maps a budget error to BUDGET and any other failure to FAILED", async () => {
    run.mockRejectedValueOnce(
      new AgentelseError("BUDGET_EXCEEDED", "cap", {
        meta: { limit: "dailyBudgetUsd" },
      }),
    );
    expect(await call()).toMatchObject({ ok: false, code: "BUDGET" });
    run.mockRejectedValueOnce(new Error("provider down"));
    expect(await call()).toMatchObject({ ok: false, code: "FAILED" });
  });

  it("never mutates the stored card and leaves other state untouched", async () => {
    const stored = card({ adaptRuns: 1, adapting: { startedAt: "t" } });
    const snapshot = JSON.stringify(stored);
    run.mockResolvedValueOnce(answer([igRow, xRow]));
    const result = await call({ card: stored });
    expect(JSON.stringify(stored)).toBe(snapshot);
    expect(result.ok && result.card.master).toEqual(stored.master);
  });
});
