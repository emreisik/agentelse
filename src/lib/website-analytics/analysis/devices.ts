import type { GaTableRow } from "@/lib/website-analytics/slices";

import { GaSubjects } from "./keys";
import { GA_RATIO_EPSILON, weeks4, window28Context } from "./landing-pages";
import { rateRatioTest } from "./stats";
import type {
  An5Evidence,
  GaFindingCandidate,
  GaFindingConfidence,
  GaWeeklyAnalysisInput,
} from "./types";

// GA-F4 AN5 mobil dönüşüm açığı (docs/website-insights.md): mobil oturumların
// anahtar olay oranı masaüstünün %60'ının altındaysa mobil deneyimde fırsat
// var. Etki: mobil oran masaüstünün %80'ine çıksa kazanılacak anahtar olay
// (üst sınır masaüstüyle eşitlenmesi). Saf modül, hata atmaz.

const MIN_SESSIONS = 200;
const MIN_DESKTOP_KEY_EVENTS = 10;
const MAX_RATIO = 0.6;
const TARGET_SHARE = 0.8;
const SIGNIFICANT_P = 0.05;

export type GaDeviceRow = { sessions: number; keyEvents: number };

// deviceCategory satırları küçük harfe göre toplanır ([sessions,
// engagedSessions, keyEvents]).
export function deviceRow(
  rows: readonly GaTableRow[],
  category: string,
): GaDeviceRow {
  const entry = { sessions: 0, keyEvents: 0 };
  for (const row of rows) {
    if ((row.key[0] ?? "").trim().toLowerCase() !== category) continue;
    entry.sessions += row.values[0] ?? 0;
    entry.keyEvents += row.values[2] ?? 0;
  }
  return entry;
}

export function evaluateDeviceGap(
  input: GaWeeklyAnalysisInput,
): GaFindingCandidate | null {
  const mobile = deviceRow(input.window28.device, "mobile");
  const desktop = deviceRow(input.window28.device, "desktop");
  if (mobile.sessions < MIN_SESSIONS || desktop.sessions < MIN_SESSIONS) {
    return null;
  }
  if (desktop.keyEvents < MIN_DESKTOP_KEY_EVENTS) return null;
  const mobileRate = mobile.keyEvents / mobile.sessions;
  const desktopRate = desktop.keyEvents / desktop.sessions;
  const ratio = mobileRate / desktopRate;
  if (!(ratio < MAX_RATIO - GA_RATIO_EPSILON)) return null;

  const p =
    rateRatioTest(
      mobile.keyEvents,
      mobile.sessions,
      desktop.keyEvents,
      desktop.sessions,
    )?.p ?? null;
  const confidence: GaFindingConfidence =
    p !== null && p < SIGNIFICANT_P ? "SIGNIFICANT" : "DIRECTIONAL";
  const context = window28Context(input);
  const perWeek = weeks4(
    (TARGET_SHARE * desktopRate - mobileRate) * mobile.sessions,
  );
  const evidence: An5Evidence = {
    v: 1,
    rule: "AN5",
    window: context.range,
    mobile: { ...mobile, rate: mobileRate },
    desktop: { ...desktop, rate: desktopRate },
    ratio,
    p,
    excludedDays: context.excludedDays,
    holidays: context.holidays,
  };
  return {
    ruleKey: "AN5",
    kind: "OPPORTUNITY",
    subject: GaSubjects.mobile(),
    period: context.period,
    severity: confidence === "SIGNIFICANT" ? "WARN" : "INFO",
    confidence,
    evidence,
    impact: {
      metric: "keyEvents",
      perWeek,
      low: 0,
      high: weeks4((desktopRate - mobileRate) * mobile.sessions),
      directional: confidence !== "SIGNIFICANT",
    },
    impactShare: perWeek / Math.max(1, weeks4(input.window28.totals.keyEvents)),
  };
}
