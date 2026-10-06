import { addDays } from "@/lib/website-analytics/days";
import type { GaTableRow } from "@/lib/website-analytics/slices";
import { maskGooglePath } from "@/server/integrations/google/pii";

import { daysIn } from "./baseline";
import { GaSubjects, periodOf } from "./keys";
import {
  benjaminiHochberg,
  percentile,
  poissonInterval,
  rateRatioTest,
} from "./stats";
import type {
  An3Evidence,
  GaFindingCandidate,
  GaFindingConfidence,
  GaPeriod,
  GaRange,
  GaWeeklyAnalysisInput,
} from "./types";

// GA-F4 AN3 açılış sayfası fırsatları (docs/website-insights.md):
// çok trafik alıp sitenin geri kalanının yarısından az dönüştüren sayfalar
// (CRO) ve az trafikle 1,5 katı dönüştüren sayfalar (promote). 28 günlük
// pencere; şüpheli günleri yükleyici zaten dışarıda bırakır. Kapsam, kullanılan
// gün ve ölçüm sağlığı kapıları run-rules.ts'te (D). Saf modül, hata atmaz.

// C paketinin ortak yardımcıları (kanal, cihaz, site araması da kullanır).

// 28 günlük sayımdan haftalık hız.
export function weeks4(value: number): number {
  return value / 4;
}

// Kanıttaki etiketler en çok 80 karakter.
export const GA_LABEL_MAX = 80;

export function capLabel(value: string): string {
  return value.slice(0, GA_LABEL_MAX);
}

// Kayan nokta sınırlarında (0,7 ≤ 0,7 gibi) eşitliği korumak için pay.
export const GA_RATIO_EPSILON = 1e-9;

// Pencere kuralları için W28 dönemi [pazar−27, pazar], dışlanan ve tatil
// günleri.
export function window28Context(input: GaWeeklyAnalysisInput): {
  range: GaRange;
  period: GaPeriod;
  excludedDays: string[];
  holidays: string[];
} {
  const range = {
    from: addDays(input.week.sunday, -27),
    to: input.week.sunday,
  };
  return {
    range,
    period: periodOf("WINDOW28", range),
    excludedDays: [...input.window28.excludedDays],
    holidays: daysIn(range, input.holidays),
  };
}

const IGNORED_LANDING_KEYS = new Set(["(not set)", "(other)", ""]);

// Maskelemeden sonra yalnız "[id]" parçalarından oluşan yol bir sayfa değil.
function onlyIdSegments(path: string): boolean {
  const segments = path.split("/").filter((segment) => segment !== "");
  return segments.length > 0 && segments.every((s) => s === "[id]");
}

export type GaLandingRow = {
  path: string;
  sessions: number;
  engagedSessions: number;
  keyEvents: number;
  revenue: number;
  engagementSec: number;
};

// landing satırları maskelenmiş yola göre birleştirilir (iki ham yol aynı
// maskeye düşerse aynı run'da iki aynı parmak izi oluşmasın).
export function landingRowsByPath(rows: readonly GaTableRow[]): GaLandingRow[] {
  const byPath = new Map<string, GaLandingRow>();
  for (const row of rows) {
    const raw = row.key[0] ?? "";
    if (IGNORED_LANDING_KEYS.has(raw.trim())) continue;
    const path = capLabel(maskGooglePath(raw));
    if (path === "" || onlyIdSegments(path)) continue;
    const entry = byPath.get(path) ?? {
      path,
      sessions: 0,
      engagedSessions: 0,
      keyEvents: 0,
      revenue: 0,
      engagementSec: 0,
    };
    entry.sessions += row.values[0] ?? 0;
    entry.engagedSessions += row.values[1] ?? 0;
    entry.keyEvents += row.values[2] ?? 0;
    entry.revenue += row.values[3] ?? 0;
    entry.engagementSec += row.values[4] ?? 0;
    byPath.set(path, entry);
  }
  return [...byPath.values()];
}

const MIN_THRESHOLD = 100;
const THRESHOLD_PERCENTILE = 0.75;
const CRO_RATIO = 0.5;
const PROMOTE_RATIO = 1.5;
const PROMOTE_MIN_KEY_EVENTS = 10;
const SIGNIFICANT_P = 0.05;
const SIGNIFICANT_MIN_SESSIONS = 200;
const SIGNIFICANT_MIN_REST_KEY_EVENTS = 10;
const MAX_CRO = 3;
const MAX_PROMOTE = 2;

type Variant = "cro" | "promote";

type Draft = {
  row: GaLandingRow;
  rate: number;
  restSessions: number;
  restKeyEvents: number;
  restRate: number;
  p: number | null;
};

function familyCandidates(
  input: GaWeeklyAnalysisInput,
  variant: Variant,
  drafts: Draft[],
  threshold: number,
): GaFindingCandidate[] {
  const context = window28Context(input);
  const accepted = benjaminiHochberg(drafts.map((d) => d.p ?? 1));
  const totalWeekly = Math.max(1, weeks4(input.window28.totals.keyEvents));
  const candidates = drafts.map((draft, index): GaFindingCandidate => {
    const { row, rate, restSessions, restKeyEvents, restRate } = draft;
    const bhAccepted = accepted[index] ?? false;
    const confidence: GaFindingConfidence =
      draft.p !== null &&
      draft.p < SIGNIFICANT_P &&
      bhAccepted &&
      row.sessions >= SIGNIFICANT_MIN_SESSIONS &&
      restKeyEvents >= SIGNIFICANT_MIN_REST_KEY_EVENTS &&
      (variant === "cro" || row.keyEvents >= PROMOTE_MIN_KEY_EVENTS)
        ? "SIGNIFICANT"
        : "DIRECTIONAL";
    const evidence: An3Evidence = {
      v: 1,
      rule: "AN3",
      variant,
      window: context.range,
      page: row.path,
      sessions: row.sessions,
      keyEvents: row.keyEvents,
      rate,
      restSessions,
      restKeyEvents,
      restRate,
      ratio: rate / restRate,
      threshold,
      p: draft.p,
      bhAccepted,
      excludedDays: context.excludedDays,
      holidays: context.holidays,
    };
    let impact: GaFindingCandidate["impact"];
    if (variant === "cro") {
      // Sitenin geri kalanının oranına çıkarsa kazanılacak anahtar olay;
      // aralık geri kalanın KE sayısının Byar aralığından.
      const interval = poissonInterval(restKeyEvents);
      impact = {
        metric: "keyEvents",
        perWeek: weeks4((restRate - rate) * row.sessions),
        low: Math.max(
          0,
          weeks4((interval.low / restSessions - rate) * row.sessions),
        ),
        high: weeks4((interval.high / restSessions - rate) * row.sessions),
        directional: confidence !== "SIGNIFICANT",
      };
    } else {
      const interval = poissonInterval(row.keyEvents);
      impact = {
        metric: "keyEvents",
        perWeek: weeks4(row.keyEvents),
        low: weeks4(interval.low),
        high: weeks4(interval.high),
        directional: true,
      };
    }
    return {
      ruleKey: "AN3",
      kind: variant === "cro" ? "OPPORTUNITY" : "WIN",
      subject: GaSubjects.page(row.path),
      period: context.period,
      severity:
        variant === "cro" && confidence === "SIGNIFICANT" ? "WARN" : "INFO",
      confidence,
      evidence,
      impact,
      impactShare: impact.perWeek / totalWeekly,
    };
  });
  return candidates
    .sort(
      (a, b) =>
        (b.impact?.perWeek ?? 0) - (a.impact?.perWeek ?? 0) ||
        a.subject.localeCompare(b.subject),
    )
    .slice(0, variant === "cro" ? MAX_CRO : MAX_PROMOTE);
}

export function evaluateLandingPages(
  input: GaWeeklyAnalysisInput,
): GaFindingCandidate[] {
  const totals = input.window28.totals;
  const rows = landingRowsByPath(input.window28.landing);
  const threshold = Math.max(
    MIN_THRESHOLD,
    percentile(
      rows.filter((row) => row.sessions >= 1).map((row) => row.sessions),
      THRESHOLD_PERCENTILE,
    ) ?? 0,
  );

  const cro: Draft[] = [];
  const promote: Draft[] = [];
  for (const row of rows) {
    if (row.sessions <= 0) continue;
    const restSessions = Math.max(0, totals.sessions - row.sessions);
    const restKeyEvents = Math.max(0, totals.keyEvents - row.keyEvents);
    if (restSessions <= 0) continue;
    const rate = row.keyEvents / row.sessions;
    const restRate = restKeyEvents / restSessions;
    // Geri kalanında hiç anahtar olay yoksa oran karşılaştırması anlamsız.
    if (restRate <= 0) continue;
    const draft = (): Draft => ({
      row,
      rate,
      restSessions,
      restKeyEvents,
      restRate,
      p:
        rateRatioTest(row.keyEvents, row.sessions, restKeyEvents, restSessions)
          ?.p ?? null,
    });
    if (
      row.sessions >= threshold &&
      rate < CRO_RATIO * restRate - GA_RATIO_EPSILON * restRate
    ) {
      cro.push(draft());
    } else if (
      row.keyEvents >= PROMOTE_MIN_KEY_EVENTS &&
      row.sessions >= MIN_THRESHOLD &&
      row.sessions < threshold &&
      rate >= PROMOTE_RATIO * restRate - GA_RATIO_EPSILON * restRate
    ) {
      promote.push(draft());
    }
  }

  return [
    ...familyCandidates(input, "cro", cro, threshold),
    ...familyCandidates(input, "promote", promote, threshold),
  ];
}
