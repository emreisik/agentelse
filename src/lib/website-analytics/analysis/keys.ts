import { isoYearIsoWeekKey } from "@/lib/website-analytics/weeks";

import type {
  GaDecompositionMetric,
  GaPeriod,
  GaPeriodGrain,
  GaRange,
  GaRuleKey,
} from "./types";

// GA-F4 bulgu anahtarları (docs/google-analytics-plan.md §3.6, §4; ayrıntı
// docs/website-insights.md "Veri modeli"). Parmak izi bağ + kural + konu
// özeti + dönemdir; konu özeti (subjectKey) FNV-1a 64 bit olduğundan parmak
// izi ve sinyal externalRef'i sayfa yolu taşımaz. node:crypto ve BigInt yok:
// saf ve izomorfik.

const SUBJECT_TEXT_MAX = 200;

const encoder = new TextEncoder();

// FNV-1a 64 bit, iki 32 bitlik yarım ile. Asal 2^40 + 0x1b3 olduğundan çarpım
// alt yarı × 0x1b3 (tam sayı olarak kesin, < 2^41) ve üst yarıya taşan
// kısımlardan oluşur.
export function subjectKeyOf(subject: string): string {
  let hi = 0xcbf29ce4;
  let lo = 0x84222325;
  for (const byte of encoder.encode(subject)) {
    lo = (lo ^ byte) >>> 0;
    const loProduct = lo * 0x1b3;
    const carry = Math.floor(loProduct / 0x1_0000_0000);
    hi = (Math.imul(hi, 0x1b3) + Math.imul(lo, 0x100) + carry) >>> 0;
    lo = loProduct >>> 0;
  }
  return hi.toString(16).padStart(8, "0") + lo.toString(16).padStart(8, "0");
}

const METRIC_LABELS: Record<GaDecompositionMetric, string> = {
  keyEvents: "Key events",
  sessions: "Visits",
  revenue: "Revenue",
};

function isMetric(value: string): value is GaDecompositionMetric {
  return value in METRIC_LABELS;
}

// Konunun kullanıcıya gösterilen adı (İngilizce arayüz metni). Yol ve
// kampanya adları zaten maskelenmiş saklanır.
export function subjectLabelOf(subject: string): string {
  if (subject === "site" || subject === "site:week") return "Your site";
  if (subject.startsWith("site:")) {
    const metric = subject.split(":")[1] ?? "";
    return isMetric(metric) ? METRIC_LABELS[metric] : "Your site";
  }
  if (subject.startsWith("page:")) return subject.slice("page:".length);
  if (subject.startsWith("channel:")) {
    const rest = subject.slice("channel:".length);
    const cut = rest.lastIndexOf(":");
    return cut > 0 ? rest.slice(0, cut) : rest;
  }
  if (subject.startsWith("campaign:")) {
    const parts = subject.slice("campaign:".length).split("|");
    // Kaynak ve ortam sonda; adın kendisi "|" içerebilir.
    return parts.length >= 3 ? parts.slice(0, -2).join("|") : (parts[0] ?? "");
  }
  if (subject.startsWith("funnel:")) {
    const [from, to] = subject.slice("funnel:".length).split(">");
    return to === undefined ? (from ?? "") : `${from} → ${to}`;
  }
  if (subject.startsWith("goal:")) return "Goal";
  if (subject.startsWith("meta_campaign:")) return "Meta campaign";
  // Google Ads kampanya adı konuya maskelenmiş yazılır.
  if (subject.startsWith("google_ads:")) {
    return subject.slice("google_ads:".length);
  }
  switch (subject) {
    case "device:mobile":
      return "Mobile";
    case "audience:returning":
      return "Returning visitors";
    case "ai:assistants":
      return "AI assistants";
    case "site_search":
      return "Site search";
    case "notfound":
      return "Missing pages";
    case "content":
      return "Content";
    default:
      return subject;
  }
}

// "2026-10-05" → "2026-W41"; ISO yılı haftanın Perşembe'sinin yılıdır.
export function isoWeekKey(day: string): string {
  const key = isoYearIsoWeekKey(day);
  return `${key.slice(0, 4)}-W${key.slice(4)}`;
}

export function periodOf(
  grain: GaPeriodGrain,
  range: GaRange,
  suffix?: string,
): GaPeriod {
  let key: string;
  switch (grain) {
    case "DAY":
      key = range.from;
      break;
    case "WEEK":
      key = isoWeekKey(range.from);
      break;
    case "MONTH":
      key = range.from.slice(0, 7);
      break;
    case "WINDOW28":
      key = `${isoWeekKey(range.to)}:28d`;
      break;
  }
  if (suffix) key = `${key}:${suffix}`;
  return { grain, from: range.from, to: range.to, key };
}

export function gaFindingFingerprint(input: {
  linkId: string;
  ruleKey: GaRuleKey;
  subjectKey: string;
  periodKey: string;
}): string {
  return `${input.linkId}:${input.ruleKey}:${input.subjectKey}:${input.periodKey}`;
}

// Gölge satır canlıya devredilince parmak izi bununla değişir (@unique kalsın).
export function shadowRetiredFingerprint(
  fingerprint: string,
  id: string,
): string {
  return `${fingerprint}#shadow:${id}`;
}

// Sinyal anahtarı: aynı konu aynı ISO haftada tek sinyal.
export function gaSignalExternalRef(input: {
  linkId: string;
  ruleKey: GaRuleKey;
  subjectKey: string;
  periodEnd: string;
}): string {
  return `ga:${input.linkId}:${input.ruleKey}:${input.subjectKey}:${isoWeekKey(input.periodEnd)}`;
}

function cap(text: string): string {
  return text.slice(0, SUBJECT_TEXT_MAX);
}

// Konu metinlerinin tek kaynağı; serbest metin 200 karakterle kırpılır.
export const GaSubjects = {
  site: (): "site" => "site",
  siteWeek: (): "site:week" => "site:week",
  change: (
    metric: GaDecompositionMetric,
    comparison: "wow" | "mom" | "yoy",
  ): string => `site:${metric}:${comparison}`,
  page: (path: string): string => `page:${cap(path)}`,
  channel: (name: string, measure: "engagement" | "keyEventRate"): string =>
    `channel:${cap(name)}:${measure}`,
  mobile: (): "device:mobile" => "device:mobile",
  returning: (): "audience:returning" => "audience:returning",
  ai: (): "ai:assistants" => "ai:assistants",
  siteSearch: (): "site_search" => "site_search",
  notFound: (): "notfound" => "notfound",
  content: (): "content" => "content",
  funnel: (from: string, to: string): string =>
    `funnel:${cap(from)}>${cap(to)}`,
  campaign: (name: string, source: string, medium: string): string =>
    `campaign:${cap(name)}|${cap(source)}|${cap(medium)}`,
  goal: (goalId: string): string => `goal:${cap(goalId)}`,
  metaCampaign: (id: string): string => `meta_campaign:${cap(id)}`,
  // Ad zaten maskelenmiş olmalı (google-ads.ts maskedAdsCampaign).
  googleAdsCampaign: (maskedName: string): string =>
    `google_ads:${cap(maskedName)}`,
};
