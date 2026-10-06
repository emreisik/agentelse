import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SEO_RULE_KEYS,
  type SeoFindingDraft,
} from "@/lib/seo/opportunity-types";

import { makeDraft } from "./helpers";
import {
  evaluateSeoRules,
  LOW_DATA_IMPRESSIONS,
  MAX_FINDINGS_PER_RUN,
  SEO_RULES,
} from "./index";
import { SO1 } from "./striking-distance";
import { SO7 } from "./lost";
import { RULE_SCENARIOS, snapshotFixture } from "./test-support";

afterEach(() => {
  vi.restoreAllMocks();
});

function fakeDraft(
  ruleKey: SeoFindingDraft["ruleKey"],
  subject: string,
  perMonth: number,
): SeoFindingDraft {
  const snapshot = snapshotFixture();
  return makeDraft(snapshot, {
    ruleKey,
    kind: "OPPORTUNITY",
    subject,
    severity: "INFO",
    confidence: "SIGNIFICANT",
    effort: "S",
    actionKind: "TITLE_META",
    impact: { kind: "clicks", perMonth, low: perMonth, high: perMonth },
    title: "t",
    summary: "s",
    evidence: { window: snapshot.current, metrics: {} },
  });
}

describe("SEO rule registry", () => {
  it("registers every rule once, in key order, at version 1", () => {
    expect(SEO_RULES.map((r) => r.key)).toEqual([...SEO_RULE_KEYS]);
    expect(SEO_RULES.every((r) => r.version === 1)).toBe(true);
    const nonQuery = SEO_RULES.filter((r) => !r.querySignal).map((r) => r.key);
    expect(nonQuery).toEqual([
      "SO8_INTERNAL_LINKS",
      "SO12_RICH_RESULTS",
      "SO16_TECH_IMPACT",
    ]);
  });
});

describe("evaluateSeoRules", () => {
  it("skips query rules in low-data mode but still runs SO8, SO12 and SO16", () => {
    const snapshot = {
      ...RULE_SCENARIOS.SO12_RICH_RESULTS(),
      totals: {
        clicks: 10,
        impressions: LOW_DATA_IMPRESSIONS - 1,
        nonBrandClicks: null,
        nonBrandImpressions: null,
      },
    };
    const run = evaluateSeoRules(snapshot);
    expect(run.lowData).toBe(true);
    expect(run.evaluated).toEqual([
      "SO8_INTERNAL_LINKS",
      "SO12_RICH_RESULTS",
      "SO16_TECH_IMPACT",
    ]);
    expect(run.skipped.filter((s) => s.reason === "LOW_DATA")).toHaveLength(13);
    expect(run.fired).toEqual({ SO12_RICH_RESULTS: 1 });
    expect(run.seen).toEqual([
      { ruleKey: "SO12_RICH_RESULTS", subject: "site:schema:organization" },
    ]);
  });

  it("records coverage skips", () => {
    const run = evaluateSeoRules(
      snapshotFixture({ previousComplete: false, historyWeeks: 5 }),
    );
    expect(run.lowData).toBe(false);
    expect(run.skipped).toEqual(
      expect.arrayContaining([
        { ruleKey: "SO3_CONTENT_DECAY", reason: "LOW_HISTORY" },
        { ruleKey: "SO6_RISING_QUERY", reason: "LOW_HISTORY" },
        { ruleKey: "SO7_LOST", reason: "LOW_HISTORY" },
        { ruleKey: "SO8_INTERNAL_LINKS", reason: "NO_CRAWL" },
        { ruleKey: "SO10_BRAND_DEMAND", reason: "NO_BRAND_SPLIT" },
      ]),
    );
  });

  it("isolates a throwing rule", () => {
    vi.spyOn(SO1, "evaluate").mockImplementation(() => {
      throw new Error("boom");
    });
    const run = evaluateSeoRules(RULE_SCENARIOS.SO7_LOST());
    expect(run.skipped).toContainEqual({
      ruleKey: "SO1_STRIKING_DISTANCE",
      reason: "ERROR",
    });
    expect(run.evaluated).toContain("SO7_LOST");
    expect(run.fired.SO7_LOST).toBe(1);
  });

  it("filters rules with only", () => {
    const run = evaluateSeoRules(RULE_SCENARIOS.SO7_LOST(), {
      only: ["SO7_LOST"],
    });
    expect(run.evaluated).toEqual(["SO7_LOST"]);
    expect(run.skipped).toEqual([]);
  });

  it("caps at 25, counts the dropped drafts and keeps them in seen", () => {
    const drafts = Array.from({ length: 30 }, (_, i) =>
      fakeDraft(
        "SO1_STRIKING_DISTANCE",
        `page:p${String(i).padStart(2, "0")}`,
        100 - i,
      ),
    );
    vi.spyOn(SO1, "evaluate").mockReturnValue({
      evaluable: true,
      drafts,
      seen: drafts.map((d) => d.subject),
    });
    const run = evaluateSeoRules(snapshotFixture(), {
      only: ["SO1_STRIKING_DISTANCE"],
    });
    expect(run.drafts).toHaveLength(MAX_FINDINGS_PER_RUN);
    expect(run.dropped).toBe(5);
    expect(run.fired).toEqual({ SO1_STRIKING_DISTANCE: 25 });
    expect(run.seen).toHaveLength(30);
    expect(run.seen).toContainEqual({
      ruleKey: "SO1_STRIKING_DISTANCE",
      subject: "page:p29",
    });
    expect(run.drafts.map((d) => d.subject)).not.toContain("page:p29");
  });

  it("orders by priority, then rule order, then subject", () => {
    vi.spyOn(SO1, "evaluate").mockReturnValue({
      evaluable: true,
      drafts: [
        fakeDraft("SO1_STRIKING_DISTANCE", "page:b", 10),
        fakeDraft("SO1_STRIKING_DISTANCE", "page:a", 10),
      ],
      seen: ["page:a", "page:b"],
    });
    vi.spyOn(SO7, "evaluate").mockReturnValue({
      evaluable: true,
      drafts: [
        fakeDraft("SO7_LOST", "page:a", 10),
        fakeDraft("SO7_LOST", "page:z", 50),
      ],
      seen: ["page:a", "page:z", "page:capped"],
    });
    const run = evaluateSeoRules(snapshotFixture(), {
      only: ["SO1_STRIKING_DISTANCE", "SO7_LOST"],
    });
    expect(run.drafts.map((d) => `${d.ruleKey}|${d.subject}`)).toEqual([
      "SO7_LOST|page:z",
      "SO1_STRIKING_DISTANCE|page:a",
      "SO1_STRIKING_DISTANCE|page:b",
      "SO7_LOST|page:a",
    ]);
    expect(run.seen).toContainEqual({
      ruleKey: "SO7_LOST",
      subject: "page:capped",
    });
    // Aynı girdi aynı sonucu verir.
    expect(
      evaluateSeoRules(snapshotFixture(), {
        only: ["SO1_STRIKING_DISTANCE", "SO7_LOST"],
      }),
    ).toEqual(run);
  });

  it("evaluates every scenario with drafts that respect the run contract", () => {
    for (const key of SEO_RULE_KEYS) {
      const run = evaluateSeoRules(RULE_SCENARIOS[key](), { only: [key] });
      expect(run.evaluated).toEqual([key]);
      expect(run.fired[key]).toBeGreaterThan(0);
      const seen = new Set(run.seen.map((s) => s.subject));
      for (const draft of run.drafts)
        expect(seen.has(draft.subject)).toBe(true);
    }
  });
});
