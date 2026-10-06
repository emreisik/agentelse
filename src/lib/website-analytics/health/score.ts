import { gaCheckDef, type GaCheckDef } from "./registry";
import type {
  GaCheckCategory,
  GaCheckResult,
  GaCheckSeverity,
  GaCheckStatus,
} from "./types";
import type { MeasurementSummary, MeasurementTone } from "./view-types";

// GA-F3 ölçüm puanı (docs/measurement-health.md "Puan", plan §3.5): kontrol
// kredilerinin kategori içi ağırlıklı ortalaması, kategori ağırlıklarıyla
// birleştirilir. UNKNOWN kontroller paydadan çıkar (yeniden normalleşir);
// açık bir CRITICAL hata puanı 40'ta tutar. Yeterli bilinen kontrol yoksa
// puan yoktur ("Checking…").

export const GA_SCORE_CATEGORY_WEIGHTS: Readonly<
  Record<GaCheckCategory, number>
> = {
  data_flow: 30,
  configuration: 20,
  attribution: 20,
  privacy: 15,
  site_tag: 10,
  other: 5,
};

export const GA_SCORE_CRITICAL_CAP = 40;
export const GA_SCORE_MIN_KNOWN = 8;

export function checkCredit(
  status: GaCheckStatus,
  severity: GaCheckSeverity,
): number | null {
  switch (status) {
    case "PASS":
      return 1;
    case "WARN":
      return severity === "INFO" ? 0.75 : severity === "WARN" ? 0.4 : 0.2;
    case "FAIL":
      return 0;
    case "UNKNOWN":
      return null;
  }
}

function criticalFailure(
  results: readonly Pick<GaCheckResult, "status" | "severity">[],
): boolean {
  return results.some(
    (result) => result.status === "FAIL" && result.severity === "CRITICAL",
  );
}

export function measurementScore(
  results: readonly Pick<GaCheckResult, "key" | "status" | "severity">[],
): number | null {
  const known = results
    .map((result) => ({
      def: gaCheckDef(result.key),
      credit: checkCredit(result.status, result.severity),
    }))
    .filter(
      (
        entry,
      ): entry is { def: GaCheckDef; credit: number } =>
        entry.credit !== null,
    );
  const critical = criticalFailure(results);
  if (known.length < GA_SCORE_MIN_KNOWN && !critical) return null;

  const byCategory = new Map<
    GaCheckCategory,
    { sum: number; weight: number }
  >();
  for (const { def, credit } of known) {
    const entry = byCategory.get(def.category) ?? { sum: 0, weight: 0 };
    entry.sum += def.weight * credit;
    entry.weight += def.weight;
    byCategory.set(def.category, entry);
  }
  let total = 0;
  let totalWeight = 0;
  for (const [category, entry] of byCategory) {
    if (entry.weight <= 0) continue;
    const weight = GA_SCORE_CATEGORY_WEIGHTS[category];
    total += weight * (entry.sum / entry.weight);
    totalWeight += weight;
  }
  if (totalWeight <= 0) return null;
  const score = Math.round((100 * total) / totalWeight);
  return critical ? Math.min(score, GA_SCORE_CRITICAL_CAP) : score;
}

export function measurementTone(
  score: number | null,
  results: readonly Pick<GaCheckResult, "status" | "severity">[],
): MeasurementTone {
  if (score === null) return "unknown";
  if (criticalFailure(results) || score < 50) return "error";
  const warned = results.some(
    (result) =>
      (result.status === "WARN" || result.status === "FAIL") &&
      result.severity === "WARN",
  );
  if (score < 80 || warned) return "warning";
  return "ok";
}

export function measurementLabel(score: number | null): string {
  return score === null ? "Checking…" : `${score}/100`;
}

export function summarizeMeasurement(input: {
  score: number | null;
  results: readonly Pick<GaCheckResult, "status" | "severity">[];
  evaluatedAt: Date | null;
}): MeasurementSummary {
  const issues = input.results.filter(
    (result) =>
      (result.status === "WARN" || result.status === "FAIL") &&
      result.severity !== "INFO",
  ).length;
  return {
    score: input.score,
    tone: measurementTone(input.score, input.results),
    label: measurementLabel(input.score),
    issues,
    critical: input.results.filter(
      (result) => result.status === "FAIL" && result.severity === "CRITICAL",
    ).length,
    evaluatedAt: input.evaluatedAt ? input.evaluatedAt.toISOString() : null,
  };
}
