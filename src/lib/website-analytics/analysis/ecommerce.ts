import type { GaTableRow } from "@/lib/website-analytics/slices";

import { GaSubjects, periodOf } from "./keys";
import { GA_RATIO_EPSILON } from "./landing-pages";
import { twoProportionTest } from "./stats";
import type {
  An11Evidence,
  GaFindingCandidate,
  GaWeeklyAnalysisInput,
  GaWindowTables,
} from "./types";

// GA-F4 AN11 e-ticaret hunisi (docs/website-insights.md): son haftada bir
// huni adımının geçiş oranı, şüpheli günü olmayan önceki 4 haftanın birleşik
// oranından en az %20 düştüyse (iki oran testi p < 0,05). Olay kuralı:
// her hafta kendi satırı. Sepet ortalaması (AOV) yalnız kanıta yazılır;
// değişimi ertelendi (GA_DEFERRED_RULES "AN11-AOV"). Saf modül, hata atmaz.

export const FUNNEL_STEPS = [
  "view_item",
  "add_to_cart",
  "begin_checkout",
  "purchase",
] as const;

const BASELINE_WEEKS = 4;
const MIN_BASELINE_WEEKS = 2;
const MIN_ENTERED = 50;
const MIN_DROP_PCT = 20;
const SIGNIFICANT_P = 0.05;

// events tablosunda ([eventName, isKeyEvent] × [eventCount, keyEvents]) bir
// olayın toplam sayısı (anahtar olay olsa da olmasa da).
export function eventCount(rows: readonly GaTableRow[], name: string): number {
  return rows.reduce(
    (sum, row) => (row.key[0] === name ? sum + (row.values[0] ?? 0) : sum),
    0,
  );
}

// Adım geçişi: giren = önceki adımın sayısı, tamamlayan en çok giren kadar.
export function funnelStep(
  events: readonly GaTableRow[],
  from: string,
  to: string,
): { entered: number; completed: number } {
  const entered = eventCount(events, from);
  return { entered, completed: Math.min(eventCount(events, to), entered) };
}

function aovOf(tables: readonly GaWindowTables[]): number | null {
  const revenue = tables.reduce((sum, t) => sum + t.totals.revenue, 0);
  const transactions = tables.reduce(
    (sum, t) => sum + t.totals.transactions,
    0,
  );
  return transactions > 0 ? revenue / transactions : null;
}

export function evaluateFunnel(
  input: GaWeeklyAnalysisInput,
): GaFindingCandidate | null {
  const current = input.weeks[input.weeks.length - 1];
  if (!current) return null;
  const baseline = input.weeks
    .slice(0, -1)
    .slice(-BASELINE_WEEKS)
    .filter((week) => week.excludedDays.length === 0);
  if (baseline.length < MIN_BASELINE_WEEKS) return null;

  let worst: An11Evidence["step"] | null = null;
  for (let index = 0; index + 1 < FUNNEL_STEPS.length; index += 1) {
    const from = FUNNEL_STEPS[index]!;
    const to = FUNNEL_STEPS[index + 1]!;
    const now = funnelStep(current.events, from, to);
    // Taban haftalar birleştirilir; her hafta kendi içinde sınırlanır.
    const base = baseline.reduce(
      (sum, week) => {
        const step = funnelStep(week.events, from, to);
        return {
          entered: sum.entered + step.entered,
          completed: sum.completed + step.completed,
        };
      },
      { entered: 0, completed: 0 },
    );
    if (now.entered < MIN_ENTERED || base.entered < MIN_ENTERED) continue;
    const rate = now.completed / now.entered;
    const baselineRate = base.completed / base.entered;
    if (baselineRate <= 0) continue;
    const dropPct = ((baselineRate - rate) / baselineRate) * 100;
    if (dropPct < MIN_DROP_PCT - GA_RATIO_EPSILON) continue;
    const p = twoProportionTest(
      now.completed,
      now.entered,
      base.completed,
      base.entered,
    )?.p;
    if (p === undefined || !(p < SIGNIFICANT_P)) continue;
    if (worst && worst.dropPct >= dropPct) continue;
    worst = {
      from,
      to,
      current: { ...now, rate },
      baseline: { ...base, rate: baselineRate },
      p,
      dropPct,
    };
  }
  if (!worst) return null;

  const week = { from: input.week.monday, to: input.week.sunday };
  const lost =
    (worst.baseline.rate - worst.current.rate) * worst.current.entered;
  const evidence: An11Evidence = {
    v: 1,
    rule: "AN11",
    week,
    baselineWeeks: baseline.map((t) => t.from),
    step: worst,
    aov: { current: aovOf([current]), baseline: aovOf(baseline) },
  };
  return {
    ruleKey: "AN11",
    kind: "RISK",
    subject: GaSubjects.funnel(worst.from, worst.to),
    period: periodOf("WEEK", week),
    severity: worst.to === "purchase" ? "WARN" : "INFO",
    confidence: "SIGNIFICANT",
    evidence,
    impact: {
      metric: "purchases",
      perWeek: lost,
      low: lost,
      high: lost,
      directional: false,
    },
    impactShare: Math.min(1, worst.dropPct / 100),
  };
}
