import { maskGoogleText } from "@/server/integrations/google/pii";

import { gaCheckDef } from "./registry";
import type {
  GaCheckEvidence,
  GaCheckKey,
  GaCheckResult,
  GaCheckSeverity,
  GaCheckStatus,
} from "./types";

// GA-F3 ölçüm sağlığı kontrollerinin ortak bilinen değerleri ve yardımcıları
// (docs/measurement-health.md): standart medium listesi, ödeme/giriş
// ağ geçitleri, AB/AEA ülkeleri, gelişmiş ölçüm olayları, Google'dan gelen
// etiketlerin maskelenmesi ve sonuç kurucu. Saf, izomorfik modül.

// GA'nın varsayılan kanal kurallarının tanıdığı medium'lar. Büyük harfli
// yazım (ör. "Email") standart sayılmaz: GA eşleştirmesi küçük harflidir.
const STANDARD_MEDIUM =
  /^(\(none\)|\(not set\)|organic|referral|e-?mail|e_mail|affiliate|display|banner|expandable|interstitial|cpm|video|audio|push|mobile|notification|sms|social|social[-_ ]?(network|media)|sm|.*cp.*|ppc|retargeting|paid.*|organic_social|organic-social)$/;

export function isStandardMedium(medium: string): boolean {
  return medium === medium.toLowerCase() && STANDARD_MEDIUM.test(medium);
}

// Ödeme ve giriş sayfaları: kullanıcı oradan dönünce oturum yeni bir
// yönlendirmeyle başlar ve satış ödeme sağlayıcısına yazılır (MH10).
const GATEWAY_PARTS = [
  "paypal",
  "stripe",
  "iyzico",
  "iyzipay",
  "payu",
  "klarna",
  "adyen",
  "mollie",
  "accounts.google.com",
  "appleid.apple.com",
  "login.microsoftonline.com",
];

export function isGatewaySource(source: string): boolean {
  const value = source.trim().toLowerCase();
  if (value.startsWith("checkout.")) return true;
  return GATEWAY_PARTS.some((part) => value.includes(part));
}

// AB27 (Çekya iki adıyla) + İzlanda, Lihtenştayn, Norveç; GA `country`
// boyutunun İngilizce adları (MH23 rıza sinyali).
export const EU_EEA_COUNTRIES: ReadonlySet<string> = new Set([
  "Austria",
  "Belgium",
  "Bulgaria",
  "Croatia",
  "Cyprus",
  "Czechia",
  "Czech Republic",
  "Denmark",
  "Estonia",
  "Finland",
  "France",
  "Germany",
  "Greece",
  "Hungary",
  "Ireland",
  "Italy",
  "Latvia",
  "Lithuania",
  "Luxembourg",
  "Malta",
  "Netherlands",
  "Poland",
  "Portugal",
  "Romania",
  "Slovakia",
  "Slovenia",
  "Spain",
  "Sweden",
  "Iceland",
  "Liechtenstein",
  "Norway",
]);

// Gelişmiş ölçümün otomatik olayları (MH17; v1alpha Admin API çağrılmaz,
// ambardaki 'events' dilimlerinden okunur).
export const ENHANCED_MEASUREMENT_EVENTS: readonly string[] = [
  "scroll",
  "click",
  "file_download",
  "video_start",
  "video_progress",
  "view_search_results",
  "form_start",
  "form_submit",
];

// Kanıtta gösterilen Google kökenli etiket: kişisel veri maskeli, en çok 80
// karakter.
export const MAX_LABEL_LENGTH = 80;
export const MAX_LABELS = 5;

export function cleanLabel(value: string): string {
  return maskGoogleText(value).slice(0, MAX_LABEL_LENGTH);
}

// Oranlar 3 ondalığa yuvarlanmış kesirdir.
export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

// Kontrol sonucu: PASS/UNKNOWN kayıt defterinin varsayılan önem derecesini
// taşır; WARN/FAIL için önem derecesi çağıran tarafından verilir.
export function checkResult(
  key: GaCheckKey,
  status: GaCheckStatus,
  evidence: GaCheckEvidence & { reason: string },
  options: { severity?: GaCheckSeverity; days?: string[] } = {},
): GaCheckResult {
  const severity =
    status === "PASS" || status === "UNKNOWN" || !options.severity
      ? gaCheckDef(key).defaultSeverity
      : options.severity;
  return {
    key,
    status,
    severity,
    evidence,
    ...(options.days && options.days.length > 0
      ? { days: [...new Set(options.days)].sort() }
      : {}),
  };
}

// Yalnız gerekçe taşıyan UNKNOWN sonuç.
export function unknownResult(key: GaCheckKey, reason: string): GaCheckResult {
  return checkResult(key, "UNKNOWN", { reason });
}
