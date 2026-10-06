import {
  SEARCH_ALERT_KINDS,
  isSearchAlertKind,
  type ScorePartKey,
  type SeoAlertDraft,
} from "./alert-kinds";

// Search health puanı (docs/search-health.md "Puan"), saf. Parça ağırlıkları
// İndeksleme 35, Teknik 25, Sitemap ve robots 15, CWV 15, Veri 10. Girdisi
// olmayan parçalar çıkar ve ağırlıklar yeniden normalleşir. İndeksleme tabanı
// kapsam tahmininin nokta değeri, Teknik tabanı WARN/CRITICAL sorunu olmayan
// 200-HTML sayfaların payı. Açık taslaklar parçadan düşer: CRITICAL ağırlığın
// tamamı, WARN %40, INFO %10 (taban 0). Herhangi bir CRITICAL puanı 40'ta
// tutar. SeoSite.healthScore / healthParts'a yazılır.

export const SCORE_WEIGHTS: Readonly<Record<ScorePartKey, number>> = {
  indexing: 35,
  technical: 25,
  sitemap_robots: 15,
  cwv: 15,
  data: 10,
};

export const SCORE_PART_LABEL: Readonly<Record<ScorePartKey, string>> = {
  indexing: "Indexing",
  technical: "Technical",
  sitemap_robots: "Sitemaps & robots",
  cwv: "Core Web Vitals",
  data: "Data & connection",
};

export const SCORE_CRITICAL_CAP = 40;

const PART_KEYS = Object.keys(SCORE_WEIGHTS) as ScorePartKey[];

const PENALTY_SHARE: Readonly<Record<SeoAlertDraft["severity"], number>> = {
  CRITICAL: 1,
  WARN: 0.4,
  INFO: 0.1,
};

export type SearchHealthScorePart = {
  key: ScorePartKey;
  label: string;
  weight: number;
  score: number | null;
  available: boolean;
};

export type SearchHealthScore = {
  value: number | null;
  parts: SearchHealthScorePart[];
  cappedByCritical: boolean;
};

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function clampShare(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

export function computeSearchHealthScore(input: {
  drafts: readonly Pick<SeoAlertDraft, "kind" | "severity">[];
  available: Readonly<Record<ScorePartKey, boolean>>;
  coveragePoint: number | null;
  technicalCleanShare: number | null;
}): SearchHealthScore {
  const coverage = clampShare(input.coveragePoint);
  const clean = clampShare(input.technicalCleanShare);
  const parts = PART_KEYS.map((key): SearchHealthScorePart => {
    const weight = SCORE_WEIGHTS[key];
    const label = SCORE_PART_LABEL[key];
    if (!input.available[key]) {
      return { key, label, weight, score: null, available: false };
    }
    const base =
      key === "indexing" && coverage !== null
        ? weight * coverage
        : key === "technical" && clean !== null
          ? weight * clean
          : weight;
    const penalty = input.drafts
      .filter(
        (draft) =>
          isSearchAlertKind(draft.kind) &&
          SEARCH_ALERT_KINDS[draft.kind].part === key,
      )
      .reduce((sum, draft) => sum + weight * PENALTY_SHARE[draft.severity], 0);
    return {
      key,
      label,
      weight,
      score: round2(Math.max(0, base - penalty)),
      available: true,
    };
  });

  const available = parts.filter((part) => part.available);
  const totalWeight = available.reduce((sum, part) => sum + part.weight, 0);
  if (totalWeight === 0) {
    return { value: null, parts, cappedByCritical: false };
  }
  const raw = Math.round(
    (100 * available.reduce((sum, part) => sum + (part.score ?? 0), 0)) /
      totalWeight,
  );
  const critical = input.drafts.some((draft) => draft.severity === "CRITICAL");
  return {
    value: critical ? Math.min(raw, SCORE_CRITICAL_CAP) : raw,
    parts,
    cappedByCritical: critical,
  };
}

function isPartKey(value: unknown): value is ScorePartKey {
  return typeof value === "string" && PART_KEYS.includes(value as ScorePartKey);
}

function parsePart(value: unknown): SearchHealthScorePart | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!isPartKey(record.key)) return null;
  const score = record.score;
  if (score !== null && (typeof score !== "number" || !Number.isFinite(score)))
    return null;
  if (typeof record.available !== "boolean") return null;
  return {
    key: record.key,
    label: SCORE_PART_LABEL[record.key],
    weight: SCORE_WEIGHTS[record.key],
    score,
    available: record.available,
  };
}

// SeoSite.healthParts (Json) → puan; biçim bozuksa null.
export function parseStoredScore(value: unknown): SearchHealthScore | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const stored = record.value;
  if (
    stored !== null &&
    (typeof stored !== "number" || !Number.isFinite(stored))
  ) {
    return null;
  }
  if (!Array.isArray(record.parts)) return null;
  const parts = record.parts.map(parsePart);
  if (parts.some((part) => part === null)) return null;
  return {
    value: stored,
    parts: parts.filter((part): part is SearchHealthScorePart => part !== null),
    cappedByCritical: record.cappedByCritical === true,
  };
}
