import { describe, expect, it } from "vitest";

import type { GaFindingView } from "@/lib/website-analytics/analysis/view-types";
import type { GaStoredSlice } from "@/lib/website-analytics/slices";
import type { GaPeriodTotals } from "@/lib/website-analytics/totals";

import {
  buildAlertCard,
  buildMonthlyCard,
  buildPulseCard,
  buildWeeklyCard,
  needsNarrative,
  nextStepsFromFindings,
  withNarrative,
} from "./build";
import { readWebsiteReportCard } from "./card";
import { reportFactsOf } from "./facts";
import { websiteReportChatDigest } from "./text";
import { WEBSITE_REPORT_COPY } from "./copy";
import type {
  GoalProgressView,
  MonthlyReportInput,
  PulseInput,
  ReportAgentelseSection,
  ReportFindingSnap,
  ReportLinkInfo,
  ReportWindowData,
  WeeklyReportInput,
} from "./types";

// Bu dosyanın kanıtladığı: kartlar kendi sayılarını taşır ve kart okuyucudan
// aynen geçer; not sırası sabittir (snapshotNote sonda); bulgular kapalıyken
// listeler boştur; aylık kartın ek bölümleri; withNarrative sayılara
// dokunmaz; uyarı kartı rakamsızdır.

function totals(partial: Partial<GaPeriodTotals> = {}): GaPeriodTotals {
  return {
    dailyActiveUsersSum: 0,
    newUsers: 0,
    sessions: 0,
    engagedSessions: 0,
    engagementSec: 0,
    sessionDurationSec: 0,
    screenPageViews: 0,
    keyEvents: 0,
    revenueMicros: BigInt(0),
    transactions: 0,
    ...partial,
  };
}

function slice(
  dimensionHeaders: string[],
  metricHeaders: string[],
  rows: (string | number)[][],
): GaStoredSlice {
  return {
    day: "2026-10-01",
    dimensionHeaders,
    metricHeaders,
    rows,
    truncated: false,
    otherRow: null,
    quality: {},
  };
}

const LINK: ReportLinkInfo = {
  projectId: "p1",
  linkId: "l1",
  propertyName: "Shop",
  timeZone: "Europe/Skopje",
  currency: "EUR",
  isMock: false,
  dataThrough: "2026-10-04",
};

function windowOf(
  range: { from: string; to: string },
  partial: Partial<ReportWindowData> = {},
): ReportWindowData {
  return {
    ...range,
    days: 7,
    coveredDays: 7,
    preliminary: false,
    totals: totals({
      sessions: 1000,
      newUsers: 400,
      engagedSessions: 600,
      engagementSec: 50_000,
      keyEvents: 50,
    }),
    channel: [
      slice(
        ["sessionDefaultChannelGroup"],
        ["sessions", "engagedSessions", "keyEvents", "totalRevenue"],
        [
          ["Direct", 600, 360, 30, 0],
          ["Paid Search", 400, 240, 20, 0],
        ],
      ),
    ],
    landing: [
      slice(
        ["landingPage"],
        ["sessions", "engagedSessions", "keyEvents", "totalRevenue"],
        [
          ["/pricing", 300, 150, 20, 0],
          ["/blog", 100, 40, 2, 0],
        ],
      ),
    ],
    events: [
      slice(
        ["eventName", "isKeyEvent"],
        ["eventCount", "keyEvents", "totalUsers"],
        [["generate_lead", "true", 60, 50, 40]],
      ),
    ],
    sourceMedium: [
      slice(
        ["sessionSource", "sessionMedium"],
        ["sessions", "engagedSessions", "keyEvents", "totalRevenue"],
        [["chatgpt.com", "referral", 20, 10, 2, 0]],
      ),
    ],
    campaign: [
      slice(
        [
          "sessionCampaignName",
          "sessionSource",
          "sessionMedium",
          "sessionManualAdContent",
        ],
        ["sessions", "engagedSessions", "keyEvents", "totalRevenue"],
        [["autumn", "google", "cpc", "(not set)", 200, 100, 10, 0]],
      ),
    ],
    landingMissingDays: 0,
    ...partial,
  };
}

const FINDING: GaFindingView = {
  id: "f1",
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
    target: 1000,
    monthToDate: 300,
    forecast: 800,
    paceRatio: 0.8,
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

function goalView(partial: Partial<GoalProgressView> = {}): GoalProgressView {
  return {
    goalId: "g1",
    title: "Website sessions per month",
    status: "ACTIVE",
    metricKey: "web.sessions",
    target: 10_000,
    month: "2026-10",
    through: "2026-10-04",
    dayOfMonth: 4,
    daysInMonth: 31,
    monthToDate: 1200,
    expectedToDate: 1300,
    forecast: 9000,
    forecastLow: 8000,
    forecastHigh: 10_000,
    forecastBasis: "ok",
    pace: "on_track",
    paceRatio: 0.9,
    updatedAt: "2026-10-05T00:00:00.000Z",
    ...partial,
  };
}

function weeklyInput(
  partial: Partial<WeeklyReportInput> = {},
): WeeklyReportInput {
  return {
    link: LINK,
    builtAt: "2026-10-05T12:00:00.000Z",
    websitePage: true,
    current: windowOf({ from: "2026-09-28", to: "2026-10-04" }),
    previous: windowOf(
      { from: "2026-09-21", to: "2026-09-27" },
      { totals: totals({ sessions: 900, newUsers: 350, keyEvents: 40 }) },
    ),
    lastYear: {
      from: "2025-09-29",
      to: "2025-10-05",
      totals: totals({ sessions: 800, keyEvents: 30 }),
    },
    users: { current: 700, previous: 650 },
    siteSearch: [slice(["searchTerm"], ["eventCount"], [["shoes", 12]])],
    measurement: {
      score: 90,
      tone: "ok",
      label: "Healthy",
      issues: 1,
      critical: 0,
      evaluatedAt: "2026-10-05T00:00:00.000Z",
    },
    findings: {
      insights: "on",
      changed: [FINDING],
      opportunities: [
        { ...FINDING, id: "f2" },
        { ...FINDING, id: "f3" },
        { ...FINDING, id: "f4" },
        { ...FINDING, id: "f5" },
      ],
      evaluated: [],
      outcomeCounts: null,
    },
    goals: [goalView()],
    goalsMonth: "2026-10",
    forecasts: [
      {
        metric: "sessions",
        month: "2026-10",
        through: "2026-10-04",
        dayOfMonth: 4,
        daysInMonth: 31,
        monthToDate: 1200,
        forecast: 9000,
        low: 8000,
        high: 10_000,
        basis: "ok",
      },
    ],
    ...partial,
  };
}

function monthlyInput(
  partial: Partial<MonthlyReportInput> = {},
): MonthlyReportInput {
  const { forecasts: _forecasts, ...weekly } = weeklyInput();
  void _forecasts;
  return {
    ...weekly,
    current: windowOf(
      { from: "2026-09-01", to: "2026-09-30" },
      { days: 30, coveredDays: 30 },
    ),
    previous: windowOf(
      { from: "2026-08-01", to: "2026-08-31" },
      { days: 31, coveredDays: 31 },
    ),
    lastYear: {
      from: "2025-09-01",
      to: "2025-09-30",
      totals: totals({ sessions: 800 }),
    },
    users: { current: null, previous: null },
    goals: [
      goalView({ month: "2026-09", pace: "achieved" }),
      goalView({ goalId: "g2", month: "2026-10" }),
    ],
    goalsMonth: "2026-09",
    month: "2026-09",
    ...partial,
  };
}


// GA-F6 bölümü örneği: etiketlerden biri HTML karakteri taşır.
const AGENTELSE: ReportAgentelseSection = {
  tracked: {
    columns: [
      { label: "Sessions (GA4)", format: "count" },
      { label: "Engagement rate", format: "percent" },
      { label: "Key events (GA4)", format: "count" },
    ],
    rows: [{ label: "Meta ads: <b>Spring</b> sale", values: [1200, 61.2, 30] }],
    other: [40, null, 1],
    notes: [],
  },
  ads: {
    columns: [
      { label: "Link clicks (Meta)", format: "count" },
      { label: "Sessions (GA4)", format: "count" },
    ],
    rows: [{ label: "Spring sale", values: [900, 700] }],
    other: null,
    notes: [],
  },
  googleAds: null,
  notes: ["Only visits through links Agentelse tagged are counted."],
};

describe("buildWeeklyCard agentelse section", () => {
  it("adds no agentelse key without the input", () => {
    for (const input of [weeklyInput(), weeklyInput({ agentelse: null })]) {
      const card = buildWeeklyCard(input);
      expect(Object.hasOwn(card.body, "agentelse")).toBe(false);
    }
  });

  it("copies the section into the body and the reader keeps it", () => {
    const card = buildWeeklyCard(weeklyInput({ agentelse: AGENTELSE }));
    if (card.body.variant !== "weekly") throw new Error("variant");
    expect(card.body.agentelse).toEqual(AGENTELSE);
    expect(readWebsiteReportCard(JSON.parse(JSON.stringify(card)))).toEqual(
      card,
    );
  });

  it("leaves the narrative facts and the chat digest unchanged", () => {
    const plain = buildWeeklyCard(weeklyInput());
    const withSection = buildWeeklyCard(weeklyInput({ agentelse: AGENTELSE }));
    expect(reportFactsOf(withSection, [])).toEqual(reportFactsOf(plain, []));
    const digest = websiteReportChatDigest(withSection);
    expect(digest).toBe(websiteReportChatDigest(plain));
    expect(digest).not.toContain("Spring");
    expect(digest).not.toContain("From Agentelse");
  });
});

describe("buildWeeklyCard", () => {
  it("survives the card reader unchanged", () => {
    const card = buildWeeklyCard(weeklyInput());
    expect(readWebsiteReportCard(JSON.parse(JSON.stringify(card)))).toEqual(
      card,
    );
  });

  it("fills the header fields from the link and the period", () => {
    const card = buildWeeklyCard(weeklyInput());
    expect(card).toMatchObject({
      kind: "website-report",
      v: 1,
      variant: "weekly",
      title: "Weekly website report · Sep 28 – Oct 4",
      periodLabel: "Sep 28 – Oct 4",
      projectId: "p1",
      linkId: "l1",
      propertyName: "Shop",
      timeZone: "Europe/Skopje",
      currency: "EUR",
      dataThrough: "2026-10-04",
      preliminary: false,
      isMock: false,
      narrative: null,
      narrativeNote: null,
    });
    expect(card.body).toMatchObject({
      variant: "weekly",
      from: "2026-09-28",
      to: "2026-10-04",
      previous: { from: "2026-09-21", to: "2026-09-27" },
      lastYear: { from: "2025-09-29", to: "2025-10-05" },
    });
  });

  it("holds the sections the weekly report promises", () => {
    const card = buildWeeklyCard(weeklyInput());
    if (card.body.variant !== "weekly") throw new Error("variant");
    const body = card.body;
    expect(body.kpis[0]?.key).toBe("users");
    expect(body.channels.rows.map((row) => row.label)).toEqual([
      "Direct",
      "Paid Search",
    ]);
    expect(body.keyEvents.rows[0]?.label).toBe("generate_lead");
    expect(body.aiAssistants?.rows[0]?.label).toBe("ChatGPT");
    expect(body.siteSearch?.rows[0]?.label).toBe("shoes");
    expect(body.measurement).toMatchObject({
      score: 90,
      href: "/projects/p1/site#measurement-health",
    });
    expect(body.forecasts).toHaveLength(1);
    expect(body.goals[0]).toMatchObject({ final: false, month: "2026-10" });
    // Bulgu bağlantıları Website sayfasının çapasına gider.
    expect(body.whatChanged[0]?.href).toBe("/projects/p1/site#finding-f1");
    // En çok 3 fırsat ve 3 sıradaki adım.
    expect(body.opportunities).toHaveLength(3);
    expect(body.nextSteps).toHaveLength(3);
    expect(body.nextStepsSource).toBe("findings");
  });

  it("orders the notes and keeps the snapshot note last", () => {
    const card = buildWeeklyCard(
      weeklyInput({
        current: windowOf(
          { from: "2026-09-28", to: "2026-10-04" },
          {
            preliminary: true,
            coveredDays: 5,
            totals: totals({ sessions: 10 }),
          },
        ),
        findings: {
          insights: "pending",
          changed: [],
          opportunities: [],
          evaluated: [],
          outcomeCounts: null,
        },
      }),
    );
    expect(card.preliminary).toBe(true);
    expect(card.body.variant === "weekly" && card.body.notes).toEqual([
      WEBSITE_REPORT_COPY.preliminaryNote,
      WEBSITE_REPORT_COPY.missingDaysNote,
      WEBSITE_REPORT_COPY.noKeyEventsNote,
      WEBSITE_REPORT_COPY.insightsPending,
      WEBSITE_REPORT_COPY.snapshotNote,
    ]);
  });

  it("leaves only the snapshot note for a clean week", () => {
    const card = buildWeeklyCard(weeklyInput());
    expect(card.body.variant === "weekly" && card.body.notes).toEqual([
      WEBSITE_REPORT_COPY.snapshotNote,
    ]);
  });

  it("drops the finding lists when insights are off", () => {
    const card = buildWeeklyCard(
      weeklyInput({
        findings: {
          insights: "off",
          changed: [FINDING],
          opportunities: [{ ...FINDING, id: "f2" }],
          evaluated: [],
          outcomeCounts: null,
        },
      }),
    );
    if (card.body.variant !== "weekly") throw new Error("variant");
    expect(card.body.insights).toBe("off");
    expect(card.body.whatChanged).toEqual([]);
    expect(card.body.opportunities).toEqual([]);
    expect(card.body.nextSteps).toEqual([]);
    expect(card.body.nextStepsSource).toBe("none");
  });

  it("omits the site search table without data", () => {
    const card = buildWeeklyCard(weeklyInput({ siteSearch: null }));
    expect(card.body.variant === "weekly" && card.body.siteSearch).toBeNull();
  });

  it("carries the mock flag and a missing last year", () => {
    const card = buildWeeklyCard(
      weeklyInput({ link: { ...LINK, isMock: true }, lastYear: null }),
    );
    expect(card.isMock).toBe(true);
    expect(card.body.variant === "weekly" && card.body.lastYear).toBeNull();
  });
});

describe("buildMonthlyCard", () => {
  it("survives the card reader unchanged", () => {
    const card = buildMonthlyCard(monthlyInput());
    expect(readWebsiteReportCard(JSON.parse(JSON.stringify(card)))).toEqual(
      card,
    );
  });

  it("adds top pages, paid traffic and outcomes and never site search", () => {
    const card = buildMonthlyCard(
      monthlyInput({
        findings: {
          insights: "on",
          changed: [],
          opportunities: [],
          evaluated: [
            { ...FINDING, id: "e1", status: "EVALUATED", outcome: "WORKED" },
          ],
          outcomeCounts: { worked: 2, didnt: 1, inconclusive: 0 },
        },
      }),
    );
    if (card.body.variant !== "monthly") throw new Error("variant");
    const body = card.body;
    expect(card).toMatchObject({
      variant: "monthly",
      title: "Monthly website report · September 2026",
      periodLabel: "September 2026",
    });
    expect(body.month).toBe("2026-09");
    expect(body.topPages.rows[0]?.label).toBe("/pricing");
    expect(body.paidTraffic?.rows.map((row) => row.label)).toEqual([
      "Paid Search",
      "autumn (google / cpc)",
    ]);
    expect(body.outcomes).toMatchObject({
      worked: 2,
      didnt: 1,
      inconclusive: 0,
    });
    expect(body.outcomes?.items[0]?.outcome).toBe("It worked");
    // Aylık raporda site araması yoktur, girdide olsa bile.
    expect(body.siteSearch).toBeNull();
  });

  it("has no outcomes block without outcome counts", () => {
    const card = buildMonthlyCard(monthlyInput());
    expect(card.body.variant === "monthly" && card.body.outcomes).toBeNull();
  });

  it("marks goals final and keeps only the report month", () => {
    const card = buildMonthlyCard(monthlyInput());
    if (card.body.variant !== "monthly") throw new Error("variant");
    expect(card.body.goals).toHaveLength(1);
    expect(card.body.goals[0]).toMatchObject({
      final: true,
      month: "2026-09",
      pace: "achieved",
      paceLabel: "Achieved",
    });
  });
});

describe("buildPulseCard", () => {
  function pulseInput(): PulseInput {
    return {
      link: LINK,
      builtAt: "2026-10-06T08:00:00.000Z",
      websitePage: false,
      day: "2026-10-05",
      days: [
        {
          day: "2026-10-05",
          sessions: 100,
          engagedSessions: 60,
          keyEvents: 5,
          revenue: 0,
          transactions: 0,
          isFinal: false,
        },
      ],
      suspect: new Set<string>(),
      holidays: new Set<string>(),
      channelDays: [],
      alerts: [
        {
          id: "a1",
          kind: "GA_MH24",
          title: "Google Analytics access was lost",
          severity: "CRITICAL",
          firstSeenAt: "2026-10-06T00:00:00.000Z",
          isNew: true,
        },
      ],
      anomalies: [],
    };
  }

  it("wraps the evaluation in a card and survives the reader", () => {
    const card = buildPulseCard(pulseInput());
    expect(card).toMatchObject({
      variant: "pulse",
      title: "Website pulse · Mon, Oct 5",
      periodLabel: "Mon, Oct 5",
      narrative: null,
      // Gün henüz kesinleşmedi.
      preliminary: true,
    });
    expect(card.body.variant === "pulse" && card.body.reasons).toEqual([
      "alert",
    ]);
    expect(readWebsiteReportCard(JSON.parse(JSON.stringify(card)))).toEqual(
      card,
    );
  });

  it("treats a missing day row as preliminary", () => {
    const input = pulseInput();
    expect(buildPulseCard({ ...input, days: [] }).preliminary).toBe(true);
    const finalDay = input.days.map((day) => ({ ...day, isFinal: true }));
    expect(buildPulseCard({ ...input, days: finalDay }).preliminary).toBe(
      false,
    );
  });
});

describe("buildAlertCard", () => {
  const alert = {
    id: "a1",
    kind: "GA_MH24",
    title: "Google Analytics access was lost",
    firstSeenAt: "2026-10-05T07:30:00.000Z",
  };

  it("marks a lost access alert as reconnect and links to integrations", () => {
    const card = buildAlertCard({
      link: LINK,
      builtAt: "2026-10-05T08:00:00.000Z",
      websitePage: true,
      alert,
    });
    expect(card.body).toEqual({
      variant: "alert",
      alertId: "a1",
      kind: "GA_MH24",
      severity: "CRITICAL",
      title: alert.title,
      href: "/projects/p1/integrations?integration=google_analytics",
      reconnect: true,
      openedAt: alert.firstSeenAt,
    });
    expect(card).toMatchObject({
      variant: "alert",
      title: "Tracking alert: Google Analytics access was lost",
      periodLabel: "Oct 5",
      preliminary: false,
    });
    expect(readWebsiteReportCard(JSON.parse(JSON.stringify(card)))).toEqual(
      card,
    );
  });

  it("links other alerts to measurement health and has no digits in texts", () => {
    const card = buildAlertCard({
      link: LINK,
      builtAt: "2026-10-05T08:00:00.000Z",
      websitePage: true,
      alert: { ...alert, id: "a2", kind: "GA_MH1" },
    });
    if (card.body.variant !== "alert") throw new Error("variant");
    expect(card.body.reconnect).toBe(false);
    expect(card.body.href).toBe("/projects/p1/site#measurement-health");
    expect(card.title).not.toMatch(/\d/);
    expect(card.body.title).not.toMatch(/\d/);
    expect(WEBSITE_REPORT_COPY.alertBody).not.toMatch(/\d/);
    expect(WEBSITE_REPORT_COPY.reconnectBody).not.toMatch(/\d/);
  });
});

describe("nextStepsFromFindings", () => {
  const snap = (title: string): ReportFindingSnap => ({
    id: title,
    ruleKey: "AN3",
    list: "opportunities",
    kind: "WIN",
    title,
    detail: "",
    impact: null,
    confidence: "Directional",
    period: "",
    explanation: null,
    status: "OPEN",
    outcome: null,
    preliminary: false,
    href: "/x",
  });

  it("writes at most three review steps", () => {
    expect(
      nextStepsFromFindings([snap("A"), snap("B"), snap("C"), snap("D")]),
    ).toEqual([
      'Review "A" on the Website page.',
      'Review "B" on the Website page.',
      'Review "C" on the Website page.',
    ]);
    expect(nextStepsFromFindings([])).toEqual([]);
  });
});

describe("needsNarrative", () => {
  it("is true only for real weekly and monthly reports outside mock mode", () => {
    const weekly = buildWeeklyCard(weeklyInput());
    const monthly = buildMonthlyCard(monthlyInput());
    expect(needsNarrative(weekly, false)).toBe(true);
    expect(needsNarrative(monthly, false)).toBe(true);
    expect(needsNarrative(weekly, true)).toBe(false);
    expect(
      needsNarrative(
        buildWeeklyCard(weeklyInput({ link: { ...LINK, isMock: true } })),
        false,
      ),
    ).toBe(false);
    expect(
      needsNarrative(
        buildAlertCard({
          link: LINK,
          builtAt: "2026-10-05T08:00:00.000Z",
          websitePage: true,
          alert: {
            id: "a",
            kind: "GA_MH1",
            title: "Tracking stopped",
            firstSeenAt: "2026-10-05T07:30:00.000Z",
          },
        }),
        false,
      ),
    ).toBe(false);
  });
});

describe("withNarrative", () => {
  const narrative = {
    headline: "Sessions grew.",
    highlights: ["Direct led."],
    watchouts: [],
    nextSteps: ["Update the pricing page.", "Test a new headline."],
  };

  it("replaces the next steps only when the narrative brings some", () => {
    const card = buildWeeklyCard(weeklyInput());
    const next = withNarrative(card, { narrative, note: null });
    expect(next).not.toBe(card);
    expect(next.narrative).toEqual(narrative);
    expect(next.narrativeNote).toBeNull();
    if (next.body.variant !== "weekly") throw new Error("variant");
    expect(next.body.nextSteps).toEqual(narrative.nextSteps);
    expect(next.body.nextStepsSource).toBe("ai");

    const without = withNarrative(card, {
      narrative: { ...narrative, nextSteps: [] },
      note: null,
    });
    if (without.body.variant !== "weekly") throw new Error("variant");
    if (card.body.variant !== "weekly") throw new Error("variant");
    expect(without.body.nextSteps).toEqual(card.body.nextSteps);
    expect(without.body.nextStepsSource).toBe("findings");
  });

  it("never touches the numbers and keeps the original card as it was", () => {
    const card = buildMonthlyCard(monthlyInput());
    const before = JSON.stringify(card);
    const next = withNarrative(card, { narrative, note: null });
    expect(JSON.stringify(card)).toBe(before);
    if (next.body.variant !== "monthly" || card.body.variant !== "monthly") {
      throw new Error("variant");
    }
    expect(next.body.kpis).toEqual(card.body.kpis);
    expect(next.body.channels).toEqual(card.body.channels);
    expect(next.body.goals).toEqual(card.body.goals);
  });

  it("stores only the note when there is no narrative", () => {
    const card = buildWeeklyCard(weeklyInput());
    const next = withNarrative(card, {
      narrative: null,
      note: WEBSITE_REPORT_COPY.narrativeFailed,
    });
    expect(next.narrative).toBeNull();
    expect(next.narrativeNote).toBe(WEBSITE_REPORT_COPY.narrativeFailed);
    expect(next.body).toEqual(card.body);
  });
});
