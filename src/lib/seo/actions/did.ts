import { expectedCtr, type CtrCurve } from "@/lib/seo/ctr-curve";

import { yearAgoWeeks } from "./windows";
import type {
  DidMetric,
  EvaluationReason,
  MetricWindow,
  SeoActionConfidence,
  SeoFixKind,
  SeoOutcome,
} from "./types";

// Fark-farkı (difference-in-differences) ve haftalık bootstrap
// (docs/google-search-console-plan.md §6.4, SC-F6). Ambar sayfa ölçümlerini
// yalnız haftalık tuttuğu için seriler haftalıktır: bootstrap önceki
// haftaları, sonraki haftaları ve kontrol sayfalarını yerine koyarak
// yeniden örnekler (kayıtlı sapma: plandaki "günler üzerinde" yerine
// haftalar). Geniş aralık kararı INCONCLUSIVE'e yaklaştırır; bu muhafazakâr
// yöndür. Saf; Math.random yok, tohum eylem kimliğinden gelir.

export type WeekMetric = {
  weekStart: string;
  clicks: number;
  impressions: number;
  positionWeighted: number;
};

// Eksik haftalar sıfır sayılır.
export type PageSeries = { pageId: string; weeks: WeekMetric[] };

export const BOOTSTRAP_SAMPLES = 1000;
export const INTERVAL_LOW_Q = 0.05;
export const INTERVAL_HIGH_Q = 0.95;
export const WORKED_MIN_EFFECT = 0.1;
export const DIDNT_MAX_HIGH = 0.05;
export const MIN_CONTROLS = 3;
export const MAX_CONTROLS = 10;
export const CONTROL_BAND = 0.5;
export const LOW_DATA_IMPRESSIONS = 100;
export const LOW_DATA_CLICKS = 10;
export const SIGNIFICANT_PRE_CLICKS = 30;
export const SIGNIFICANT_PRE_IMPRESSIONS = 500;

type DidMethod = "DID" | "DID_SITE" | "PRE_POST";

export function didMetricFor(kind: SeoFixKind): DidMetric | null {
  switch (kind) {
    case "TITLE_META":
    case "SCHEMA":
      return "ctr_adj";
    case "CONTENT_REFRESH":
    case "CONSOLIDATE":
      return "clicks";
    case "INTERNAL_LINKS":
    case "TECH_FIX":
      return "impressions";
    default:
      return null;
  }
}

// FNV-1a 32 ile tohumlanan mulberry32.
export function seededRandom(seed: string): () => number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  let state = hash >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Tip 7 (doğrusal ara değerli) kantil; sıralı girdi bekler.
export function quantile(sortedAscending: readonly number[], q: number): number {
  const n = sortedAscending.length;
  if (n === 0) return 0;
  if (n === 1) return sortedAscending[0] ?? 0;
  const h = (n - 1) * Math.min(1, Math.max(0, q));
  const lower = Math.floor(h);
  const upper = Math.ceil(h);
  const a = sortedAscending[lower] ?? 0;
  const b = sortedAscending[upper] ?? a;
  return a + (h - lower) * (b - a);
}

export function alignWeeks(
  series: PageSeries,
  weeks: readonly string[],
): WeekMetric[] {
  const byWeek = new Map<string, WeekMetric>();
  for (const week of series.weeks) byWeek.set(week.weekStart, week);
  return weeks.map(
    (weekStart) =>
      byWeek.get(weekStart) ?? {
        weekStart,
        clicks: 0,
        impressions: 0,
        positionWeighted: 0,
      },
  );
}

// Haftalık toplamlar: tıklama, gösterim ve konuma göre beklenen tıklama
// (sayfa-hafta başına gösterim × beklenen CTR). Oranlar ortalanmaz, toplanır.
type Totals = { clicks: number[]; impressions: number[]; expected: number[] };

function totalsFor(
  series: readonly PageSeries[],
  weeks: readonly string[],
  curve: CtrCurve,
): Totals {
  const totals: Totals = {
    clicks: weeks.map(() => 0),
    impressions: weeks.map(() => 0),
    expected: weeks.map(() => 0),
  };
  for (const page of series) {
    alignWeeks(page, weeks).forEach((week, index) => {
      totals.clicks[index]! += week.clicks;
      totals.impressions[index]! += week.impressions;
      if (week.impressions > 0) {
        totals.expected[index]! +=
          week.impressions *
          expectedCtr(curve, week.positionWeighted / week.impressions);
      }
    });
  }
  return totals;
}

function logValue(
  metric: DidMetric,
  clicks: number,
  impressions: number,
  expected: number,
): number {
  if (metric === "clicks") return Math.log(clicks + 1);
  if (metric === "impressions") return Math.log(impressions + 1);
  return Math.log((clicks + 0.5) / (expected + 0.5));
}

export function windowTotals(
  series: readonly PageSeries[],
  weeks: readonly string[],
  curve: CtrCurve,
): MetricWindow {
  const totals = totalsFor(series, weeks, curve);
  let clicks = 0;
  let impressions = 0;
  let expected = 0;
  let weighted = 0;
  for (const page of series) {
    for (const week of alignWeeks(page, weeks)) {
      weighted += week.positionWeighted;
    }
  }
  weeks.forEach((_, index) => {
    clicks += totals.clicks[index] ?? 0;
    impressions += totals.impressions[index] ?? 0;
    expected += totals.expected[index] ?? 0;
  });
  return {
    weeks: weeks.length,
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : null,
    position: impressions > 0 ? weighted / impressions : null,
    ctrAdj: expected > 0 ? clicks / expected : null,
  };
}

// Kontrol seçiminin ölçüsü: tıklama (ctr_adj ve clicks) ya da gösterim.
export function controlBasis(
  series: PageSeries,
  preWeeks: readonly string[],
  metric: DidMetric,
): number {
  let sum = 0;
  for (const week of alignWeeks(series, preWeeks)) {
    sum += metric === "impressions" ? week.impressions : week.clicks;
  }
  return sum;
}

export type ControlSelection = { method: DidMethod; controls: PageSeries[] };

function weeksWithImpressions(
  series: PageSeries,
  weeks: readonly string[],
): number {
  return alignWeeks(series, weeks).filter((week) => week.impressions > 0)
    .length;
}

export function selectControls(input: {
  treated: readonly PageSeries[];
  candidates: readonly PageSeries[];
  excluded: ReadonlySet<string>;
  preWeeks: readonly string[];
  metric: DidMetric;
}): ControlSelection {
  const { preWeeks, metric } = input;
  const treatedIds = new Set(input.treated.map((series) => series.pageId));
  const needed = Math.ceil(preWeeks.length / 2);
  const treatedBasis = input.treated.reduce(
    (sum, series) => sum + controlBasis(series, preWeeks, metric),
    0,
  );
  const eligible = input.candidates
    .filter(
      (series) =>
        !treatedIds.has(series.pageId) &&
        !input.excluded.has(series.pageId) &&
        weeksWithImpressions(series, preWeeks) >= needed,
    )
    .map((series) => {
      const basis = controlBasis(series, preWeeks, metric);
      const distance =
        treatedBasis > 0 && basis > 0
          ? Math.abs(Math.log(basis / treatedBasis))
          : Number.POSITIVE_INFINITY;
      return { series, basis, distance };
    })
    .sort(
      (a, b) =>
        a.distance - b.distance ||
        (a.series.pageId < b.series.pageId
          ? -1
          : a.series.pageId > b.series.pageId
            ? 1
            : 0),
    );
  const low = treatedBasis * (1 - CONTROL_BAND);
  const high = treatedBasis * (1 + CONTROL_BAND);
  const inBand =
    treatedBasis > 0
      ? eligible.filter((item) => item.basis >= low && item.basis <= high)
      : [];
  if (inBand.length >= MIN_CONTROLS) {
    return {
      method: "DID",
      controls: inBand.slice(0, MAX_CONTROLS).map((item) => item.series),
    };
  }
  if (eligible.length > 0) {
    return { method: "DID_SITE", controls: eligible.map((item) => item.series) };
  }
  return { method: "PRE_POST", controls: [] };
}

export type DidInput = {
  treated: readonly PageSeries[];
  controls: readonly PageSeries[];
  method: DidMethod;
  preWeeks: readonly string[];
  postWeeks: readonly string[];
  metric: DidMetric;
  curve: CtrCurve;
  seed: string;
  samples?: number;
  // Yalnız PRE_POST: işlem görenin geçen yılki serisi (yearAgoWeeks(pre ∪ post)
  // haftalarına hizalı).
  yearAgo?: readonly PageSeries[];
};

export type DidResult = {
  effect: number;
  low: number;
  high: number;
  logEffect: number;
  samples: number;
  yoyAdjusted: boolean;
};

function mean(values: Float64Array, indices: readonly number[]): number {
  let sum = 0;
  for (const index of indices) sum += values[index] ?? 0;
  return indices.length > 0 ? sum / indices.length : 0;
}

export function differenceInDifferences(input: DidInput): DidResult | null {
  const { preWeeks, postWeeks, metric, curve } = input;
  if (preWeeks.length === 0 || postWeeks.length === 0) return null;
  const weeks = [...preWeeks, ...postWeeks];
  const size = weeks.length;
  const preIndices = preWeeks.map((_, index) => index);
  const postIndices = postWeeks.map((_, index) => preWeeks.length + index);
  const samples = Math.max(1, input.samples ?? BOOTSTRAP_SAMPLES);

  const treated = totalsFor(input.treated, weeks, curve);
  const treatedValues = new Float64Array(size);
  for (let i = 0; i < size; i += 1) {
    treatedValues[i] = logValue(
      metric,
      treated.clicks[i]!,
      treated.impressions[i]!,
      treated.expected[i]!,
    );
  }

  const usesControls = input.method !== "PRE_POST";
  // PRE_POST için sabit referans: geçen yıl (varsa) ya da sıfır.
  const fixedReference = new Float64Array(size);
  let yoyAdjusted = false;
  if (!usesControls && input.yearAgo) {
    const ago = totalsFor(input.yearAgo, yearAgoWeeks(weeks), curve);
    for (let i = 0; i < size; i += 1) {
      fixedReference[i] = logValue(
        metric,
        ago.clicks[i]!,
        ago.impressions[i]!,
        ago.expected[i]!,
      );
    }
    yoyAdjusted = true;
  }
  if (usesControls && input.controls.length === 0) return null;

  const controlTotals = usesControls
    ? input.controls.map((series) => totalsFor([series], weeks, curve))
    : [];

  const diffs = new Float64Array(size);
  const referenceOf = (picks: readonly number[] | null) => {
    if (!usesControls || picks === null) {
      for (let i = 0; i < size; i += 1) diffs[i] = treatedValues[i]! - fixedReference[i]!;
      return;
    }
    for (let i = 0; i < size; i += 1) {
      let clicks = 0;
      let impressions = 0;
      let expected = 0;
      for (const pick of picks) {
        const control = controlTotals[pick]!;
        clicks += control.clicks[i]!;
        impressions += control.impressions[i]!;
        expected += control.expected[i]!;
      }
      diffs[i] = treatedValues[i]! - logValue(metric, clicks, impressions, expected);
    }
  };

  const allControls = controlTotals.map((_, index) => index);
  referenceOf(usesControls ? allControls : null);
  const logEffect = mean(diffs, postIndices) - mean(diffs, preIndices);
  const effect = Math.exp(logEffect) - 1;

  const random = seededRandom(input.seed);
  const draw = (n: number) => Math.floor(random() * n);
  const effects: number[] = [];
  const picks: number[] = new Array<number>(allControls.length).fill(0);
  const prePicks: number[] = new Array<number>(preIndices.length).fill(0);
  const postPicks: number[] = new Array<number>(postIndices.length).fill(0);
  for (let sample = 0; sample < samples; sample += 1) {
    if (usesControls) {
      if (allControls.length >= 2) {
        for (let k = 0; k < picks.length; k += 1) picks[k] = draw(allControls.length);
        referenceOf(picks);
      } else {
        referenceOf(allControls);
      }
    }
    for (let k = 0; k < prePicks.length; k += 1) {
      prePicks[k] = preIndices[draw(preIndices.length)]!;
    }
    for (let k = 0; k < postPicks.length; k += 1) {
      postPicks[k] = postIndices[draw(postIndices.length)]!;
    }
    effects.push(Math.exp(mean(diffs, postPicks) - mean(diffs, prePicks)) - 1);
  }
  effects.sort((a, b) => a - b);
  return {
    effect,
    low: quantile(effects, INTERVAL_LOW_Q),
    high: quantile(effects, INTERVAL_HIGH_Q),
    logEffect,
    samples,
    yoyAdjusted,
  };
}

// Karar kuralları (§6.4); neden önceliği
// NO_DATA > LOW_DATA > GOOGLE_UPDATE > OVERLAPPING_CHANGE. Sınırlar yalnız
// taban sonuç kesinse uygulanır.
export function decideOutcome(input: {
  result: DidResult | null;
  method: DidMethod;
  metric: DidMetric;
  preClicks: number;
  preImpressions: number;
  overlap: boolean;
  overlappingChange: boolean;
  truncated: boolean;
}): {
  outcome: SeoOutcome;
  confidence: SeoActionConfidence;
  reason: EvaluationReason | null;
} {
  const inconclusive = (reason: EvaluationReason | null) => ({
    outcome: "INCONCLUSIVE" as const,
    confidence: "DIRECTIONAL" as const,
    reason,
  });
  const { result } = input;
  if (!result) return inconclusive("NO_DATA");
  if (
    input.preImpressions < LOW_DATA_IMPRESSIONS ||
    (input.metric !== "impressions" && input.preClicks < LOW_DATA_CLICKS)
  ) {
    return inconclusive("LOW_DATA");
  }
  let outcome: SeoOutcome = "INCONCLUSIVE";
  if (result.low > 0 && result.effect >= WORKED_MIN_EFFECT) outcome = "WORKED";
  else if (result.high < DIDNT_MAX_HIGH) outcome = "DIDNT";
  if (outcome === "INCONCLUSIVE") return inconclusive(null);
  if (input.overlap) return inconclusive("GOOGLE_UPDATE");
  if (input.overlappingChange) return inconclusive("OVERLAPPING_CHANGE");
  const enough =
    input.metric === "impressions"
      ? input.preImpressions >= SIGNIFICANT_PRE_IMPRESSIONS
      : input.preClicks >= SIGNIFICANT_PRE_CLICKS;
  const significant = input.method === "DID" && !input.truncated && enough;
  return {
    outcome,
    confidence: significant ? "SIGNIFICANT" : "DIRECTIONAL",
    reason: null,
  };
}

// Yeni içerik: dizinlenme ve ilk görünürlük.
export function decideLaunch(input: {
  indexed: boolean | null;
  impressions: number;
  clicks: number;
}): { outcome: SeoOutcome; reason: EvaluationReason | null } {
  if (input.impressions >= LOW_DATA_IMPRESSIONS || input.clicks >= LOW_DATA_CLICKS) {
    return { outcome: "WORKED", reason: null };
  }
  if (input.indexed === false || input.impressions === 0) {
    return { outcome: "DIDNT", reason: null };
  }
  return { outcome: "INCONCLUSIVE", reason: "LOW_DATA" };
}

// Core Web Vitals: düşük daha iyidir.
export function decideCwv(input: {
  before: number | null;
  after: number | null;
}): { outcome: SeoOutcome; reason: EvaluationReason | null } {
  const { before, after } = input;
  if (before === null || after === null || before <= 0) {
    return { outcome: "INCONCLUSIVE", reason: "NO_DATA" };
  }
  const improvement = (before - after) / before;
  if (improvement >= WORKED_MIN_EFFECT) return { outcome: "WORKED", reason: null };
  if (improvement <= DIDNT_MAX_HIGH) return { outcome: "DIDNT", reason: null };
  return { outcome: "INCONCLUSIVE", reason: null };
}

// Site haritası: kendi ayrıştırıcımız temiz ve (varsa) GSC hatası yok.
export function decideSitemap(input: {
  ownOk: boolean;
  gscErrors: number | null;
}): { outcome: SeoOutcome; reason: EvaluationReason | null } {
  if (!input.ownOk || (input.gscErrors !== null && input.gscErrors > 0)) {
    return { outcome: "DIDNT", reason: null };
  }
  return { outcome: "WORKED", reason: null };
}

// Uyarı çözümü: hâlâ çözülmüş = işe yaradı, yeniden açılmış = yaramadı.
export function decideAlert(status: string | null): {
  outcome: SeoOutcome;
  reason: EvaluationReason | null;
} {
  if (status === "RESOLVED") return { outcome: "WORKED", reason: null };
  if (status === "OPEN" || status === "ACKED" || status === "MUTED") {
    return { outcome: "DIDNT", reason: null };
  }
  return { outcome: "INCONCLUSIVE", reason: "ALERT_GONE" };
}
