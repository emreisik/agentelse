import { describe, expect, it } from "vitest";

import {
  allowedNumbersOf,
  isSupportedToken,
  numberTokens,
} from "@/lib/module-flows/analytics/number-check";

import {
  findingConfidenceText,
  findingDetail,
  findingFacts,
  findingImpactText,
  findingPeriodText,
  findingSignalText,
  findingStatusText,
  findingTitle,
  learningText,
  operatorFindingTitle,
  outcomeText,
} from "./describe";
import type {
  GaDecomposition,
  GaFindingEvidence,
  GaFindingKind,
  GaImpact,
  GaPeriod,
  GaRuleKey,
} from "./types";
import { GA_RULE_KEYS } from "./types";
import type { GaFindingView } from "./view-types";

// Bu dosyanın kanıtladığı (GA-F4 metinleri): ayrıntı, etki ve dönem
// metnindeki her sayı findingFacts'te (number-check gidiş-dönüşü); oranlar
// yüzde yazılır; tatil cümlesi; operatör başlığında rakam yok; sinyal ve
// öğrenme metni rakam, yol, arama terimi ve kampanya adı taşımaz, varsayılan
// olmayan kanal adı "Your website" olur.

const WINDOW = { from: "2026-09-07", to: "2026-10-04" };
const WEEK = { from: "2026-09-28", to: "2026-10-04" };

const PAGE = "/pricing-2026";
const CAMPAIGN = "autumn_sale_15";
const TERMS = ["iphone 15", "return policy", "size 42.5", "gift card", "shoes"];

function decomposition(
  label: string,
  patch: Partial<GaDecomposition> = {},
): GaDecomposition {
  return {
    metric: "sessions",
    dimension: "channel",
    before: 1840,
    after: 1523,
    delta: -317,
    perDay: false,
    components: [
      {
        key: label,
        label,
        sessionsBefore: 912,
        sessionsAfter: 708,
        valueBefore: 912,
        valueAfter: 708,
        rateBefore: 1,
        rateAfter: 1,
        volume: -204,
        rate: 0,
        total: -204,
        share: 0.6435,
      },
    ],
    other: null,
    residual: -113,
    ...patch,
  };
}

const EVIDENCE: Record<GaRuleKey, GaFindingEvidence> = {
  AN1: {
    v: 1,
    rule: "AN1",
    mode: "day",
    target: "2026-10-05",
    readings: [
      {
        metric: "keyEvents",
        value: 12.4,
        median: 41.7,
        scale: 6.2,
        z: -4.7,
        direction: "down",
        baselineDays: ["2026-09-28"],
      },
    ],
    primary: "keyEvents",
    excludedDays: [],
    breakdown: decomposition("Organic Search"),
    seasonalChecked: true,
    preliminary: true,
  },
  AN2: {
    v: 1,
    rule: "AN2",
    comparison: "wow",
    metric: "revenue",
    metricReason: "requested",
    current: { ...WEEK, days: 7, total: 10432.567 },
    previous: { from: "2026-09-21", to: "2026-09-27", days: 7, total: 13998.1 },
    change: -3565.533,
    changePct: -25.4712,
    z: -5.1,
    p: 0.0001,
    channels: decomposition("Paid Search"),
    pages: null,
    holidays: [],
    suspectDays: [],
    seasonal: null,
    preliminary: false,
  },
  AN3: {
    v: 1,
    rule: "AN3",
    variant: "cro",
    window: WINDOW,
    page: PAGE,
    sessions: 1234.4,
    keyEvents: 7,
    rate: 0.005671,
    restSessions: 18877,
    restKeyEvents: 612,
    restRate: 0.032421,
    ratio: 0.17,
    threshold: 0.5,
    p: 0.0003,
    bhAccepted: true,
    excludedDays: [],
    holidays: ["2026-09-08"],
  },
  AN4: {
    v: 1,
    rule: "AN4",
    window: WINDOW,
    channel: "Paid Social",
    measure: "engagement",
    direction: "below",
    sessions: 2310,
    hits: 693,
    rate: 0.3,
    restSessions: 15012,
    restHits: 9157,
    restRate: 0.61,
    ratio: 0.49,
    p: 0.0001,
    bhAccepted: true,
    excludedDays: [],
    holidays: [],
  },
  AN5: {
    v: 1,
    rule: "AN5",
    window: WINDOW,
    mobile: { sessions: 8120, keyEvents: 81, rate: 0.009975 },
    desktop: { sessions: 4021, keyEvents: 97, rate: 0.024123 },
    ratio: 0.41,
    p: 0.0002,
    excludedDays: [],
    holidays: [],
  },
  AN6: {
    v: 1,
    rule: "AN6",
    weeks: [
      { monday: "2026-08-10", returning: 310, total: 1000, share: 0.31 },
      { monday: "2026-10-05", returning: 230, total: 1000, share: 0.23 },
    ],
    earlyShare: 0.3125,
    lateShare: 0.2366,
    dropPoints: 7.59,
    p: 0.01,
  },
  AN7: {
    v: 1,
    rule: "AN7",
    current: { ...WINDOW, sessions: 187, keyEvents: 9 },
    previous: {
      from: "2026-08-10",
      to: "2026-09-06",
      sessions: 74,
      keyEvents: 2,
    },
    assistants: [
      { name: "ChatGPT", sessions: 121, previousSessions: 50 },
      { name: "Perplexity", sessions: 66, previousSessions: 24 },
    ],
    changePct: 152.7,
    p: 0.0001,
    firstSeen: false,
    siteSessions: 20111,
    holidays: [],
  },
  AN8: {
    v: 1,
    rule: "AN8",
    weeks: ["2026-09-14", "2026-09-21", "2026-09-28"],
    terms: TERMS.map((term, index) => ({ term, searches: 40 - index * 7 })),
    totalSearches: 213,
    siteSessions: 9000,
  },
  AN9: {
    v: 1,
    rule: "AN9",
    week: WEEK,
    pages: [
      { path: "/old-shop/item-77", title: "Page not found", views: 41 },
      { path: "/blog/2019/post", title: "404", views: 12 },
    ],
    views: 58,
  },
  AN10: {
    v: 1,
    rule: "AN10",
    window: { from: "2026-09-01", to: "2026-09-30" },
    month: "2026-09",
    pages: [
      {
        path: "/guides/how-to-3",
        sessions: 812,
        engagementRate: 0.8123,
        avgEngagementSec: 95.4,
        keyEvents: 12,
      },
    ],
    siteEngagementRate: 0.5512,
    siteAvgEngagementSec: 3725,
    holidays: [],
  },
  AN11: {
    v: 1,
    rule: "AN11",
    week: WEEK,
    baselineWeeks: ["2026-09-07", "2026-09-14", "2026-09-21"],
    step: {
      from: "add_to_cart",
      to: "begin_checkout",
      current: { entered: 412, completed: 103, rate: 0.25 },
      baseline: { entered: 1290, completed: 516, rate: 0.4 },
      p: 0.0001,
      dropPct: 37.5,
    },
    aov: { current: 54.2, baseline: 61.9 },
  },
  AN12: {
    v: 1,
    rule: "AN12",
    window: WINDOW,
    campaign: CAMPAIGN,
    source: "newsletter",
    medium: "email",
    agentelse: false,
    direction: "below",
    sessions: 655,
    keyEvents: 3,
    rate: 0.00458,
    restSessions: 19000,
    restKeyEvents: 610,
    restRate: 0.0321,
    ratio: 0.14,
    p: 0.001,
    bhAccepted: true,
    excludedDays: [],
    holidays: [],
  },
  AN15: {
    v: 1,
    rule: "AN15",
    goalId: "goal-1",
    goalTitle: "Q4 revenue 25k",
    metricKey: "web.revenue",
    month: "2026-10",
    target: 25000,
    monthToDate: 4100.5,
    forecast: 18750.25,
    paceRatio: 0.75001,
    dayOfMonth: 6,
    daysInMonth: 31,
    through: "2026-10-06",
  },
};

const KIND: Record<GaRuleKey, GaFindingKind> = {
  AN1: "ANOMALY",
  AN2: "CHANGE",
  AN3: "OPPORTUNITY",
  AN4: "RISK",
  AN5: "OPPORTUNITY",
  AN6: "RISK",
  AN7: "WIN",
  AN8: "OPPORTUNITY",
  AN9: "RISK",
  AN10: "WIN",
  AN11: "RISK",
  AN12: "RISK",
  AN15: "RISK",
};

const PERIOD: Record<GaRuleKey, GaPeriod> = {
  AN1: {
    grain: "DAY",
    from: "2026-10-05",
    to: "2026-10-05",
    key: "2026-10-05",
  },
  AN2: { grain: "WEEK", ...WEEK, key: "2026-W40:wow" },
  AN3: { grain: "WINDOW28", ...WINDOW, key: "2026-W40:28d" },
  AN4: { grain: "WINDOW28", ...WINDOW, key: "2026-W40:28d" },
  AN5: { grain: "WINDOW28", ...WINDOW, key: "2026-W40:28d" },
  AN6: { grain: "WEEK", ...WEEK, key: "2026-W40" },
  AN7: { grain: "WINDOW28", ...WINDOW, key: "2026-W40:28d" },
  AN8: { grain: "WEEK", ...WEEK, key: "2026-W40" },
  AN9: { grain: "WEEK", ...WEEK, key: "2026-W40" },
  AN10: {
    grain: "MONTH",
    from: "2026-09-01",
    to: "2026-09-30",
    key: "2026-09",
  },
  AN11: { grain: "WEEK", ...WEEK, key: "2026-W40" },
  AN12: { grain: "WINDOW28", ...WINDOW, key: "2026-W40:28d" },
  AN15: {
    grain: "MONTH",
    from: "2026-10-01",
    to: "2026-10-31",
    key: "2026-10",
  },
};

const IMPACT: Partial<Record<GaRuleKey, GaImpact>> = {
  AN3: {
    metric: "keyEvents",
    perWeek: 8.64,
    low: 6.1,
    high: 11.2,
    directional: false,
  },
  AN4: {
    metric: "engagedSessions",
    perWeek: 179.6,
    low: 179.6,
    high: 179.6,
    directional: false,
  },
  AN5: {
    metric: "keyEvents",
    perWeek: 3.4,
    low: 0,
    high: 7.2,
    directional: true,
  },
  AN9: { metric: "views", perWeek: 58, low: 58, high: 58, directional: false },
  AN11: {
    metric: "purchases",
    perWeek: 61.8,
    low: 61.8,
    high: 61.8,
    directional: false,
  },
  AN12: {
    metric: "keyEvents",
    perWeek: 4.51,
    low: 4.51,
    high: 4.51,
    directional: false,
  },
  AN15: {
    metric: "revenue",
    perWeek: 1411.234,
    low: 1411.234,
    high: 1411.234,
    directional: true,
  },
};

function view(
  ruleKey: GaRuleKey,
  patch: Partial<GaFindingView> = {},
): GaFindingView {
  return {
    id: `f-${ruleKey}`,
    ruleKey,
    kind: KIND[ruleKey],
    subject: "site",
    subjectLabel: "Your site",
    period: PERIOD[ruleKey],
    severity: "WARN",
    confidence: "SIGNIFICANT",
    status: "OPEN",
    mode: "live",
    priority: 0.5,
    evidence: EVIDENCE[ruleKey],
    impact: IMPACT[ruleKey] ?? null,
    explanation: null,
    occurrences: 1,
    evaluable: false,
    preliminary: false,
    createdAt: "2026-10-06T08:00:00.000Z",
    acceptedAt: null,
    doneAt: null,
    evaluateAfter: null,
    evaluatedAt: null,
    outcome: null,
    reviewVerdict: null,
    ...patch,
  };
}

const ALL = GA_RULE_KEYS.map((key) => view(key));

// Rakam taşımayan metinler için: metinde hiçbir rakam yok.
const DIGIT = /\d/;

function unsupported(text: string, facts: Record<string, unknown>): string[] {
  const allowed = allowedNumbersOf(facts);
  return numberTokens(text).filter(
    (token) => !isSupportedToken(token, allowed),
  );
}

describe("number-check round trip", () => {
  it.each(ALL.map((f) => [f.ruleKey, f] as const))(
    "%s: every printed number is in findingFacts",
    (_key, f) => {
      for (const currency of [null, "TRY"]) {
        const facts = findingFacts(f, { currency });
        const texts = [
          findingDetail(f, { currency }),
          findingImpactText(f.impact, { currency, finding: f }) ?? "",
          findingImpactText(f.impact, { currency }) ?? "",
          findingPeriodText(f.period),
        ];
        for (const text of texts) {
          expect(unsupported(text, facts), text).toEqual([]);
        }
        expect(findingDetail(f, { currency })).not.toBe("");
      }
    },
  );

  it("keeps at most 3 subject strings in the facts", () => {
    for (const f of ALL) {
      const strings = Object.values(findingFacts(f)).filter(
        (value) =>
          typeof value === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(value),
      );
      expect(strings.length, f.ruleKey).toBeLessThanOrEqual(3);
    }
  });

  it("covers AN1 week mode, AN2 MoM and AN7 first seen", () => {
    const an1 = EVIDENCE.AN1;
    const an2 = EVIDENCE.AN2;
    const an7 = EVIDENCE.AN7;
    if (an1.rule !== "AN1" || an2.rule !== "AN2" || an7.rule !== "AN7") {
      throw new Error("fixture");
    }
    const variants = [
      view("AN1", {
        evidence: { ...an1, mode: "week", primary: "keyEvents" },
      }),
      view("AN2", {
        evidence: {
          ...an2,
          comparison: "mom",
          metric: "sessions",
          current: { ...an2.current, days: 30, total: 6123 },
          previous: { ...an2.previous, days: 31, total: 7012 },
          channels: decomposition("Direct", { perDay: true }),
        },
      }),
      view("AN7", {
        evidence: { ...an7, firstSeen: true, changePct: null },
      }),
    ];
    for (const f of variants) {
      const facts = findingFacts(f);
      expect(unsupported(findingDetail(f), facts)).toEqual([]);
    }
    expect(findingTitle(variants[0]!)).toBe(
      "Key events dropped sharply last week",
    );
    expect(findingTitle(variants[2]!)).toBe(
      "AI assistants started sending visitors",
    );
  });
});

describe("titles and details", () => {
  it("writes rule titles", () => {
    expect(findingTitle(view("AN1"))).toBe("Key events dropped sharply");
    expect(findingTitle(view("AN2"))).toBe("Revenue fell week over week");
    expect(findingTitle(view("AN3"))).toBe(
      `${PAGE} gets visits but few key events`,
    );
    expect(findingTitle(view("AN4"))).toBe(
      "Paid Social visits engage less than the rest",
    );
    expect(findingTitle(view("AN11"))).toBe(
      "Fewer shoppers go from add to cart to checkout",
    );
    expect(findingTitle(view("AN12"))).toBe(
      `Campaign “${CAMPAIGN}” converts less than the rest`,
    );
    expect(findingTitle(view("AN15"))).toBe(
      "Goal “Q4 revenue 25k” is behind this month",
    );
  });

  it("prints rates as percents", () => {
    const detail = findingDetail(view("AN3"));
    expect(detail).toContain("0.6% became key events vs 3.2%");
    expect(detail).toContain("1,234 visits in 28 days");
    expect(findingDetail(view("AN11"))).toContain("25%");
    expect(findingDetail(view("AN15", {}), { currency: "EUR" })).toContain(
      "On pace for 18,750.25 EUR of 25,000 EUR (75%) with 25 days left.",
    );
  });

  it("lists at most 5 site-search terms with counts", () => {
    const detail = findingDetail(view("AN8"));
    expect(detail).toContain("“iphone 15” (40)");
    expect(detail).toContain("“shoes” (12)");
  });

  it("speaks of visits for returning visitors", () => {
    const detail = findingDetail(view("AN6"));
    expect(detail).toContain("Returning visits");
    expect(detail).not.toMatch(/users/i);
  });

  it("adds the holiday sentence only with holidays", () => {
    expect(findingDetail(view("AN3"))).toMatch(/Includes a public holiday\.$/);
    expect(findingDetail(view("AN4"))).not.toContain("public holiday");
  });

  it("writes impact texts", () => {
    expect(
      findingImpactText(IMPACT.AN3 ?? null, { finding: view("AN3") }),
    ).toBe(
      "About +9 key events a week if this page converted like the rest of the site",
    );
    expect(
      findingImpactText(IMPACT.AN5 ?? null, { finding: view("AN5") }),
    ).toMatch(/\(directional\)$/);
    expect(findingImpactText(IMPACT.AN4 ?? null)).toBe(
      "About +180 engaged visits a week",
    );
    expect(findingImpactText(null)).toBeNull();
  });

  it("writes period texts", () => {
    expect(findingPeriodText(PERIOD.AN1)).toBe("Oct 5, 2026");
    expect(findingPeriodText(PERIOD.AN2)).toBe("Sep 28 – Oct 4, 2026");
    expect(findingPeriodText(PERIOD.AN10)).toBe("September 2026");
    expect(
      findingPeriodText({
        grain: "WEEK",
        from: "2026-12-28",
        to: "2027-01-03",
        key: "2026-W53",
      }),
    ).toBe("Dec 28, 2026 – Jan 3, 2027");
  });
});

describe("status texts", () => {
  it("covers accepted, done, evaluated and repeats", () => {
    const tz = { timeZone: "Europe/Skopje" };
    expect(
      findingStatusText(
        view("AN3", { status: "ACCEPTED", evaluable: true }),
        tz,
      ),
    ).toBe("Accepted — mark it done when the change is live");
    expect(
      findingStatusText(
        view("AN8", { status: "ACCEPTED", evaluable: false }),
        tz,
      ),
    ).toBe("Noted");
    expect(
      findingStatusText(
        view("AN3", {
          status: "DONE",
          evaluable: true,
          evaluateAfter: "2026-11-11T23:30:00.000Z",
        }),
        tz,
      ),
    ).toBe("Measuring results until Nov 12");
    expect(
      findingStatusText(
        view("AN3", { status: "EVALUATED", outcome: "WORKED" }),
        tz,
      ),
    ).toBe("It worked");
    expect(findingStatusText(view("AN3", { occurrences: 3 }), tz)).toBe(
      "Seen 3 periods in a row",
    );
    expect(findingStatusText(view("AN3"), tz)).toBeNull();
    expect(outcomeText("DIDNT")).toBe("No clear effect");
    expect(outcomeText("INCONCLUSIVE")).toBe("Not enough data to tell");
    expect(findingConfidenceText("DIRECTIONAL")).toBe("Directional");
  });
});

describe("operator titles", () => {
  it("never carries digits", () => {
    const kinds: GaFindingKind[] = [
      "ANOMALY",
      "CHANGE",
      "OPPORTUNITY",
      "RISK",
      "WIN",
    ];
    for (const key of GA_RULE_KEYS) {
      for (const kind of kinds) {
        expect(operatorFindingTitle(key, kind)).not.toMatch(DIGIT);
      }
    }
    expect(operatorFindingTitle("AN3", "WIN")).toContain("promote");
  });
});

describe("signal and learning texts", () => {
  const forbidden = [PAGE, CAMPAIGN, ...TERMS, "/old-shop", "/guides"];

  function assertClean(text: string) {
    expect(text).not.toMatch(DIGIT);
    expect(text).not.toContain("/");
    for (const value of forbidden) expect(text).not.toContain(value);
  }

  it("carries no number, path, term or campaign name", () => {
    for (const f of ALL) {
      const signal = findingSignalText(f);
      assertClean(signal.title);
      assertClean(signal.summary);
      assertClean(learningText(f));
      // Konu metni sızdırılsa bile kullanılmaz.
      const leaky = findingSignalText({
        ...f,
        subject: `page:${PAGE}`,
        subjectLabel: PAGE,
      });
      assertClean(leaky.title);
    }
  });

  it("names a default channel and falls back to 'Your website'", () => {
    expect(findingSignalText(view("AN2")).title).toBe(
      "Paid Search brought less revenue (week over week)",
    );
    const an2 = EVIDENCE.AN2;
    if (an2.rule !== "AN2") throw new Error("fixture");
    const custom = view("AN2", {
      evidence: {
        ...an2,
        metric: "sessions",
        channels: decomposition("Partners 2026"),
      },
    });
    expect(findingSignalText(custom).title).toBe(
      "Your website brought fewer visits (week over week)",
    );
    const an4 = EVIDENCE.AN4;
    if (an4.rule !== "AN4") throw new Error("fixture");
    expect(
      learningText({
        ruleKey: "AN4",
        evidence: { ...an4, channel: "VIP list 7" },
      }),
    ).toBe("Improving a traffic channel raised its engagement.");
    expect(learningText({ ruleKey: "AN4", evidence: an4 })).toBe(
      "Improving Paid Social traffic raised its engagement.",
    );
  });

  it("writes AI assistant and promote signals", () => {
    expect(findingSignalText(view("AN7")).title).toBe(
      "Visits from ChatGPT and other AI assistants are growing",
    );
    const an3 = EVIDENCE.AN3;
    if (an3.rule !== "AN3") throw new Error("fixture");
    expect(
      findingSignalText(
        view("AN3", { evidence: { ...an3, variant: "promote" } }),
      ).title,
    ).toBe("A landing page turns visitors into key events");
    expect(findingSignalText(view("AN3")).summary).toBe(
      "Agentelse found a significant change in your website's Google Analytics data. Open the Website page for the details.",
    );
  });

  it("writes the shop step learning with event labels", () => {
    expect(learningText(view("AN11"))).toBe(
      "Fixing the add to cart → checkout shop step raised its completion rate.",
    );
  });
});
