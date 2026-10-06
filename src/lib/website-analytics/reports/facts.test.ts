import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  allowedNumbersOf,
  checkSummaryNumbers,
} from "@/lib/module-flows/analytics/number-check";
import { formatMetric } from "@/lib/module-flows/analytics/format";
import type { GaFindingView } from "@/lib/website-analytics/analysis/view-types";

import { REPORT_LLM_MAX_STRINGS, reportFactsOf } from "./facts";
import {
  sampleAlertCard,
  sampleMonthlyCard,
  samplePlanCard,
  samplePulseCard,
  sampleWeeklyCard,
  SAMPLE_SENSITIVE,
} from "./test-fixtures";
import type {
  ReportFindingSnap,
  ReportKpi,
  ReportMover,
  WebsiteReportCardData,
} from "./types";

// findingFacts bu dosyada denetlenir: gerçek davranış varsayılan, tek bir
// testte "3 metin taşıyan bulgu" için değiştirilir.
const factsMock = vi.hoisted(() => ({
  override: null as null | ((id: string) => Record<string, unknown>),
}));

vi.mock("@/lib/website-analytics/analysis/describe", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/website-analytics/analysis/describe")
    >();
  return {
    ...actual,
    findingFacts: (
      view: GaFindingView,
      options?: { currency?: string | null },
    ) =>
      factsMock.override
        ? factsMock.override(view.id)
        : actual.findingFacts(view, options),
  };
});

// Bu dosyanın kanıtladığı (anlatı olguları): olgulardaki her sayı kartın
// kendi sayısıdır; Google kaynaklı metin en çok 20 ve maskelidir; arama
// terimi ve kampanya adı hiç girmez; anlatı number-check'ten geçer (GK17:
// Makedonca binlik biçimleri dahil).

beforeEach(() => {
  factsMock.override = null;
});

function view(id: string): GaFindingView {
  return {
    id,
    ruleKey: "AN15",
    kind: "RISK",
    subject: "goal",
    subjectLabel: "Goal",
    period: {
      grain: "WEEK",
      from: "2026-09-28",
      to: "2026-10-04",
      key: "2026-W40",
    },
    severity: "WARN",
    confidence: "SIGNIFICANT",
    status: "OPEN",
    mode: "live",
    priority: 0.5,
    evidence: {
      v: 1,
      rule: "AN15",
      goalId: "g1",
      goalTitle: "Website sessions per month",
      metricKey: "web.sessions",
      month: "2026-10",
      target: 25000,
      monthToDate: 4760,
      forecast: 18400,
      paceRatio: 0.74,
      dayOfMonth: 4,
      daysInMonth: 31,
      through: "2026-10-04",
    },
    impact: null,
    explanation: null,
    occurrences: 1,
    evaluable: false,
    preliminary: false,
    createdAt: "2026-10-05T08:00:00.000Z",
    acceptedAt: null,
    doneAt: null,
    evaluateAfter: null,
    evaluatedAt: null,
    outcome: null,
    reviewVerdict: null,
  };
}

function snap(
  id: string,
  list: "changed" | "opportunities",
): ReportFindingSnap {
  return {
    id,
    ruleKey: "AN15",
    list,
    kind: "RISK",
    title: `Finding ${id}`,
    detail: "Detail",
    impact: null,
    confidence: "Significant",
    period: "Sep 28 – Oct 4",
    explanation: null,
    status: "OPEN",
    outcome: null,
    preliminary: false,
    href: `/x#${id}`,
  };
}

function mover(page: string, sessions: number): ReportMover {
  return {
    page,
    sessions,
    previousSessions: sessions - 5,
    change: 5,
    changePct: 1,
    keyEvents: 1,
    previousKeyEvents: 1,
  };
}

function weeklyWith(
  patch: (
    body: Extract<WebsiteReportCardData["body"], { variant: "weekly" }>,
  ) => void,
): WebsiteReportCardData {
  const card = sampleWeeklyCard();
  if (card.body.variant !== "weekly") throw new Error("variant");
  patch(card.body);
  return card;
}

// Bir nesnedeki sayısal yapraklar (metinler hariç).
function numbersOf(value: unknown, out: number[] = []): number[] {
  if (typeof value === "number") out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => numbersOf(item, out));
  else if (value && typeof value === "object") {
    Object.values(value).forEach((item) => numbersOf(item, out));
  }
  return out;
}

describe("reportFactsOf shape", () => {
  it("returns null for the other variants", () => {
    expect(reportFactsOf(samplePulseCard(), [])).toBeNull();
    expect(reportFactsOf(samplePlanCard(), [])).toBeNull();
    expect(reportFactsOf(sampleAlertCard(), [])).toBeNull();
  });

  it("describes the weekly report without dates", () => {
    const result = reportFactsOf(sampleWeeklyCard(), []);
    expect(result).not.toBeNull();
    const facts = result?.facts;
    expect(facts).toMatchObject({
      report: "weekly",
      period: "last week",
      days: 7,
      comparedWith: "the week before",
      aiAssistantSessions: 53,
    });
    expect(facts?.goals).toEqual([
      {
        name: "Sessions",
        target: 25000,
        soFar: 4760,
        forecast: 18400,
        status: "At risk",
      },
    ]);
    expect(facts?.forecasts).toHaveLength(1);
    // snapshotNote yok, diğer notlar var.
    expect(facts?.notes).toEqual([
      "Numbers from the last 7 days may still change slightly.",
    ]);
    expect(facts?.measurement).toEqual({ score: 82, issues: 2, critical: 0 });
  });

  it("describes the monthly report", () => {
    const facts = reportFactsOf(sampleMonthlyCard(), [])?.facts;
    expect(facts).toMatchObject({
      report: "monthly",
      period: "last month",
      comparedWith: "the month before",
      days: 30,
      forecasts: [],
    });
  });

  it("formats the KPIs like the card", () => {
    const card = sampleWeeklyCard();
    if (card.body.variant !== "weekly") throw new Error("variant");
    const facts = reportFactsOf(card, [])?.facts;
    expect(facts?.kpis).toHaveLength(card.body.kpis.length);
    for (const [index, kpi] of card.body.kpis.entries()) {
      const fact = facts?.kpis[index];
      expect(fact?.name).toBe(kpi.label);
      expect(fact?.value).toBe(
        formatMetric(kpi.format, kpi.value ?? 0, card.currency),
      );
      expect(fact?.changePct).toBe(kpi.changePct);
    }
    expect(facts?.kpis[1]?.value).toBe("4,760");
  });
});

describe("reportFactsOf numbers", () => {
  it("holds only numbers the card itself holds", () => {
    const card = sampleWeeklyCard();
    const facts = reportFactsOf(card, [])?.facts;
    // Dönem gün sayısı (7) kartın tarihlerinden, asistan toplamı (53) kartın
    // satırlarından türer.
    const ai =
      card.body.variant === "weekly" && card.body.aiAssistants
        ? card.body.aiAssistants.rows.reduce(
            (sum, row) => sum + (row.values[0] ?? 0),
            0,
          )
        : 0;
    const known = [...numbersOf(card.body), 7, ai];
    const factNumbers = numbersOf({ ...facts, kpis: [], days: undefined });
    for (const value of factNumbers) {
      expect(known).toContain(value);
    }
    // Biçimlenmiş KPI metinleri kartın sayısını okur.
    const kpiNumbers = allowedNumbersOf(facts?.kpis);
    expect(kpiNumbers).toContain(4760);
    expect(kpiNumbers).toContain(56.4);
  });

  it("drops a number sentence the report does not hold and keeps a true one", () => {
    const card = weeklyWith((body) => {
      body.kpis = [
        {
          key: "sessions",
          label: "Sessions",
          format: "count",
          value: 1234,
          previous: 1100,
          changePct: 12.2,
          lastYear: null,
          lastYearChangePct: null,
        } satisfies ReportKpi,
      ];
    });
    const facts = reportFactsOf(card, [])?.facts;
    const allowed = allowedNumbersOf(facts);
    const checked = checkSummaryNumbers(
      {
        headline: "Sessions were 1,234 last week.",
        highlights: ["Sessions reached 9,999 last week."],
        watchouts: [],
        nextSteps: [],
      },
      allowed,
    );
    expect(checked?.headline).toBe("Sessions were 1,234 last week.");
    expect(checked?.highlights).toEqual([]);
  });

  it("keeps Macedonian groupings and drops an unsupported number (GK17)", () => {
    const card = weeklyWith((body) => {
      body.kpis = [
        {
          key: "sessions",
          label: "Sessions",
          format: "count",
          value: 1234,
          previous: 1100,
          changePct: 12.2,
          lastYear: null,
          lastYearChangePct: null,
        },
      ];
    });
    const allowed = allowedNumbersOf(reportFactsOf(card, [])?.facts);
    const checked = checkSummaryNumbers(
      {
        headline: "Сесиите се 1.234.",
        highlights: ["Сесиите се 1 234.", "Сесиите се 9.999."],
        watchouts: [],
        nextSteps: [],
      },
      allowed,
    );
    expect(checked?.headline).toBe("Сесиите се 1.234.");
    expect(checked?.highlights).toEqual(["Сесиите се 1 234."]);
  });
});

describe("reportFactsOf Google strings", () => {
  it("never carries site search terms or campaign names", () => {
    const weekly = JSON.stringify(reportFactsOf(sampleWeeklyCard(), [])?.facts);
    expect(weekly).not.toContain(SAMPLE_SENSITIVE.searchTerm);
    const monthly = JSON.stringify(
      reportFactsOf(sampleMonthlyCard(), [])?.facts,
    );
    expect(monthly).not.toContain(SAMPLE_SENSITIVE.campaign);
    expect(monthly).not.toContain(SAMPLE_SENSITIVE.searchTerm);
  });

  it("masks an email inside a page path", () => {
    const card = weeklyWith((body) => {
      body.winners = [mover("/contact/jane.doe@example.com", 50)];
    });
    const result = reportFactsOf(card, []);
    expect(result?.facts.pagesUp[0]?.page).toBe("/contact/[email]");
    expect(JSON.stringify(result?.facts)).not.toContain("jane.doe");
    expect(result?.googleStrings).toBeGreaterThanOrEqual(1);
  });

  it("counts every page and key event name as one string", () => {
    const result = reportFactsOf(sampleWeeklyCard(), []);
    // 2 kazanan + 2 kaybeden sayfa + 2 key event adı.
    expect(result?.googleStrings).toBe(6);
    expect(result?.facts.keyEvents.map((event) => event.name)).toContain(
      SAMPLE_SENSITIVE.eventName,
    );
  });

  it("stays within twenty strings with 30 movers and 10 findings of 3 strings", () => {
    factsMock.override = (id) => ({
      a: `/page/${id}`,
      b: `term ${id}`,
      c: `/other/${id}`,
      sessions: 10,
    });
    const ids = Array.from({ length: 10 }, (_, index) => `f${index}`);
    const card = weeklyWith((body) => {
      body.whatChanged = ids.slice(0, 5).map((id) => snap(id, "changed"));
      body.opportunities = ids.slice(5).map((id) => snap(id, "opportunities"));
      body.winners = Array.from({ length: 15 }, (_, index) =>
        mover(`/win/${index}`, 100 + index),
      );
      body.losers = Array.from({ length: 15 }, (_, index) =>
        mover(`/lose/${index}`, 100 + index),
      );
    });
    const result = reportFactsOf(
      card,
      ids.map((id) => view(id)),
    );
    expect(result).not.toBeNull();
    expect(result?.googleStrings).toBeLessThanOrEqual(REPORT_LLM_MAX_STRINGS);
    // Bulgular en çok 5; her biri 3 metin → 15; kalan 5 bütçe kazanan sayfalara.
    expect(result?.facts.findings).toHaveLength(5);
    expect(result?.googleStrings).toBe(20);
    expect(result?.facts.pagesUp).toHaveLength(5);
    expect(result?.facts.pagesDown).toHaveLength(0);
    expect(result?.facts.keyEvents).toHaveLength(0);
    // Toplam metin sayısı olguda gerçekten 20'yi geçmez.
    const strings: string[] = [];
    const walk = (value: unknown) => {
      if (typeof value === "string") strings.push(value);
      else if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") {
        Object.values(value).forEach(walk);
      }
    };
    walk(result?.facts.findings.map((finding) => finding.facts));
    walk(result?.facts.pagesUp.map((page) => page.page));
    expect(strings.length).toBeLessThanOrEqual(REPORT_LLM_MAX_STRINGS);
  });

  it("drops a finding whole when its strings do not fit", () => {
    factsMock.override = (id) =>
      id === "big"
        ? Object.fromEntries(
            Array.from({ length: 21 }, (_, index) => [
              `s${index}`,
              `text ${index}`,
            ]),
          )
        : { a: "/small" };
    const card = weeklyWith((body) => {
      body.whatChanged = [snap("big", "changed"), snap("small", "changed")];
      body.opportunities = [];
    });
    const result = reportFactsOf(card, [view("big"), view("small")]);
    expect(result?.facts.findings).toHaveLength(1);
    expect(result?.facts.findings[0]?.facts).toEqual({ a: "/small" });
  });

  it("skips findings without a matching view", () => {
    const card = weeklyWith((body) => {
      body.whatChanged = [snap("missing", "changed")];
      body.opportunities = [];
    });
    expect(reportFactsOf(card, [])?.facts.findings).toEqual([]);
  });

  it("titles findings with the generic operator title", () => {
    const card = weeklyWith((body) => {
      body.whatChanged = [snap("f1", "changed")];
      body.opportunities = [snap("f2", "opportunities")];
    });
    const result = reportFactsOf(card, [view("f1"), view("f2")]);
    expect(result?.facts.findings.map((finding) => finding.list)).toEqual([
      "changed",
      "opportunities",
    ]);
    for (const finding of result?.facts.findings ?? []) {
      expect(finding.title).not.toMatch(/\d/);
      expect(finding.confidence).toBe("Significant");
    }
  });
});
