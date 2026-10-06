import { evaluateAiReferrals } from "./ai-referrals";
import { evaluateDailyAnomalies, evaluateWeeklyAnomaly } from "./anomaly";
import { evaluateReturningShare } from "./audience";
import { evaluateChanges } from "./changes";
import { evaluateCampaigns, evaluateChannelQuality } from "./channels";
import { evaluateContentEngagement, evaluateNotFound } from "./content";
import { evaluateDeviceGap } from "./devices";
import { evaluateFunnel } from "./ecommerce";
import { evaluateGoalPace } from "./goals";
import { evaluateLandingPages } from "./landing-pages";
import { findingPriority } from "./priority";
import { gaRule } from "./registry";
import {
  GA_MAX_LIVE_OPPORTUNITIES_PER_WEEK,
  GA_MIN_WINDOW_DAYS,
} from "./schedule";
import { evaluateSiteSearch } from "./site-search";
import type {
  GaAn1DayOutcome,
  GaDailyAnalysisInput,
  GaDailyRulesResult,
  GaFindingCandidate,
  GaFindingMode,
  GaRuleKey,
  GaWeeklyAnalysisInput,
  GaWindowTables,
} from "./types";

// GA-F4 kural düzeni (docs/website-insights.md "Kurallar", "Ortak kapılar"):
// günlük kısım AN1 (gün) + AN15, haftalık kısım AN1 (hafta), AN2-AN12 (AN10
// yalnız ay turunda). Her kural kendi try/catch'inde koşar: biri patlarsa
// yalnız o atlanır (log'a kural anahtarı düşer, veri düşmez). Ortak kalite
// kapıları burada uygulanır, kural dosyaları sade kalır. Saf modül.

function attempt<T>(key: GaRuleKey, run: () => T): T | null {
  try {
    return run();
  } catch {
    console.warn(`[ga-analyze] rule ${key} failed`);
    return null;
  }
}

export function runDailyRules(input: GaDailyAnalysisInput): GaDailyRulesResult {
  const anomalies = attempt("AN1", () => evaluateDailyAnomalies(input));
  const goals = attempt("AN15", () => evaluateGoalPace(input));
  const an1Days: GaAn1DayOutcome[] =
    anomalies?.days ??
    input.targets.map((day) => ({ day, outcome: "skipped" as const }));
  return {
    candidates: applyQualityGates(
      [...(anomalies?.candidates ?? []), ...(goals?.candidates ?? [])],
      { measurementDegraded: input.measurementDegraded },
    ),
    an1Days,
    an15Evaluated: goals?.evaluated ?? [],
  };
}

export function runWeeklyRules(
  input: GaWeeklyAnalysisInput,
): GaFindingCandidate[] {
  const candidates: GaFindingCandidate[] = [];
  const one = (key: GaRuleKey, run: () => GaFindingCandidate | null) => {
    const result = attempt(key, run);
    if (result) candidates.push(result);
  };
  const many = (key: GaRuleKey, run: () => GaFindingCandidate[]) => {
    candidates.push(...(attempt(key, run) ?? []));
  };
  one("AN1", () => evaluateWeeklyAnomaly(input));
  many("AN2", () => evaluateChanges(input));
  many("AN3", () => evaluateLandingPages(input));
  many("AN4", () => evaluateChannelQuality(input));
  one("AN5", () => evaluateDeviceGap(input));
  one("AN6", () => evaluateReturningShare(input));
  one("AN7", () => evaluateAiReferrals(input));
  one("AN8", () => evaluateSiteSearch(input));
  one("AN9", () => evaluateNotFound(input));
  if (input.month) one("AN10", () => evaluateContentEngagement(input));
  one("AN11", () => evaluateFunnel(input));
  many("AN12", () => evaluateCampaigns(input));
  return applyQualityGates(candidates, {
    measurementDegraded: input.measurementDegraded,
    window28: input.window28,
  });
}

// Ortak kapılar: 28 günlük pencere kuralı < 21 temiz günle aday üretmez;
// kuralın raporu pencerenin temiz günlerini kapsamıyorsa (ör. GA_WEEKLY
// kapalıyken landing_page boşlukları) ya da GA-F3 kritik ölçüm sorunu
// varsa aday DIRECTIONAL olur. SIGNIFICANT'ten düşen WARN, INFO'ya iner.
export function applyQualityGates(
  candidates: readonly GaFindingCandidate[],
  input: { measurementDegraded: boolean; window28?: GaWindowTables },
): GaFindingCandidate[] {
  const result: GaFindingCandidate[] = [];
  for (const candidate of candidates) {
    let directional = input.measurementDegraded;
    const report = gaRule(candidate.ruleKey).report;
    if (
      candidate.period.grain === "WINDOW28" &&
      report !== null &&
      input.window28
    ) {
      const window = input.window28;
      if (window.usedDays < GA_MIN_WINDOW_DAYS) continue;
      if ((window.coverage[report] ?? 0) < window.usedDays) directional = true;
    }
    if (!directional || candidate.confidence === "DIRECTIONAL") {
      result.push(candidate);
      continue;
    }
    result.push({
      ...candidate,
      confidence: "DIRECTIONAL",
      severity: candidate.severity === "WARN" ? "INFO" : candidate.severity,
    });
  }
  return result;
}

function isWeeklyOpportunity(candidate: GaFindingCandidate): boolean {
  const rule = gaRule(candidate.ruleKey);
  return rule.cadence === "weekly" && rule.list === "opportunities";
}

// Planın "en fazla 3 öneri" kuralı: canlı modda haftalık öneri kurallarından
// önceliğe göre en çok 3 aday kalır; gölge mod hassasiyet ayarı için hepsini
// tutar. Sıra korunur.
export function limitLiveOpportunities(
  candidates: readonly GaFindingCandidate[],
  mode: GaFindingMode,
): GaFindingCandidate[] {
  if (mode === "shadow") return [...candidates];
  const keep = new Set(
    candidates
      .map((candidate, index) => ({
        index,
        priority: findingPriority(candidate),
        weekly: isWeeklyOpportunity(candidate),
      }))
      .filter((entry) => entry.weekly)
      .sort((a, b) => b.priority - a.priority || a.index - b.index)
      .slice(0, GA_MAX_LIVE_OPPORTUNITIES_PER_WEEK)
      .map((entry) => entry.index),
  );
  return candidates.filter(
    (candidate, index) => !isWeeklyOpportunity(candidate) || keep.has(index),
  );
}
