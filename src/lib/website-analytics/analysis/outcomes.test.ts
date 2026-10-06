import { describe, expect, it } from "vitest";

import type { GaTableRow } from "@/lib/website-analytics/slices";

import { evaluateGaOutcome, type GaOutcomeResult } from "./outcomes";
import { makeWindowTables } from "./test-fixtures";
import type {
  An3Evidence,
  An4Evidence,
  An5Evidence,
  An8Evidence,
  An9Evidence,
  An11Evidence,
  An12Evidence,
  GaFindingEvidence,
  GaRuleKey,
  GaWindowTables,
  GaWindowTotals,
} from "./types";

const BEFORE = { from: "2026-08-01", to: "2026-08-28" };
const AFTER = { from: "2026-09-05", to: "2026-10-02" };

function totals(partial: Partial<GaWindowTotals>): GaWindowTotals {
  return {
    sessions: 0,
    engagedSessions: 0,
    keyEvents: 0,
    revenue: 0,
    transactions: 0,
    engagementSec: 0,
    screenPageViews: 0,
    ...partial,
  };
}

type Side = Partial<GaWindowTables>;

function run(
  ruleKey: GaRuleKey,
  evidence: GaFindingEvidence,
  before: Side,
  after: Side,
  graceOver = false,
): GaOutcomeResult {
  return evaluateGaOutcome({
    ruleKey,
    evidence,
    before: makeWindowTables(BEFORE, before),
    after: makeWindowTables(AFTER, after),
    graceOver,
  });
}

function outcomeOf(result: GaOutcomeResult): string {
  return result.wait ? "wait" : `${result.outcome}:${result.evidence.reason}`;
}

// ---- kanıt kurucuları (yalnız kuralın okuduğu alanlar anlamlı) ----

const an3 = (variant: "cro" | "promote"): An3Evidence => ({
  v: 1,
  rule: "AN3",
  variant,
  window: BEFORE,
  page: "/p",
  sessions: 0,
  keyEvents: 0,
  rate: 0,
  restSessions: 0,
  restKeyEvents: 0,
  restRate: 0,
  ratio: 0,
  threshold: 100,
  p: null,
  bhAccepted: false,
  excludedDays: [],
  holidays: [],
});

const an4 = (measure: "engagement" | "keyEventRate"): An4Evidence => ({
  v: 1,
  rule: "AN4",
  window: BEFORE,
  channel: "Paid Social",
  measure,
  direction: "below",
  sessions: 0,
  hits: 0,
  rate: 0,
  restSessions: 0,
  restHits: 0,
  restRate: 0,
  ratio: 0,
  p: null,
  bhAccepted: false,
  excludedDays: [],
  holidays: [],
});

const an5: An5Evidence = {
  v: 1,
  rule: "AN5",
  window: BEFORE,
  mobile: { sessions: 0, keyEvents: 0, rate: 0 },
  desktop: { sessions: 0, keyEvents: 0, rate: 0 },
  ratio: 0,
  p: null,
  excludedDays: [],
  holidays: [],
};

const an9: An9Evidence = {
  v: 1,
  rule: "AN9",
  week: BEFORE,
  pages: [{ path: "/404", title: "Not found", views: 50 }],
  views: 50,
};

const an11: An11Evidence = {
  v: 1,
  rule: "AN11",
  week: BEFORE,
  baselineWeeks: [],
  step: {
    from: "begin_checkout",
    to: "purchase",
    current: { entered: 0, completed: 0, rate: 0 },
    baseline: { entered: 0, completed: 0, rate: 0 },
    p: 0.01,
    dropPct: 30,
  },
  aov: { current: null, baseline: null },
};

const an12: An12Evidence = {
  v: 1,
  rule: "AN12",
  window: BEFORE,
  campaign: "spring",
  source: "newsletter",
  medium: "email",
  agentelse: false,
  direction: "below",
  sessions: 0,
  keyEvents: 0,
  rate: 0,
  restSessions: 0,
  restKeyEvents: 0,
  restRate: 0,
  ratio: 0,
  p: null,
  bhAccepted: false,
  excludedDays: [],
  holidays: [],
};

// ---- tablo kurucuları ----

// Konu: oturum ve KE; geri kalan: 9000 oturum ve restKE.
function landingSide(sessions: number, keyEvents: number, restKE = 900): Side {
  return {
    landing: [{ key: ["/p"], values: [sessions, 0, keyEvents, 0, 0] }],
    totals: totals({
      sessions: sessions + 9_000,
      keyEvents: keyEvents + restKE,
    }),
  };
}

function channelSide(sessions: number, engaged: number, keyEvents = 0): Side {
  return {
    channel: [
      { key: ["Paid Social"], values: [sessions, engaged, keyEvents, 0] },
    ],
    totals: totals({
      sessions: sessions + 9_000,
      engagedSessions: engaged + 4_500,
      keyEvents: keyEvents + 900,
    }),
  };
}

function deviceSide(sessions: number, keyEvents: number): Side {
  return {
    device: [
      { key: ["mobile"], values: [sessions, 0, keyEvents] },
      { key: ["desktop"], values: [9_000, 0, 900] },
    ],
    totals: totals({ sessions: sessions + 9_000, keyEvents: keyEvents + 900 }),
  };
}

function pagesSide(views: number): Side {
  return {
    pages: [
      { key: ["/404?x=1", "Not found"], values: [views, 0] },
      { key: ["/shop", "Shop"], values: [1_000, 0] },
    ],
    totals: totals({ sessions: 5_000, screenPageViews: views + 1_000 }),
  };
}

function eventsSide(entered: number, completed: number): Side {
  const rows: GaTableRow[] = [
    { key: ["begin_checkout", "false"], values: [entered, 0] },
    { key: ["purchase", "true"], values: [completed, completed] },
  ];
  return { events: rows, totals: totals({ sessions: 20_000 }) };
}

function campaignSide(sessions: number, keyEvents: number): Side {
  return {
    campaign: [
      {
        key: ["spring", "newsletter", "email"],
        values: [sessions, 0, keyEvents, 0],
      },
    ],
    totals: totals({ sessions: sessions + 9_000, keyEvents: keyEvents + 900 }),
  };
}

const EXCLUDED_8 = Array.from(
  { length: 8 },
  (_, i) => `2026-08-${String(i + 1).padStart(2, "0")}`,
);

describe("evaluateGaOutcome — rate rules", () => {
  type Case = {
    name: string;
    ruleKey: GaRuleKey;
    evidence: GaFindingEvidence;
    worked: [Side, Side];
    didnt: [Side, Side];
    worse: [Side, Side];
    thin: [Side, Side];
  };
  const cases: Case[] = [
    {
      name: "AN3 cro",
      ruleKey: "AN3",
      evidence: an3("cro"),
      worked: [landingSide(1_000, 10), landingSide(1_000, 40)],
      didnt: [landingSide(1_000, 10), landingSide(1_000, 11)],
      worse: [landingSide(1_000, 30), landingSide(1_000, 5)],
      thin: [landingSide(100, 1), landingSide(100, 2)],
    },
    {
      name: "AN4 engagement",
      ruleKey: "AN4",
      evidence: an4("engagement"),
      worked: [channelSide(1_000, 300), channelSide(1_000, 450)],
      didnt: [channelSide(1_000, 300), channelSide(1_000, 310)],
      worse: [channelSide(1_000, 300), channelSide(1_000, 200)],
      thin: [channelSide(100, 30), channelSide(100, 35)],
    },
    {
      name: "AN4 key event rate",
      ruleKey: "AN4",
      evidence: an4("keyEventRate"),
      worked: [channelSide(1_000, 0, 10), channelSide(1_000, 0, 40)],
      didnt: [channelSide(1_000, 0, 10), channelSide(1_000, 0, 11)],
      worse: [channelSide(1_000, 0, 30), channelSide(1_000, 0, 5)],
      thin: [channelSide(150, 0, 1), channelSide(150, 0, 3)],
    },
    {
      name: "AN5",
      ruleKey: "AN5",
      evidence: an5,
      worked: [deviceSide(1_000, 10), deviceSide(1_000, 40)],
      didnt: [deviceSide(1_000, 10), deviceSide(1_000, 11)],
      worse: [deviceSide(1_000, 30), deviceSide(1_000, 5)],
      thin: [deviceSide(100, 1), deviceSide(100, 2)],
    },
    {
      name: "AN11",
      ruleKey: "AN11",
      evidence: an11,
      worked: [eventsSide(1_000, 400), eventsSide(1_000, 500)],
      didnt: [eventsSide(1_000, 400), eventsSide(1_000, 410)],
      worse: [eventsSide(1_000, 400), eventsSide(1_000, 300)],
      thin: [eventsSide(40, 10), eventsSide(40, 12)],
    },
    {
      name: "AN12",
      ruleKey: "AN12",
      evidence: an12,
      worked: [campaignSide(1_000, 10), campaignSide(1_000, 40)],
      didnt: [campaignSide(1_000, 10), campaignSide(1_000, 11)],
      worse: [campaignSide(1_000, 30), campaignSide(1_000, 5)],
      thin: [campaignSide(100, 1), campaignSide(100, 2)],
    },
  ];

  describe.each(cases)("$name", (c) => {
    it("WORKED", () => {
      const result = run(c.ruleKey, c.evidence, ...c.worked);
      expect(outcomeOf(result)).toBe("WORKED:worked");
      if (!result.wait) {
        expect(result.evidence.upliftPct).toBeGreaterThanOrEqual(10);
        expect(result.evidence.p).toBeLessThan(0.05);
        expect(result.evidence.before.from).toBe(BEFORE.from);
        expect(result.evidence.after.to).toBe(AFTER.to);
      }
    });
    it("DIDNT no_change", () => {
      expect(outcomeOf(run(c.ruleKey, c.evidence, ...c.didnt))).toBe(
        "DIDNT:no_change",
      );
    });
    it("DIDNT worse", () => {
      expect(outcomeOf(run(c.ruleKey, c.evidence, ...c.worse))).toBe(
        "DIDNT:worse",
      );
    });
    it("waits, then INCONCLUSIVE after grace", () => {
      expect(outcomeOf(run(c.ruleKey, c.evidence, ...c.thin))).toBe("wait");
      expect(outcomeOf(run(c.ruleKey, c.evidence, ...c.thin, true))).toBe(
        "INCONCLUSIVE:too_little_data",
      );
    });
    it(">7 excluded days is a tracking issue", () => {
      const [before, after] = c.worked;
      const result = run(
        c.ruleKey,
        c.evidence,
        { ...before, excludedDays: EXCLUDED_8 },
        after,
      );
      expect(outcomeOf(result)).toBe("INCONCLUSIVE:tracking_issue");
      if (!result.wait) {
        expect(result.evidence.before.sessions).toBeGreaterThan(0);
        expect(result.evidence.after.hits).toBeGreaterThan(0);
      }
      expect(
        outcomeOf(
          run(
            c.ruleKey,
            c.evidence,
            { ...before, excludedDays: EXCLUDED_8.slice(1) },
            after,
          ),
        ),
      ).toBe("WORKED:worked");
    });
  });

  it("a site change bigger than the subject's is DIDNT", () => {
    // sayfa +%30 (p < 0,05), sitenin geri kalanı +%50
    const result = run(
      "AN3",
      an3("cro"),
      landingSide(1_000, 100, 900),
      landingSide(1_000, 130, 1_350),
    );
    expect(outcomeOf(result)).toBe("DIDNT:no_change");
    if (!result.wait) {
      expect(result.evidence.upliftPct).toBeCloseTo(30, 8);
      expect(result.evidence.siteUpliftPct).toBeCloseTo(50, 8);
      expect(result.evidence.p).toBeLessThan(0.05);
      expect(result.evidence.siteBefore?.rate).toBeCloseTo(0.1, 10);
    }
  });

  it("funnel steps have no site control", () => {
    const result = run(
      "AN11",
      an11,
      eventsSide(1_000, 400),
      eventsSide(1_000, 500),
    );
    if (result.wait) throw new Error("unexpected wait");
    expect(result.evidence.siteBefore).toBeNull();
    expect(result.evidence.siteUpliftPct).toBeNull();
    expect(result.evidence.before).toMatchObject({
      sessions: 1_000,
      hits: 400,
      rate: 0.4,
    });
  });
});

describe("evaluateGaOutcome — AN3 promote", () => {
  function side(page: number, rest: number): Side {
    return {
      landing: [{ key: ["/p"], values: [page, 0, 5, 0, 0] }],
      totals: totals({ sessions: page + rest, keyEvents: 100 }),
    };
  }

  it("WORKED when page sessions grow ≥20% above the site", () => {
    const result = run(
      "AN3",
      an3("promote"),
      side(200, 9_800),
      side(400, 9_800),
    );
    expect(outcomeOf(result)).toBe("WORKED:worked");
    if (!result.wait) {
      expect(result.evidence.upliftPct).toBeCloseTo(100, 8);
      expect(result.evidence.siteUpliftPct).toBeCloseTo(0, 8);
      expect(result.evidence.before.sessions).toBe(200);
    }
  });

  it("site sessions growing as much is DIDNT", () => {
    expect(
      outcomeOf(
        run("AN3", an3("promote"), side(200, 9_800), side(400, 19_600)),
      ),
    ).toBe("DIDNT:no_change");
  });

  it("+15% is DIDNT, not WORKED", () => {
    expect(
      outcomeOf(
        run("AN3", an3("promote"), side(2_000, 9_800), side(2_300, 9_800)),
      ),
    ).toBe("DIDNT:no_change");
  });

  it("waits below 100 sessions before, then INCONCLUSIVE", () => {
    expect(
      outcomeOf(run("AN3", an3("promote"), side(50, 9_800), side(55, 9_800))),
    ).toBe("wait");
    expect(
      outcomeOf(
        run("AN3", an3("promote"), side(50, 9_800), side(55, 9_800), true),
      ),
    ).toBe("INCONCLUSIVE:too_little_data");
  });
});

describe("evaluateGaOutcome — AN9", () => {
  it("WORKED when views fall to ≤30%", () => {
    const result = run("AN9", an9, pagesSide(100), pagesSide(30));
    expect(outcomeOf(result)).toBe("WORKED:worked");
    if (!result.wait) {
      expect(result.evidence.before.hits).toBe(100);
      expect(result.evidence.after.hits).toBe(30);
    }
  });

  it("DIDNT otherwise", () => {
    expect(outcomeOf(run("AN9", an9, pagesSide(100), pagesSide(31)))).toBe(
      "DIDNT:no_change",
    );
  });

  it("INCONCLUSIVE when there were no views before", () => {
    expect(outcomeOf(run("AN9", an9, pagesSide(0), pagesSide(0)))).toBe(
      "INCONCLUSIVE:too_little_data",
    );
  });

  it("tracking issue wins", () => {
    expect(
      outcomeOf(
        run("AN9", an9, pagesSide(100), {
          ...pagesSide(10),
          excludedDays: EXCLUDED_8,
        }),
      ),
    ).toBe("INCONCLUSIVE:tracking_issue");
  });
});

describe("evaluateGaOutcome — not evaluable", () => {
  it("rules without an outcome metric never WORK", () => {
    const an8: An8Evidence = {
      v: 1,
      rule: "AN8",
      weeks: [],
      terms: [],
      totalSearches: 0,
      siteSessions: 0,
    };
    expect(outcomeOf(run("AN8", an8, {}, {}))).toBe("wait");
    expect(outcomeOf(run("AN8", an8, {}, {}, true))).toBe(
      "INCONCLUSIVE:too_little_data",
    );
    // kural anahtarıyla kanıt uyuşmuyor
    expect(outcomeOf(run("AN5", an9, {}, {}, true))).toBe(
      "INCONCLUSIVE:too_little_data",
    );
  });
});
