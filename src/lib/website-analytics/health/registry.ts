import {
  GA_CHECK_KEYS,
  type GaCheckCategory,
  type GaCheckKey,
  type GaCheckResult,
  type GaCheckSeverity,
  type GaCheckSource,
  type GaCheckStatus,
} from "./types";

// GA-F3 kontrol kaydı (docs/measurement-health.md "Kontroller"). Sıra
// GA_CHECK_KEYS ile aynıdır; ağırlıklar kategori içi puan payıdır, kategori
// ağırlıkları score.ts'te. Başlıklar ve uyarı metinleri sabittir: içlerinde
// rakam, sayfa yolu ya da Google'dan okunan bir değer asla yok.

export type GaCheckDef = {
  key: GaCheckKey;
  code: string;
  title: string;
  category: GaCheckCategory;
  source: GaCheckSource;
  weight: number;
  defaultSeverity: GaCheckSeverity;
  guideId: string;
  alertKind: string;
};

type Row = [
  key: GaCheckKey,
  code: string,
  title: string,
  category: GaCheckCategory,
  source: GaCheckSource,
  weight: number,
  defaultSeverity: GaCheckSeverity,
];

const ROWS: readonly Row[] = [
  ["MH1", "MH1", "Data is arriving", "data_flow", "DATA", 3, "CRITICAL"],
  ["MH1_RT", "MH1", "Live visitors today", "data_flow", "DATA", 1, "CRITICAL"],
  [
    "MH2",
    "MH2",
    "Yesterday's data is in",
    "data_flow",
    "INTEGRATION",
    0.5,
    "INFO",
  ],
  ["MH3", "MH3", "Tag on your website", "site_tag", "SITE", 2, "WARN"],
  ["MH4", "MH4", "No double counting", "site_tag", "SITE", 1, "WARN"],
  ["MH5", "MH5", "Key events are set up", "configuration", "ADMIN", 3, "WARN"],
  ["MH6", "MH6", "Key events are arriving", "data_flow", "DATA", 2, "CRITICAL"],
  ["MH7", "MH7", "Visits have a channel", "attribution", "DATA", 2, "WARN"],
  ["MH8", "MH8", "UTM tags are consistent", "attribution", "DATA", 0.5, "INFO"],
  ["MH9", "MH9", "No self-referrals", "attribution", "DATA", 1, "WARN"],
  [
    "MH10",
    "MH10",
    "No payment-page referrals",
    "attribution",
    "DATA",
    1,
    "WARN",
  ],
  [
    "MH11",
    "MH11",
    "Visits have a landing page",
    "attribution",
    "DATA",
    1,
    "WARN",
  ],
  [
    "MH12",
    "MH12",
    "No personal data in page addresses",
    "privacy",
    "DATA",
    3,
    "CRITICAL",
  ],
  ["MH13", "MH13", "Time zone matches", "configuration", "ADMIN", 1, "INFO"],
  ["MH14", "MH14", "Data retention", "configuration", "ADMIN", 1, "INFO"],
  ["MH15", "MH15", "Google Ads is linked", "configuration", "ADMIN", 1, "INFO"],
  [
    "MH16",
    "MH16",
    "Search Console is linked in Google Analytics",
    "configuration",
    "DATA",
    0.5,
    "INFO",
  ],
  ["MH17", "MH17", "Enhanced measurement", "configuration", "DATA", 1, "INFO"],
  ["MH18", "MH18", "Little data hidden by Google", "other", "DATA", 1, "INFO"],
  [
    "MH19",
    "MH19",
    "Few rows grouped as (other)",
    "attribution",
    "DATA",
    0.5,
    "INFO",
  ],
  ["MH20", "MH20", "No bot or spam waves", "other", "DATA", 1, "WARN"],
  [
    "MH21",
    "MH21",
    "Property matches your website",
    "configuration",
    "ADMIN",
    2,
    "WARN",
  ],
  [
    "MH22",
    "MH22",
    "Engagement time is recorded",
    "data_flow",
    "DATA",
    1,
    "WARN",
  ],
  ["MH23", "MH23", "Cookie consent signal", "privacy", "SITE", 1, "INFO"],
  [
    "MH24",
    "MH24",
    "Connection is healthy",
    "data_flow",
    "INTEGRATION",
    3,
    "CRITICAL",
  ],
];

export const GA_CHECKS: readonly GaCheckDef[] = ROWS.map(
  ([key, code, title, category, source, weight, defaultSeverity]) => ({
    key,
    code,
    title,
    category,
    source,
    weight,
    defaultSeverity,
    guideId: `ga-${key.toLowerCase()}`,
    alertKind: `GA_${key}`,
  }),
);

const BY_KEY = new Map<GaCheckKey, GaCheckDef>(
  GA_CHECKS.map((def) => [def.key, def]),
);

export function gaCheckDef(key: GaCheckKey): GaCheckDef {
  const def = BY_KEY.get(key);
  // Tip sistemi bilinmeyen anahtarı engeller; buraya düşmek bir programlama
  // hatasıdır.
  if (!def) throw new Error(`Unknown GA check key: ${String(key)}`);
  return def;
}

const KEY_SET: ReadonlySet<string> = new Set(GA_CHECK_KEYS);

export function isGaCheckKey(value: unknown): value is GaCheckKey {
  return typeof value === "string" && KEY_SET.has(value);
}

// B'nin üretebileceği neden kodları (sözleşme). Her anahtarda "error" da
// vardır; "ok" PASS nedenidir.
export const GA_CHECK_REASONS: Readonly<Record<GaCheckKey, readonly string[]>> =
  {
    MH1: [
      "ok",
      "stopped",
      "dropped",
      "low_volume",
      "no_data",
      "not_ready",
      "sync_late",
      "error",
    ],
    MH1_RT: ["ok", "no_live_visitors", "not_checked", "error"],
    MH2: ["ok", "late", "not_checked", "error"],
    MH3: [
      "ok",
      "not_checked",
      "no_site",
      "robots",
      "fetch_failed",
      "no_measurement_id",
      "other_id",
      "gtm_only",
      "google_tag_only",
      "client_side",
      "missing",
      "error",
    ],
    MH4: [
      "ok",
      "double_load",
      "double_count_data",
      "low_volume",
      "not_ready",
      "error",
    ],
    MH5: ["ok", "not_read", "no_key_events", "only_purchase", "error"],
    MH6: [
      "ok",
      "no_key_events",
      "low_history",
      "stopped",
      "double_fire",
      "not_ready",
      "error",
    ],
    MH7: ["ok", "low_volume", "high_unassigned", "error"],
    MH8: ["ok", "low_volume", "utm_variants", "error"],
    MH9: ["ok", "no_domain", "low_volume", "self_referral", "error"],
    MH10: ["ok", "low_volume", "gateway_referrals", "error"],
    MH11: ["ok", "low_volume", "not_set_landing", "error"],
    MH12: [
      "ok",
      "pii_in_url",
      "pii_in_path",
      "recent_history",
      "not_checked",
      "error",
    ],
    MH13: [
      "ok",
      "no_project_tz",
      "not_read",
      "invalid_tz",
      "timezone_mismatch",
      "error",
    ],
    MH14: ["ok", "not_read", "two_months", "error"],
    MH15: ["ok", "not_read", "ads_not_linked", "no_paid_search", "error"],
    MH16: ["ok", "not_linked", "catalog_off", "error"],
    MH17: ["ok", "enhanced_off", "low_volume", "error"],
    MH18: ["ok", "no_data", "thresholding", "error"],
    MH19: ["ok", "no_data", "other_row", "error"],
    MH20: ["ok", "low_history", "bot_wave", "error"],
    MH21: ["ok", "no_domain", "no_stream", "domain_mismatch", "error"],
    MH22: ["ok", "low_volume", "no_engagement_time", "not_ready", "error"],
    MH23: [
      "ok",
      "few_eu",
      "low_volume",
      "not_checked",
      "gtm_only",
      "no_consent_default",
      "error",
    ],
    MH24: [
      "ok",
      "credential",
      "auth",
      "needs_permission",
      "access_lost",
      "gone",
      "api_disabled",
      "sync_failing",
      "sync_late",
      "no_data",
      "error",
    ],
  };

export const GA_ALERT_KINDS: readonly string[] = GA_CHECKS.map(
  (def) => def.alertKind,
);

const DEDUPE_PREFIX = "ga4:";

export function gaAlertDedupeKey(linkId: string, key: GaCheckKey): string {
  return `${DEDUPE_PREFIX}${linkId}:${key}`;
}

// "ga4:<linkId>:<key>" → [linkId, key]; başka biçim null.
function splitDedupeKey(
  dedupeKey: string,
): { linkId: string; key: GaCheckKey } | null {
  if (!dedupeKey.startsWith(DEDUPE_PREFIX)) return null;
  const parts = dedupeKey.split(":");
  if (parts.length !== 3) return null;
  const [, linkId, key] = parts;
  if (!linkId || !isGaCheckKey(key)) return null;
  return { linkId, key };
}

export function gaCheckKeyOfDedupeKey(dedupeKey: string): GaCheckKey | null {
  return splitDedupeKey(dedupeKey)?.key ?? null;
}

export function gaLinkIdOfDedupeKey(dedupeKey: string): string | null {
  return splitDedupeKey(dedupeKey)?.linkId ?? null;
}

// Sorun başlıkları: durum ve nedene göre sabit metin. `reason` boşsa o
// anahtar/durum için ilk metin kullanılır.
type IssueText = { status?: "WARN" | "FAIL"; reason?: string; text: string };

const ISSUE_TEXTS: Readonly<Record<GaCheckKey, readonly IssueText[]>> = {
  MH1: [
    { status: "FAIL", text: "Google Analytics stopped receiving data" },
    {
      status: "WARN",
      text: "Website visits dropped sharply in Google Analytics",
    },
  ],
  MH1_RT: [{ text: "Google Analytics shows no visitors right now" }],
  MH2: [{ text: "Yesterday's Google Analytics data is late" }],
  MH3: [
    {
      reason: "other_id",
      text: "The website uses a different Google Analytics ID",
    },
    {
      reason: "missing",
      text: "Google Analytics tag not found on the website",
    },
  ],
  MH4: [{ text: "Visits may be counted twice" }],
  MH5: [
    { reason: "no_key_events", text: "No key events are set up" },
    {
      reason: "only_purchase",
      text: "Only purchases are tracked as key events",
    },
  ],
  MH6: [
    { status: "FAIL", text: "Key events stopped arriving" },
    { status: "WARN", text: "Key events may fire twice" },
  ],
  MH7: [{ text: "Many visits have no channel (Unassigned)" }],
  MH8: [{ text: "UTM tags are written in different ways" }],
  MH9: [{ text: "Your own site shows up as a referrer" }],
  MH10: [{ text: "Payment pages show up as referrers" }],
  MH11: [{ text: "Many visits have no landing page" }],
  MH12: [
    { status: "FAIL", text: "Personal data may be in page addresses" },
    {
      status: "WARN",
      reason: "recent_history",
      text: "Personal data was recently in page addresses",
    },
  ],
  MH13: [{ text: "Property time zone differs from the project" }],
  MH14: [{ text: "Google Analytics keeps event data for only two months" }],
  MH15: [{ text: "Google Ads traffic but Google Ads isn't linked" }],
  MH16: [{ text: "Search Console isn't linked in Google Analytics" }],
  MH17: [{ text: "Enhanced measurement looks off" }],
  MH18: [{ text: "Google hides some small values in reports" }],
  MH19: [{ text: "Some rows are grouped as (other)" }],
  MH20: [{ text: "Possible bot or spam traffic" }],
  MH21: [{ text: "The Google Analytics property may not match your website" }],
  MH22: [{ text: "Engagement time isn't being recorded" }],
  MH23: [{ text: "No cookie consent signal found" }],
  MH24: [
    { status: "FAIL", text: "Google Analytics access was lost" },
    {
      status: "WARN",
      reason: "sync_failing",
      text: "Google Analytics updates are failing",
    },
    {
      status: "WARN",
      reason: "sync_late",
      text: "Google Analytics updates are late",
    },
  ],
};

export function gaIssueTitle(
  key: GaCheckKey,
  status: GaCheckStatus,
  reason: string | null,
): string {
  const def = gaCheckDef(key);
  if (status !== "WARN" && status !== "FAIL") return def.title;
  const texts = ISSUE_TEXTS[key];
  const forStatus = texts.filter(
    (entry) => entry.status === undefined || entry.status === status,
  );
  const exact = reason
    ? forStatus.find((entry) => entry.reason === reason)
    : undefined;
  // Bilinmeyen neden → o anahtar/durum için ilk metin; durum eşleşmezse
  // anahtarın ilk metni.
  return exact?.text ?? forStatus[0]?.text ?? texts[0]?.text ?? def.title;
}

// Uyarı yalnız WARN/FAIL ve önem WARN ya da CRITICAL iken açılır; INFO
// bulgular yalnız sayfada görünür.
export function gaAlertable(
  result: Pick<GaCheckResult, "status" | "severity">,
): boolean {
  return (
    (result.status === "WARN" || result.status === "FAIL") &&
    result.severity !== "INFO"
  );
}

export const GA_UNKNOWN_KEEP_OPEN_MS = 48 * 3_600_000;

// UNKNOWN sonuç açık uyarıyı en çok 48 saat açık tutar (önceki satır
// WARN/FAIL ise ya da UNKNOWN 48 saatten kısa süredir sürüyorsa). MH1_RT gün
// içidir; hiçbir zaman açık tutmaz.
export function unknownKeepsAlertOpen(
  key: GaCheckKey,
  previous: { status: string; lastChangedAt: Date } | null,
  now: Date,
): boolean {
  if (key === "MH1_RT") return false;
  if (!previous) return true;
  if (previous.status === "WARN" || previous.status === "FAIL") return true;
  if (previous.status === "UNKNOWN") {
    return (
      now.getTime() - previous.lastChangedAt.getTime() < GA_UNKNOWN_KEEP_OPEN_MS
    );
  }
  return false;
}
