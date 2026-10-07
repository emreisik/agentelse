import {
  decideOutcome,
  didMetricFor,
  differenceInDifferences,
  windowTotals,
  type PageSeries,
} from "@/lib/seo/actions/did";
import { ACTION_WINDOW_DAYS } from "@/lib/seo/actions/lifecycle";
import type {
  DidMetric,
  EvaluationReason,
  SeoFixKind,
} from "@/lib/seo/actions/types";
import type { EvaluationWindows } from "@/lib/seo/actions/windows";
import type { CtrCurve } from "@/lib/seo/ctr-curve";

import { SPLIT_MIN_ARM_TOTAL, SPLIT_RECOMMENDED_ARM } from "./assign";
import type { SplitChangeKind, SplitEvaluation, SplitPlacebo } from "./types";

// Bölünmüş test değerlendirmesi (docs/google-search-console-plan.md §6.4,
// SC-F9). SC-F6 fark-farkını yeniden kullanır: her TEST sayfası işlenen, her
// CONTROL sayfası kontrol serisidir; SC-F6 işlenenleri haftalık toplar,
// kontrolleri yeniden örnekleyip toplar. Kollar kurulum gereği dengeli
// olduğundan toplama simetriktir; fark yalnız işlenen sayfaların
// yeniden örneklenmemesidir. Bunu PLASEBO (A/A) denetimi telafi eder: önceki
// haftalar ikiye bölünür, aynı iki kolla "etki" ölçülür, mutlak değeri aralığın
// iki ucuna payanda olarak eklenir, aralığı sıfırı dışlayan plasebo sonucu
// kararsız yapar (PRE_TREND). Saf; Math.random yok.

// Bir kolun değerlendirmeye girebilmesi için gereken en az kullanılabilir sayfa.
export const SPLIT_MIN_USABLE_PAGES = 20;
// Kontrol tarafında en az sayfa (altında NO_DATA).
export const SPLIT_MIN_CONTROL_PAGES = 3;
const MAIN_SAMPLES = 1000;
const PLACEBO_SAMPLES = 300;
const PLACEBO_MIN_WEEKS = 4;

const FIX_KIND: Readonly<Record<SplitChangeKind, SeoFixKind>> = {
  TITLE_META: "TITLE_META",
  SCHEMA: "SCHEMA",
  INTERNAL_LINKS_BLOCK: "INTERNAL_LINKS",
  CONTENT_BLOCK: "CONTENT_REFRESH",
  TEMPLATE_CHANGE: "TECH_FIX",
  OTHER: "TECH_FIX",
};

export function splitFixKind(kind: SplitChangeKind): SeoFixKind {
  return FIX_KIND[kind];
}

// Ölçüt SC-F6 tablosundan türer (sert kodlanmaz); bilinmeyen tür tıklamadır.
export function splitMetric(kind: SplitChangeKind): DidMetric {
  return didMetricFor(splitFixKind(kind)) ?? "clicks";
}

export function splitWindowDays(kind: SplitChangeKind): number {
  return ACTION_WINDOW_DAYS[splitFixKind(kind)];
}

export type SplitEvaluationInput = {
  kind: SplitChangeKind;
  test: readonly PageSeries[];
  control: readonly PageSeries[];
  windows: EvaluationWindows;
  curve: CtrCurve;
  seed: string;
  overlap: boolean;
  truncated: boolean;
  assigned: { test: number; control: number };
  excluded: number;
  updates: SplitEvaluation["updates"];
  now: Date;
};

export function evaluateSplit(input: SplitEvaluationInput): SplitEvaluation {
  const { windows, curve } = input;
  const metric = splitMetric(input.kind);
  const preWeeks = windows.preWeeks;
  const postWeeks = windows.postWeeks;
  const usedTest = input.test.length;
  const usedControl = input.control.length;

  const base: SplitEvaluation = {
    v: 1,
    method: "DID",
    metric,
    anchorDay: windows.anchorDay,
    preWeeks,
    postWeeks,
    testPages: input.assigned.test,
    controlPages: input.assigned.control,
    usedTest,
    usedControl,
    excluded: input.excluded,
    effect: null,
    low: null,
    high: null,
    placebo: null,
    treated: null,
    control: null,
    updates: input.updates,
    truncated: input.truncated,
    reason: null,
    outcome: "INCONCLUSIVE",
    confidence: "DIRECTIONAL",
    evaluatedAt: input.now.toISOString(),
  };
  const inconclusive = (reason: EvaluationReason | "PRE_TREND") => ({
    ...base,
    reason,
  });

  if (usedControl < SPLIT_MIN_CONTROL_PAGES || usedTest === 0) {
    return inconclusive("NO_DATA");
  }
  if (
    usedTest < SPLIT_MIN_USABLE_PAGES ||
    usedControl < SPLIT_MIN_USABLE_PAGES
  ) {
    return inconclusive("LOW_DATA");
  }

  const result = differenceInDifferences({
    treated: input.test,
    controls: input.control,
    method: "DID",
    preWeeks,
    postWeeks,
    metric,
    curve,
    seed: input.seed,
    samples: MAIN_SAMPLES,
  });

  // Plasebo: aynı kollar, önceki haftaların ilk yarısı "önce", ikincisi "sonra".
  let placebo: SplitPlacebo | null = null;
  let padding = 0;
  if (preWeeks.length >= PLACEBO_MIN_WEEKS) {
    const half = Math.floor(preWeeks.length / 2);
    const run = differenceInDifferences({
      treated: input.test,
      controls: input.control,
      method: "DID",
      preWeeks: preWeeks.slice(0, half),
      postWeeks: preWeeks.slice(half),
      metric,
      curve,
      seed: `${input.seed}:placebo`,
      samples: PLACEBO_SAMPLES,
    });
    padding = run ? Math.abs(run.effect) : 0;
    placebo = {
      effect: run ? run.effect : null,
      low: run ? run.low : null,
      high: run ? run.high : null,
      passed: run ? !(run.low > 0 || run.high < 0) : true,
      padding,
    };
  }

  const padded = result
    ? { ...result, low: result.low - padding, high: result.high + padding }
    : null;
  const pre = windowTotals(input.test, preWeeks, curve);
  const treated = {
    before: pre,
    after: windowTotals(input.test, postWeeks, curve),
  };
  const control = {
    before: windowTotals(input.control, preWeeks, curve),
    after: windowTotals(input.control, postWeeks, curve),
  };
  const filled: SplitEvaluation = {
    ...base,
    effect: padded ? padded.effect : null,
    low: padded ? padded.low : null,
    high: padded ? padded.high : null,
    placebo,
    treated,
    control,
  };

  // Kollar daha önce de farklı hareket ettiyse etki değişikliğe bağlanamaz.
  if (placebo && !placebo.passed) {
    return { ...filled, reason: "PRE_TREND" };
  }

  const decision = decideOutcome({
    result: padded,
    method: "DID",
    metric,
    preClicks: pre.clicks,
    preImpressions: pre.impressions,
    overlap: input.overlap,
    overlappingChange: false,
    truncated: input.truncated,
  });
  const smallArms =
    Math.min(input.assigned.test, input.assigned.control) <
      SPLIT_RECOMMENDED_ARM ||
    usedTest < SPLIT_MIN_ARM_TOTAL ||
    usedControl < SPLIT_MIN_ARM_TOTAL;
  return {
    ...filled,
    reason: decision.reason,
    outcome: decision.outcome,
    confidence:
      decision.confidence === "SIGNIFICANT" && smallArms
        ? "DIRECTIONAL"
        : decision.confidence,
  };
}
