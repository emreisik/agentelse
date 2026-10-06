import { describe, expect, it } from "vitest";

import { checkSummaryNumbers } from "@/lib/module-flows/analytics/number-check";

import {
  diagnosisFacts,
  narrativeAllowedNumbers,
  seoNarrativeFacts,
} from "./facts";
import { sampleSnapshot } from "./test-support";
import type {
  SearchDiagnosis,
  SeoReportKpi,
  SeoReportRow,
  SeoReportSection,
  SeoReportSnapshot,
} from "./types";

function row(label: string, clicks: number, previousClicks: number): SeoReportRow {
  return {
    label,
    url: null,
    isBrand: false,
    clicks,
    previousClicks,
    impressions: clicks * 10,
    previousImpressions: previousClicks * 10,
    position: 5.5,
    previousPosition: 5,
  };
}

function manyTables(): SeoReportSection[] {
  const keys = [
    "winning_queries",
    "losing_queries",
    "winning_pages",
    "losing_pages",
    "rising_queries",
  ] as const;
  const sections: SeoReportSection[] = [];
  keys.forEach((key, tableIndex) => {
    const page = key.endsWith("pages");
    sections.push({
      type: "table",
      table: {
        key,
        title: key,
        aggregation: page ? "By page" : "By property",
        rows: Array.from({ length: 5 }, (_, index) =>
          row(
            page ? `/page-${tableIndex}-${index}` : `query ${tableIndex} ${index}`,
            10 + index,
            5,
          ),
        ),
      },
    });
  });
  // Sınırı aşan ikinci küme: aynı anahtarlar, farklı dizgiler.
  for (const key of keys) {
    const page = key.endsWith("pages");
    sections.push({
      type: "table",
      table: {
        key,
        title: key,
        aggregation: page ? "By page" : "By property",
        rows: Array.from({ length: 3 }, (_, index) =>
          row(page ? `/extra-${key}-${index}` : `extra ${key} ${index}`, 3, 2),
        ),
      },
    });
  }
  return sections;
}

function tableStrings(snapshotFacts: ReturnType<typeof seoNarrativeFacts>): string[] {
  return snapshotFacts.facts.tables.flatMap((table) =>
    table.rows.map((entry) => entry.text),
  );
}

describe("seoNarrativeFacts", () => {
  it("keeps at most 20 distinct Google strings with 40 rows", () => {
    const snapshot = sampleSnapshot("WEEKLY", { sections: manyTables() });
    const result = seoNarrativeFacts(snapshot);
    const strings = new Set([
      ...tableStrings(result),
      ...result.facts.opportunities.map((item) => item.title),
    ]);
    expect(strings.size).toBeLessThanOrEqual(20);
    expect(result.googleStrings).toBeLessThanOrEqual(20);
    expect(result.googleStrings).toBe(20);
  });

  it("fills the budget with losing queries first", () => {
    const snapshot = sampleSnapshot("WEEKLY", { sections: manyTables() });
    const { facts } = seoNarrativeFacts(snapshot);
    const titles = facts.tables.map((table) => table.title);
    expect(titles).toContain("losing_queries");
    const losing = facts.tables
      .filter((table) => table.title === "losing_queries")
      .flatMap((table) => table.rows);
    expect(losing).toHaveLength(8);
    const rising = facts.tables.find((table) => table.title === "rising_queries");
    expect(rising).toBeUndefined();
  });

  it("masks emails in queries and drops query strings from paths", () => {
    const snapshot = sampleSnapshot("WEEKLY", {
      sections: [
        {
          type: "table",
          table: {
            key: "losing_queries",
            title: "Queries that lost clicks",
            aggregation: "By property",
            rows: [row("write to jane.doe@example.com today", 5, 20)],
          },
        },
        {
          type: "table",
          table: {
            key: "losing_pages",
            title: "Pages that lost clicks",
            aggregation: "By page",
            rows: [row("/account/jane@example.com?session=abc", 4, 18)],
          },
        },
      ],
    });
    const { facts } = seoNarrativeFacts(snapshot);
    const json = JSON.stringify(facts);
    expect(json).not.toContain("jane");
    expect(json).not.toContain("session=abc");
    expect(json).toContain("[email]");
  });

  it("reports changes in percent and the anonymous share in percent", () => {
    const { facts } = seoNarrativeFacts(sampleSnapshot("WEEKLY"));
    const nonBrand = facts.kpis.find((kpi) => kpi.metric === "Non-brand clicks");
    expect(nonBrand).toMatchObject({
      value: "840",
      previous: "1,200",
      changePct: -30,
      yearAgo: "700",
      yoyPct: 20,
    });
    expect(facts.anonymousSharePct).toBe(12);
    expect(facts.report).toBe("weekly");
    expect(facts.period).toBe("Sep 28 – Oct 4");
    expect(facts.health?.coveragePct).toEqual({ point: 91, low: 88, high: 94 });
  });

  it("uses the primary cause and at most three evidence sentences", () => {
    const { facts } = seoNarrativeFacts(sampleSnapshot("WEEKLY"));
    expect(facts.diagnosis).toEqual({
      cause: "lower positions",
      evidence: ["Average position worsened from 6.2 to 8.1."],
    });
  });

  it("takes goals, forecast and report type for monthly and roadmap", () => {
    const monthly = seoNarrativeFacts(sampleSnapshot("MONTHLY")).facts;
    expect(monthly.report).toBe("monthly");
    expect(monthly.goals[0]).toMatchObject({ pace: "At risk", target: 1200 });
    expect(monthly.forecast).toMatchObject({
      month: "October 2026",
      value: 3600,
      method: "trend",
    });
    expect(seoNarrativeFacts(sampleSnapshot("ROADMAP")).facts.report).toBe(
      "monthly",
    );
  });
});

describe("narrativeAllowedNumbers", () => {
  const kpis: SeoReportKpi[] = [
    {
      key: "nonBrandClicks",
      label: "Non-brand clicks",
      value: 1234,
      previous: 1407,
      yearAgo: null,
      format: "count",
      lowerIsBetter: false,
    },
  ];
  const snapshot: SeoReportSnapshot = sampleSnapshot("WEEKLY", {
    sections: [
      { type: "kpis", kpis, compareLabel: "Previous period", yearAgoLabel: null },
    ],
    notes: [],
  });

  it("matches an unsigned number to a negative change", () => {
    const { facts } = seoNarrativeFacts(snapshot);
    expect(facts.kpis[0]?.changePct).toBe(-12.3);
    const allowed = narrativeAllowedNumbers(facts);
    expect(allowed).toContain(-12.3);
    expect(allowed).toContain(12.3);
    const checked = checkSummaryNumbers(
      {
        headline: "Non-brand clicks fell 12.3% to 1,234.",
        highlights: ["Clicks rose 77% thanks to the new page."],
        watchouts: [],
        nextSteps: [],
      },
      allowed,
    );
    expect(checked?.headline).toBe("Non-brand clicks fell 12.3% to 1,234.");
    expect(checked?.highlights).toEqual([]);
  });

  it("has no duplicates", () => {
    const allowed = narrativeAllowedNumbers({ a: 3, b: -3, c: "3" });
    expect(allowed.filter((value) => value === 3)).toHaveLength(1);
    expect(allowed).toContain(-3);
  });
});

describe("diagnosisFacts", () => {
  function diagnosisWithItems(count: number): SearchDiagnosis {
    const base = (
      sampleSnapshot("WEEKLY").sections.find(
        (section) => section.type === "diagnosis",
      ) as Extract<SeoReportSection, { type: "diagnosis" }>
    ).diagnosis;
    return {
      ...base,
      steps: base.steps.map((step, stepIndex) => ({
        ...step,
        items: Array.from({ length: 5 }, (_, index) => ({
          label:
            count > 0 && stepIndex * 5 + index < count
              ? `query ${stepIndex} ${index} jo@example.com`
              : `/path-${stepIndex}-${index}`,
          detail: "Position 4.2 to 9.8",
        })),
      })),
    };
  }

  it("caps the Google strings at twenty and masks them", () => {
    const facts = diagnosisFacts(diagnosisWithItems(40)) as {
      steps: { items: { label: string }[] }[];
    };
    const labels = facts.steps.flatMap((step) =>
      step.items.map((item) => item.label),
    );
    expect(new Set(labels).size).toBeLessThanOrEqual(20);
    expect(labels.length).toBe(20);
    expect(JSON.stringify(facts)).not.toContain("jo@example.com");
  });

  it("counts the page paths in an item's detail against the twenty strings", () => {
    const base = diagnosisWithItems(0);
    const diagnosis: SearchDiagnosis = {
      ...base,
      steps: base.steps.map((step, stepIndex) => ({
        ...step,
        items: Array.from({ length: 8 }, (_, index) => ({
          label: `query ${stepIndex} ${index}`,
          detail: `/top-${stepIndex}-${index} → /taker-${stepIndex}-${index}`,
        })),
      })),
    };
    const facts = diagnosisFacts(diagnosis) as {
      steps: { items: { label: string; detail: string }[] }[];
    };
    const strings = new Set(
      facts.steps.flatMap((step) =>
        step.items.flatMap((item) => [item.label, ...item.detail.split(" → ")]),
      ),
    );
    expect(strings.size).toBeLessThanOrEqual(20);
    expect(strings.size).toBeGreaterThan(0);
  });

  it("writes the change in percent and names the causes", () => {
    const facts = diagnosisFacts(diagnosisWithItems(0));
    expect(facts.changePct).toBe(-30);
    expect(facts.cause).toBe("lower positions");
    expect(facts.also).toEqual(["fewer clicks at the same position"]);
    expect(facts.current).toBe(840);
    expect(facts.previous).toBe(1200);
    expect(facts.askUser).toHaveLength(2);
  });
});
