import { describe, expect, it } from "vitest";

import {
  expiryReason,
  measurementResolvable,
  nextFindingStatus,
  persistDecision,
  rangesOverlap,
  type GaFindingAction,
} from "./lifecycle";
import {
  GA_FINDING_STATUSES,
  type An1Evidence,
  type An2Evidence,
  type An15Evidence,
  type GaFindingSeverity,
  type GaFindingStatus,
} from "./types";

// Bu dosyanın kanıtladığı: geçiş matrisi; koşul kurallarında supersede,
// "stale", 56 günlük reddetme bastırması ve önem yükselmesi; olay
// kurallarında her dönemin kendi satırı; evaluable iş sürerken bastırma;
// TTL ve 60 günlük kabul süresi; ölçüm çözümü yalnız OPEN satırlarda ve
// kuralın bilmediği şüpheli günlerde.

const DAY = 86_400_000;
const now = new Date("2026-10-07T12:00:00Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * DAY);

describe("nextFindingStatus", () => {
  it("full transition matrix", () => {
    const expected: Record<
      GaFindingAction,
      Partial<
        Record<
          GaFindingStatus,
          [GaFindingStatus | null, GaFindingStatus | null]
        >
      >
    > = {
      // [evaluable, not evaluable]
      accept: { OPEN: ["ACCEPTED", "ACCEPTED"] },
      dismiss: {
        OPEN: ["DISMISSED", "DISMISSED"],
        ACCEPTED: ["DISMISSED", "DISMISSED"],
      },
      done: { ACCEPTED: ["DONE", null] },
    };
    for (const action of ["accept", "dismiss", "done"] as const) {
      for (const status of GA_FINDING_STATUSES) {
        const [whenEvaluable, otherwise] = expected[action][status] ?? [
          null,
          null,
        ];
        expect(nextFindingStatus(status, action, true)).toBe(whenEvaluable);
        expect(nextFindingStatus(status, action, false)).toBe(otherwise);
      }
    }
  });
});

function latest(
  status: GaFindingStatus,
  extra: Partial<{
    severity: GaFindingSeverity;
    dismissedAt: Date | null;
    evaluable: boolean;
    periodStart: string;
  }> = {},
) {
  return {
    status,
    severity: "WARN" as GaFindingSeverity,
    dismissedAt: null,
    evaluable: false,
    periodStart: "2026-09-21",
    ...extra,
  };
}

const candidate = {
  severity: "WARN" as GaFindingSeverity,
  periodStart: "2026-09-28",
};

describe("persistDecision: condition rules", () => {
  const decide = (l: ReturnType<typeof latest> | null, c = candidate) =>
    persistDecision({ recurrence: "condition", latest: l, candidate: c, now });

  it("creates without history and supersedes an OPEN row", () => {
    expect(decide(null)).toBe("create");
    expect(decide(latest("OPEN"))).toBe("supersede");
  });

  it("is stale for an older period", () => {
    expect(
      decide(latest("OPEN"), { ...candidate, periodStart: "2026-09-14" }),
    ).toBe("stale");
  });

  it("dismiss suppresses for 56 days unless severity escalates", () => {
    expect(decide(latest("DISMISSED", { dismissedAt: daysAgo(10) }))).toBe(
      "suppress",
    );
    expect(decide(latest("DISMISSED", { dismissedAt: daysAgo(56) }))).toBe(
      "suppress",
    );
    expect(
      decide(
        latest("DISMISSED", {
          dismissedAt: new Date(daysAgo(56).getTime() - 1),
        }),
      ),
    ).toBe("create");
    expect(
      decide(latest("DISMISSED", { dismissedAt: daysAgo(10) }), {
        ...candidate,
        severity: "CRITICAL",
      }),
    ).toBe("create");
    expect(
      decide(latest("DISMISSED", { dismissedAt: daysAgo(10) }), {
        ...candidate,
        severity: "INFO",
      }),
    ).toBe("suppress");
  });

  it("creates after closed rows and non-evaluable accepts", () => {
    for (const status of [
      "EVALUATED",
      "EXPIRED",
      "SUPERSEDED",
      "RESOLVED",
    ] as const) {
      expect(decide(latest(status))).toBe("create");
    }
    expect(decide(latest("ACCEPTED", { evaluable: false }))).toBe("create");
  });
});

describe("persistDecision: event rules", () => {
  const decide = (l: ReturnType<typeof latest> | null, c = candidate) =>
    persistDecision({ recurrence: "event", latest: l, candidate: c, now });

  it("AN1 after a dismissed AN1 row creates a new row", () => {
    expect(decide(latest("DISMISSED", { dismissedAt: daysAgo(1) }))).toBe(
      "create",
    );
    expect(decide(latest("OPEN"))).toBe("create");
  });

  it("an older-period AN1 still creates", () => {
    expect(
      decide(latest("OPEN"), { ...candidate, periodStart: "2026-09-01" }),
    ).toBe("create");
  });
});

describe("persistDecision: work in progress", () => {
  it("evaluable ACCEPTED or DONE suppresses both recurrences", () => {
    for (const recurrence of ["event", "condition"] as const) {
      for (const status of ["ACCEPTED", "DONE"] as const) {
        expect(
          persistDecision({
            recurrence,
            latest: latest(status, { evaluable: true }),
            candidate,
            now,
          }),
        ).toBe("suppress");
      }
    }
  });
});

describe("expiryReason", () => {
  const base = {
    status: "OPEN" as GaFindingStatus,
    acceptedAt: null,
    doneAt: null,
    evaluable: false,
    periodEnd: "2026-10-04",
    today: "2026-10-07",
    now,
  };

  it("OPEN rows expire after the rule TTL", () => {
    expect(
      expiryReason({ ...base, ruleKey: "AN1", createdAt: daysAgo(7) }),
    ).toBeNull();
    expect(
      expiryReason({
        ...base,
        ruleKey: "AN1",
        createdAt: new Date(daysAgo(7).getTime() - 1),
      }),
    ).toBe("ttl");
    expect(
      expiryReason({ ...base, ruleKey: "AN3", createdAt: daysAgo(20) }),
    ).toBeNull();
    expect(
      expiryReason({ ...base, ruleKey: "AN3", createdAt: daysAgo(29) }),
    ).toBe("ttl");
    expect(
      expiryReason({ ...base, ruleKey: "AN10", createdAt: daysAgo(34) }),
    ).toBeNull();
    expect(
      expiryReason({ ...base, ruleKey: "AN10", createdAt: daysAgo(36) }),
    ).toBe("ttl");
  });

  it("AN15 expires after month end", () => {
    const an15 = {
      ...base,
      ruleKey: "AN15" as const,
      createdAt: daysAgo(2),
      periodEnd: "2026-10-31",
    };
    expect(expiryReason({ ...an15, today: "2026-10-31" })).toBeNull();
    expect(expiryReason({ ...an15, today: "2026-11-01" })).toBe("ttl");
    // Dönem sonu gelmediyse 31 günden eski de olsa açık kalır.
    expect(
      expiryReason({ ...an15, createdAt: daysAgo(40), today: "2026-10-20" }),
    ).toBeNull();
  });

  it("ACCEPTED without Done expires after 60 days, evaluable or not", () => {
    for (const evaluable of [true, false]) {
      const accepted = {
        ...base,
        ruleKey: "AN3" as const,
        status: "ACCEPTED" as GaFindingStatus,
        createdAt: daysAgo(100),
        evaluable,
      };
      expect(expiryReason({ ...accepted, acceptedAt: daysAgo(59) })).toBeNull();
      expect(expiryReason({ ...accepted, acceptedAt: daysAgo(61) })).toBe(
        "ttl",
      );
      expect(
        expiryReason({
          ...accepted,
          acceptedAt: daysAgo(61),
          doneAt: daysAgo(30),
        }),
      ).toBeNull();
    }
  });

  it("other statuses never expire", () => {
    for (const status of [
      "DONE",
      "DISMISSED",
      "EVALUATED",
      "SUPERSEDED",
    ] as const) {
      expect(
        expiryReason({
          ...base,
          status,
          ruleKey: "AN1",
          createdAt: daysAgo(400),
        }),
      ).toBeNull();
    }
  });
});

const an1: An1Evidence = {
  v: 1,
  rule: "AN1",
  mode: "day",
  target: "2026-10-05",
  readings: [],
  primary: "sessions",
  excludedDays: [],
  breakdown: null,
  seasonalChecked: true,
  preliminary: false,
};

const decomposition = {
  metric: "sessions" as const,
  dimension: "channel" as const,
  before: 100,
  after: 80,
  delta: -20,
  perDay: false,
  components: [],
  other: null,
  residual: -20,
};

const an2: An2Evidence = {
  v: 1,
  rule: "AN2",
  comparison: "wow",
  metric: "sessions",
  metricReason: "low_key_events",
  current: { from: "2026-09-28", to: "2026-10-04", days: 7, total: 80 },
  previous: { from: "2026-09-21", to: "2026-09-27", days: 7, total: 100 },
  change: -20,
  changePct: -20,
  z: -2,
  p: 0.04,
  channels: decomposition,
  pages: null,
  holidays: [],
  suspectDays: ["2026-09-22"],
  seasonal: null,
  preliminary: false,
};

const an15: An15Evidence = {
  v: 1,
  rule: "AN15",
  goalId: "g1",
  goalTitle: "Leads",
  metricKey: "web.key_events",
  month: "2026-10",
  target: 100,
  monthToDate: 10,
  forecast: 40,
  paceRatio: 0.4,
  dayOfMonth: 7,
  daysInMonth: 31,
  through: "2026-10-07",
};

describe("measurementResolvable", () => {
  const day = { from: "2026-10-05", to: "2026-10-05" };

  it("AN1 day mode: the target became suspect", () => {
    expect(
      measurementResolvable({
        ruleKey: "AN1",
        status: "OPEN",
        evidence: an1,
        period: day,
        suspect: new Set(["2026-10-05"]),
      }),
    ).toBe(true);
    expect(
      measurementResolvable({
        ruleKey: "AN1",
        status: "OPEN",
        evidence: an1,
        period: day,
        suspect: new Set(["2026-10-04"]),
      }),
    ).toBe(false);
  });

  it("AN1 week mode: any day of the week", () => {
    const week = { from: "2026-09-28", to: "2026-10-04" };
    expect(
      measurementResolvable({
        ruleKey: "AN1",
        status: "OPEN",
        evidence: { ...an1, mode: "week", target: "2026-09-28" },
        period: week,
        suspect: new Set(["2026-10-01"]),
      }),
    ).toBe(true);
  });

  it("never for accepted rows or window rules", () => {
    expect(
      measurementResolvable({
        ruleKey: "AN1",
        status: "ACCEPTED",
        evidence: an1,
        period: day,
        suspect: new Set(["2026-10-05"]),
      }),
    ).toBe(false);
    expect(
      measurementResolvable({
        ruleKey: "AN3",
        status: "OPEN",
        evidence: an1,
        period: day,
        suspect: new Set(["2026-10-05"]),
      }),
    ).toBe(false);
  });

  it("AN2 ignores suspect days already in its evidence", () => {
    const period = { from: "2026-09-28", to: "2026-10-04" };
    expect(
      measurementResolvable({
        ruleKey: "AN2",
        status: "OPEN",
        evidence: an2,
        period,
        suspect: new Set(["2026-09-22"]),
      }),
    ).toBe(false);
    expect(
      measurementResolvable({
        ruleKey: "AN2",
        status: "OPEN",
        evidence: an2,
        period,
        suspect: new Set(["2026-09-22", "2026-09-23"]),
      }),
    ).toBe(true);
  });

  it("AN9 by week and AN15 up to evidence.through", () => {
    expect(
      measurementResolvable({
        ruleKey: "AN9",
        status: "OPEN",
        evidence: an1,
        period: { from: "2026-09-28", to: "2026-10-04" },
        suspect: new Set(["2026-09-30"]),
      }),
    ).toBe(true);
    const month = { from: "2026-10-01", to: "2026-10-31" };
    expect(
      measurementResolvable({
        ruleKey: "AN15",
        status: "OPEN",
        evidence: an15,
        period: month,
        suspect: new Set(["2026-10-03"]),
      }),
    ).toBe(true);
    expect(
      measurementResolvable({
        ruleKey: "AN15",
        status: "OPEN",
        evidence: an15,
        period: month,
        suspect: new Set(["2026-10-20"]),
      }),
    ).toBe(false);
  });
});

describe("rangesOverlap", () => {
  it("returns sorted unique days inside the range", () => {
    expect(
      rangesOverlap({ from: "2026-10-01", to: "2026-10-03" }, [
        "2026-10-03",
        "2026-09-30",
        "2026-10-01",
        "2026-10-03",
      ]),
    ).toEqual(["2026-10-01", "2026-10-03"]);
  });
});
