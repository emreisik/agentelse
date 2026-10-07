import { z } from "zod";

import { isGaRuleKey } from "./registry";
import type { GaFindingEvidence, GaImpact, GaOutcomeEvidence } from "./types";

// GaFinding Json sütunlarının (evidence, impact, outcomeEvidence) hoşgörülü
// okuyucuları (docs/google-analytics-plan.md §4; ayrıntı
// docs/website-insights.md "Veri modeli"). v/rule yoksa ya da zorunlu üst
// alanlardan biri yanlış tipteyse null döner, hiçbir zaman hata fırlatmaz.
// Bu sürümde eklenen alanlar (holidays, preliminary, siteUpliftPct) yoksa
// []/false/null olur; dizi elemanları süzülür (bozuk eleman atılır).
// Bilinmeyen alanlar korunur (.passthrough): daha yeni bir sürümün yazdığı
// satır da okunur.

const num = z.number();
const nnum = z.number().nullable();
const str = z.string();
const bool = z.boolean();

// Dizi zorunlu; bozuk elemanlar atılır.
function list<T extends z.ZodType>(item: T) {
  return z.array(z.unknown()).transform((items) =>
    items.flatMap((value) => {
      const parsed = item.safeParse(value);
      return parsed.success ? [parsed.data as z.output<T>] : [];
    }),
  );
}

const strings = list(str);
// Sonradan eklenen alanlar: yoksa ya da bozuksa varsayılan.
const holidays = strings.catch([]);
const preliminary = bool.catch(false);

const range = z.object({ from: str, to: str }).passthrough();

const anomalyMetric = z.enum([
  "sessions",
  "engagedSessions",
  "keyEvents",
  "revenue",
  "keyEventRate",
]);
const decompositionMetric = z.enum(["keyEvents", "sessions", "revenue"]);

const component = z
  .object({
    key: str,
    label: str,
    sessionsBefore: num,
    sessionsAfter: num,
    valueBefore: num,
    valueAfter: num,
    rateBefore: nnum,
    rateAfter: nnum,
    volume: num,
    rate: num,
    total: num,
    share: nnum,
  })
  .passthrough();

const decomposition = z
  .object({
    metric: decompositionMetric,
    dimension: z.enum(["channel", "landingPage"]),
    before: num,
    after: num,
    delta: num,
    perDay: bool,
    components: list(component),
    other: z
      .object({ count: num, volume: num, rate: num, total: num })
      .passthrough()
      .nullable(),
    residual: num,
  })
  .passthrough();

const reading = z
  .object({
    metric: anomalyMetric,
    value: num,
    median: num,
    scale: num,
    z: num,
    direction: z.enum(["up", "down"]),
    baselineDays: strings,
  })
  .passthrough();

const an1 = z
  .object({
    v: z.literal(1),
    rule: z.literal("AN1"),
    mode: z.enum(["day", "week"]),
    target: str,
    readings: list(reading),
    primary: anomalyMetric,
    excludedDays: strings,
    breakdown: decomposition.nullable(),
    seasonalChecked: bool,
    preliminary,
  })
  .passthrough();

const rangeTotal = range.extend({ days: num, total: num });

const an2 = z
  .object({
    v: z.literal(1),
    rule: z.literal("AN2"),
    comparison: z.enum(["wow", "mom", "yoy"]),
    metric: decompositionMetric,
    metricReason: z.enum(["requested", "low_key_events"]),
    current: rangeTotal,
    previous: rangeTotal,
    change: num,
    changePct: nnum,
    z: nnum,
    p: nnum,
    channels: decomposition,
    pages: decomposition.nullable(),
    holidays,
    suspectDays: strings,
    seasonal: z.object({ lastYearChangePct: num }).passthrough().nullable(),
    preliminary,
  })
  .passthrough();

const an3 = z
  .object({
    v: z.literal(1),
    rule: z.literal("AN3"),
    variant: z.enum(["cro", "promote"]),
    window: range,
    page: str,
    sessions: num,
    keyEvents: num,
    rate: num,
    restSessions: num,
    restKeyEvents: num,
    restRate: num,
    ratio: num,
    threshold: num,
    p: nnum,
    bhAccepted: bool,
    excludedDays: strings,
    holidays,
  })
  .passthrough();

const an4 = z
  .object({
    v: z.literal(1),
    rule: z.literal("AN4"),
    window: range,
    channel: str,
    measure: z.enum(["engagement", "keyEventRate"]),
    direction: z.enum(["below", "above"]),
    sessions: num,
    hits: num,
    rate: num,
    restSessions: num,
    restHits: num,
    restRate: num,
    ratio: num,
    p: nnum,
    bhAccepted: bool,
    excludedDays: strings,
    holidays,
  })
  .passthrough();

const deviceRow = z
  .object({ sessions: num, keyEvents: num, rate: num })
  .passthrough();

const an5 = z
  .object({
    v: z.literal(1),
    rule: z.literal("AN5"),
    window: range,
    mobile: deviceRow,
    desktop: deviceRow,
    ratio: num,
    p: nnum,
    excludedDays: strings,
    holidays,
  })
  .passthrough();

const an6 = z
  .object({
    v: z.literal(1),
    rule: z.literal("AN6"),
    weeks: list(
      z
        .object({ monday: str, returning: num, total: num, share: num })
        .passthrough(),
    ),
    earlyShare: num,
    lateShare: num,
    dropPoints: num,
    p: nnum,
  })
  .passthrough();

const rangeVisits = range.extend({ sessions: num, keyEvents: num });

const an7 = z
  .object({
    v: z.literal(1),
    rule: z.literal("AN7"),
    current: rangeVisits,
    previous: rangeVisits,
    assistants: list(
      z
        .object({ name: str, sessions: num, previousSessions: num })
        .passthrough(),
    ),
    changePct: nnum,
    p: nnum,
    firstSeen: bool,
    siteSessions: num,
    holidays,
  })
  .passthrough();

const an8 = z
  .object({
    v: z.literal(1),
    rule: z.literal("AN8"),
    weeks: strings,
    terms: list(z.object({ term: str, searches: num }).passthrough()),
    totalSearches: num,
    siteSessions: num,
  })
  .passthrough();

const an9 = z
  .object({
    v: z.literal(1),
    rule: z.literal("AN9"),
    week: range,
    pages: list(z.object({ path: str, title: str, views: num }).passthrough()),
    views: num,
  })
  .passthrough();

const an10 = z
  .object({
    v: z.literal(1),
    rule: z.literal("AN10"),
    window: range,
    month: str,
    pages: list(
      z
        .object({
          path: str,
          sessions: num,
          engagementRate: num,
          avgEngagementSec: num,
          keyEvents: num,
        })
        .passthrough(),
    ),
    siteEngagementRate: num,
    siteAvgEngagementSec: num,
    holidays,
  })
  .passthrough();

const funnelCounts = z
  .object({ entered: num, completed: num, rate: num })
  .passthrough();

const an11 = z
  .object({
    v: z.literal(1),
    rule: z.literal("AN11"),
    week: range,
    baselineWeeks: strings,
    step: z
      .object({
        from: str,
        to: str,
        current: funnelCounts,
        baseline: funnelCounts,
        p: num,
        dropPct: num,
      })
      .passthrough(),
    aov: z.object({ current: nnum, baseline: nnum }).passthrough(),
  })
  .passthrough();

const an12 = z
  .object({
    v: z.literal(1),
    rule: z.literal("AN12"),
    window: range,
    campaign: str,
    source: str,
    medium: str,
    agentelse: bool,
    direction: z.enum(["below", "above"]),
    sessions: num,
    keyEvents: num,
    rate: num,
    restSessions: num,
    restKeyEvents: num,
    restRate: num,
    ratio: num,
    p: nnum,
    bhAccepted: bool,
    excludedDays: strings,
    holidays,
  })
  .passthrough();

const an13 = z
  .object({
    v: z.literal(1),
    rule: z.literal("AN13"),
    window: range,
    campaignExternalId: str,
    label: str,
    metaCurrency: str.nullable(),
    meta: z
      .object({
        ads: num,
        spend: nnum,
        linkClicks: num,
        landingPageViews: num,
        results: nnum,
        resultActionType: str.nullable(),
        activeDays: num,
      })
      .passthrough(),
    ga: z
      .object({
        sessions: num,
        engagedSessions: num,
        keyEvents: num,
        revenue: num,
      })
      .passthrough(),
    checks: list(z.enum(["clicks", "results"])),
    clickLoss: nnum,
    clickRateHigh: nnum,
    resultsGap: nnum,
    resultsP: nnum,
    costPerResult: nnum,
    costPerKeyEvent: nnum,
    excludedDays: strings.catch([]),
    holidays,
  })
  .passthrough();

const adsSide = z
  .object({
    cost: num,
    clicks: num,
    sessions: num,
    keyEvents: num,
    revenue: num,
    costPerKeyEvent: num,
    roas: nnum,
  })
  .passthrough();

const an14 = z
  .object({
    v: z.literal(1),
    rule: z.literal("AN14"),
    window: range,
    previousWindow: range,
    campaign: str,
    direction: z.enum(["worse", "better"]),
    current: adsSide,
    previous: adsSide,
    changePct: num,
    p: num,
    bhAccepted: bool,
    excludedDays: strings.catch([]),
    holidays,
  })
  .passthrough();

const an15 = z
  .object({
    v: z.literal(1),
    rule: z.literal("AN15"),
    goalId: str,
    goalTitle: str,
    metricKey: z.enum(["web.sessions", "web.key_events", "web.revenue"]),
    month: str,
    target: num,
    monthToDate: num,
    forecast: num,
    paceRatio: num,
    dayOfMonth: num,
    daysInMonth: num,
    through: str,
  })
  .passthrough();

function result<T>(parsed: z.ZodSafeParseResult<T>): T | null {
  return parsed.success ? parsed.data : null;
}

export function parseGaFindingEvidence(
  json: unknown,
): GaFindingEvidence | null {
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    return null;
  }
  const record = json as Record<string, unknown>;
  if (record.v !== 1 || !isGaRuleKey(record.rule)) return null;
  switch (record.rule) {
    case "AN1":
      return result(an1.safeParse(json));
    case "AN2":
      return result(an2.safeParse(json));
    case "AN3":
      return result(an3.safeParse(json));
    case "AN4":
      return result(an4.safeParse(json));
    case "AN5":
      return result(an5.safeParse(json));
    case "AN6":
      return result(an6.safeParse(json));
    case "AN7":
      return result(an7.safeParse(json));
    case "AN8":
      return result(an8.safeParse(json));
    case "AN9":
      return result(an9.safeParse(json));
    case "AN10":
      return result(an10.safeParse(json));
    case "AN11":
      return result(an11.safeParse(json));
    case "AN12":
      return result(an12.safeParse(json));
    case "AN13":
      return result(an13.safeParse(json));
    case "AN14":
      return result(an14.safeParse(json));
    case "AN15":
      return result(an15.safeParse(json));
  }
}

const impact = z
  .object({
    metric: z.enum([
      "keyEvents",
      "sessions",
      "engagedSessions",
      "revenue",
      "views",
      "purchases",
    ]),
    perWeek: num,
    low: num,
    high: num,
    directional: bool,
  })
  .passthrough();

export function parseGaImpact(json: unknown): GaImpact | null {
  return result(impact.safeParse(json));
}

const outcomeSide = range.extend({ sessions: num, hits: num, rate: nnum });
const siteSide = z.object({ rate: nnum }).passthrough().nullable();

const outcome = z
  .object({
    v: z.literal(1),
    before: outcomeSide,
    after: outcomeSide,
    siteBefore: siteSide,
    siteAfter: siteSide,
    p: nnum,
    upliftPct: nnum,
    siteUpliftPct: nnum.catch(null),
    reason: z.enum([
      "worked",
      "no_change",
      "worse",
      "too_little_data",
      "tracking_issue",
    ]),
  })
  .passthrough();

export function parseGaOutcomeEvidence(
  json: unknown,
): GaOutcomeEvidence | null {
  return result(outcome.safeParse(json));
}

// Tatil içeren pencere bulgusu "Includes a public holiday." taşır.
export function evidenceHolidays(evidence: GaFindingEvidence): string[] {
  return "holidays" in evidence ? evidence.holidays : [];
}

// Ön (kesinleşmemiş) veri yalnız AN1/AN2'de işaretlenir.
export function evidencePreliminary(evidence: GaFindingEvidence): boolean {
  return evidence.rule === "AN1" || evidence.rule === "AN2"
    ? evidence.preliminary
    : false;
}
