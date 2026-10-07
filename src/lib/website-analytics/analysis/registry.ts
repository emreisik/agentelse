import {
  GA_RULE_KEYS,
  type GaFindingEvidence,
  type GaRuleKey,
  type GaWindowReport,
} from "./types";

// GA-F4 kural kaydı (docs/google-analytics-plan.md §6.2 "Analiz kuralları";
// ayrıntı docs/website-insights.md "Kurallar"). Başlıklar geneldir: rakam,
// sayfa yolu, kanal ya da kampanya adı asla yok (operatör kartı ve gölge
// incelemesi bunları gösterir). Eşik değişikliği migration değil sürüm
// artırımıdır.
// - recurrence "condition": haftadan haftaya süren durum; yeni satır önceki
//   OPEN satırı SUPERSEDED yapar, reddetme 56 gün bastırır.
// - recurrence "event": tarihli tek olay; her dönem kendi satırını alır,
//   reddetme yalnız o dönemin parmak izini etkiler.
// - evaluable: kabul + "Mark done" sonrası önce/sonra değerlendirmesi var.
// - signal: canlı modda sinyal üretilen kurallar (AN2 kanal bazlı, AN3 yalnız
//   promote, AN7).
// - report: pencere kapsam kapısının baktığı rapor (run-rules.ts).

export type GaRuleDef = {
  key: GaRuleKey;
  title: string;
  cadence: "daily" | "weekly" | "monthly";
  list: "changed" | "opportunities";
  recurrence: "event" | "condition";
  evaluable: (evidence: GaFindingEvidence) => boolean;
  ttlDays: number;
  version: number;
  signal: "PERFORMANCE" | "SEO" | "BY_CHANNEL" | null;
  report: GaWindowReport | null;
};

const always = () => true;
const never = () => false;
// AN4 ve AN12: yalnız ortalamanın altında kalan kanal/kampanya üzerinde
// çalışılabilir.
const below = (evidence: GaFindingEvidence) =>
  (evidence.rule === "AN4" || evidence.rule === "AN12") &&
  evidence.direction === "below";

export const GA_RULES: readonly GaRuleDef[] = [
  {
    key: "AN1",
    title: "A key number moved unusually",
    cadence: "daily",
    list: "changed",
    recurrence: "event",
    evaluable: never,
    ttlDays: 7,
    version: 1,
    signal: null,
    report: null,
  },
  {
    key: "AN2",
    title: "A change explained by channel and page",
    cadence: "weekly",
    list: "changed",
    recurrence: "event",
    evaluable: never,
    ttlDays: 14,
    version: 1,
    // SEO, en büyük bileşen "Organic Search" ise; değilse PERFORMANCE
    // (signals.ts karar verir).
    signal: "BY_CHANNEL",
    report: null,
  },
  {
    key: "AN3",
    title: "Landing page conversion",
    cadence: "weekly",
    list: "opportunities",
    recurrence: "condition",
    evaluable: always,
    ttlDays: 28,
    version: 1,
    // Yalnız promote varyantı sinyal olur.
    signal: "PERFORMANCE",
    report: "landing",
  },
  {
    key: "AN4",
    title: "Channel quality",
    cadence: "weekly",
    list: "opportunities",
    recurrence: "condition",
    evaluable: below,
    ttlDays: 28,
    version: 1,
    signal: null,
    report: "channel",
  },
  {
    key: "AN5",
    title: "Mobile conversion gap",
    cadence: "weekly",
    list: "opportunities",
    recurrence: "condition",
    evaluable: always,
    ttlDays: 28,
    version: 1,
    signal: null,
    report: "device",
  },
  {
    key: "AN6",
    title: "Returning visitors",
    cadence: "weekly",
    list: "changed",
    recurrence: "condition",
    evaluable: never,
    ttlDays: 28,
    version: 1,
    signal: null,
    report: null,
  },
  {
    key: "AN7",
    title: "Visits from AI assistants",
    cadence: "weekly",
    list: "changed",
    recurrence: "event",
    evaluable: never,
    ttlDays: 28,
    version: 1,
    signal: "SEO",
    report: "sourceMedium",
  },
  {
    key: "AN8",
    title: "What visitors search for",
    cadence: "weekly",
    list: "opportunities",
    recurrence: "condition",
    evaluable: never,
    ttlDays: 28,
    version: 1,
    signal: null,
    report: null,
  },
  {
    key: "AN9",
    title: "Visits to missing pages",
    cadence: "weekly",
    list: "opportunities",
    recurrence: "condition",
    evaluable: always,
    ttlDays: 14,
    version: 1,
    signal: null,
    report: null,
  },
  {
    key: "AN10",
    title: "Most engaging content",
    cadence: "monthly",
    list: "opportunities",
    recurrence: "condition",
    evaluable: never,
    ttlDays: 35,
    version: 1,
    signal: null,
    report: null,
  },
  {
    key: "AN11",
    title: "Shop funnel step",
    cadence: "weekly",
    list: "opportunities",
    recurrence: "event",
    evaluable: always,
    ttlDays: 14,
    version: 1,
    signal: null,
    report: null,
  },
  {
    key: "AN12",
    title: "Campaign quality",
    cadence: "weekly",
    list: "opportunities",
    recurrence: "condition",
    evaluable: below,
    ttlDays: 28,
    version: 1,
    signal: null,
    report: "campaign",
  },
  {
    key: "AN13",
    title: "Ad clicks and website visits don't line up",
    cadence: "weekly",
    list: "opportunities",
    recurrence: "condition",
    evaluable: never,
    ttlDays: 28,
    version: 1,
    signal: null,
    report: "campaign",
  },
  {
    key: "AN14",
    title: "Google Ads results changed",
    cadence: "weekly",
    list: "changed",
    recurrence: "condition",
    evaluable: never,
    ttlDays: 28,
    version: 1,
    signal: null,
    report: null,
  },
  {
    key: "AN15",
    title: "Goal pace",
    cadence: "daily",
    list: "opportunities",
    recurrence: "event",
    evaluable: never,
    // Pratikte ay sonunda biter (lifecycle.ts expiryReason).
    ttlDays: 31,
    version: 1,
    signal: null,
    report: null,
  },
];

// Bulgu üretmeyen ya da ertelenen kurallar (dokümantasyon ve operatör kartı).
// AN13 ve AN14 GA-F6 ile gerçek kural oldu (GA_RULES).
export const GA_DEFERRED_RULES: readonly {
  key: "AN16" | "AN11-AOV";
  title: string;
  note: string;
}[] = [
  {
    key: "AN16",
    title: "Holidays and seasonality",
    note: "modifier: holidays and seasonality",
  },
  {
    key: "AN11-AOV",
    title: "Basket value change",
    note: "recorded in AN11 evidence, not evaluated yet",
  },
];

const BY_KEY: ReadonlyMap<GaRuleKey, GaRuleDef> = new Map(
  GA_RULES.map((rule) => [rule.key, rule]),
);

const KEY_SET: ReadonlySet<string> = new Set(GA_RULE_KEYS);

export function isGaRuleKey(value: unknown): value is GaRuleKey {
  return typeof value === "string" && KEY_SET.has(value);
}

export function gaRule(key: GaRuleKey): GaRuleDef {
  const rule = BY_KEY.get(key);
  // GA_RULES her anahtarı içerir (registry.test.ts); buraya düşmek kod hatası.
  if (!rule) throw new Error(`Unknown GA rule ${key}`);
  return rule;
}

export function isEvaluable(
  ruleKey: GaRuleKey,
  evidence: GaFindingEvidence,
): boolean {
  return gaRule(ruleKey).evaluable(evidence);
}
