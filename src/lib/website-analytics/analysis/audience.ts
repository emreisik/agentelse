import { GaSubjects, periodOf } from "./keys";
import { twoProportionTest } from "./stats";
import type {
  An6Evidence,
  GaFindingCandidate,
  GaWeeklyAnalysisInput,
  GaWindowTables,
} from "./types";

// AN6: geri gelen ziyaretçi payı düşüyor (docs/google-analytics-plan.md
// §6.2; ayrıntı docs/website-insights.md "AN6"). Ölçü new_returning DAY
// dilimlerinin OTURUMLARIDIR: günlük activeUsers kullanıcı-gündür, haftalık
// tekil kullanıcıya toplanamaz. 8 haftanın ilk ikisi ile son ikisi
// karşılaştırılır; her hafta ≥ 500 oturum ister, düşüş ≥ 5 puan olmalı.
// Oturum payı olduğundan (isabet ≤ deneme) iki oran z-testi kullanılır. Saf.

const WEEKS = 8;
const MIN_WEEK_SESSIONS = 500;
const MIN_DROP_POINTS = 5;
const P_THRESHOLD = 0.05;
// Kayan nokta payı: 5.0 puan sınırı tam 5 olarak okunur.
const EPSILON = 1e-9;
// newReturning: [newVsReturning] × [activeUsers, sessions, keyEvents]
const SESSIONS_INDEX = 1;

function weekShare(tables: GaWindowTables): {
  monday: string;
  returning: number;
  total: number;
  share: number;
} {
  let returning = 0;
  let total = 0;
  for (const row of tables.newReturning) {
    const kind = row.key[0];
    const sessions = row.values[SESSIONS_INDEX] ?? 0;
    if (!Number.isFinite(sessions)) continue;
    if (kind === "returning") {
      returning += sessions;
      total += sessions;
    } else if (kind === "new") {
      total += sessions;
    }
  }
  return {
    monday: tables.from,
    returning,
    total,
    share: total > 0 ? returning / total : 0,
  };
}

export function evaluateReturningShare(
  input: GaWeeklyAnalysisInput,
): GaFindingCandidate | null {
  if (input.weeks.length < WEEKS) return null;
  const weeks = input.weeks.slice(-WEEKS).map(weekShare);
  if (weeks.some((week) => week.total < MIN_WEEK_SESSIONS)) return null;

  const pooled = (from: number, to: number) => {
    const slice = weeks.slice(from, to);
    return {
      returning: slice.reduce((sum, week) => sum + week.returning, 0),
      total: slice.reduce((sum, week) => sum + week.total, 0),
    };
  };
  const early = pooled(0, 2);
  const late = pooled(WEEKS - 2, WEEKS);
  const earlyShare = early.returning / early.total;
  const lateShare = late.returning / late.total;
  const dropPoints = (earlyShare - lateShare) * 100;
  if (dropPoints < MIN_DROP_POINTS - EPSILON) return null;

  const test = twoProportionTest(
    late.returning,
    late.total,
    early.returning,
    early.total,
  );
  const p = test?.p ?? null;
  const evidence: An6Evidence = {
    v: 1,
    rule: "AN6",
    weeks,
    earlyShare,
    lateShare,
    dropPoints,
    p,
  };
  return {
    ruleKey: "AN6",
    kind: "RISK",
    subject: GaSubjects.returning(),
    period: periodOf("WEEK", {
      from: input.week.monday,
      to: input.week.sunday,
    }),
    severity: "INFO",
    confidence: p !== null && p < P_THRESHOLD ? "SIGNIFICANT" : "DIRECTIONAL",
    evidence,
    impact: null,
    impactShare: dropPoints / 100,
  };
}
