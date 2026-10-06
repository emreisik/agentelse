import { addDays } from "@/lib/website-analytics/days";

import { hostOfUri, sameOrSubdomain } from "./data-checks";
import { checkResult, unknownResult } from "./known-values";
import type {
  GaCheckResult,
  GaCheckStatus,
  GaHealthInputs,
  GaSiteHints,
} from "./types";

// GA-F3 yönetim ve entegrasyon kontrolleri (docs/measurement-health.md):
// GaPropertyLink'in Admin API üst verisi (anahtar olaylar, saat dilimi, veri
// saklama, Google Ads bağı, akış adresi), kimlik bilgisinin ve senkronun
// durumu: MH2, MH5, MH13, MH14, MH15, MH21 ve MH24. Sıfır Google çağrısı; saf
// modül.

// Bağı kullanılamaz kılan senkron durumları (MH24 kritik).
const BROKEN_HEALTH = new Set([
  "AUTH",
  "NEEDS_PERMISSION",
  "ACCESS_LOST",
  "GONE",
  "API_DISABLED",
]);

// MH2: günlük çekimin son penceresi 21:00 (mülk saati).
const MH2_LATE_HOUR = 21;
// MH24: en yeni gün iki günden eskiyse öğleden sonra gecikme sayılır.
const MH24_LATE_DAYS = 2;
const MH24_LATE_HOUR = 12;

const MH5_MAX_NAMES = 10;
const MH15_MIN_PAID_SESSIONS = 10;

// MH24 bağlantı sağlığı: kimlik bilgisi, senkron durumu ve en yeni gün.
export function checkMH24(input: GaHealthInputs): GaCheckResult {
  if (input.link.credentialStatus !== "ACTIVE") {
    return checkResult(
      "MH24",
      "FAIL",
      { reason: "credential" },
      { severity: "CRITICAL" },
    );
  }
  if (BROKEN_HEALTH.has(input.link.health)) {
    return checkResult(
      "MH24",
      "FAIL",
      { reason: input.link.health.toLowerCase() },
      { severity: "CRITICAL" },
    );
  }
  if (input.link.health === "DEGRADED") {
    return checkResult(
      "MH24",
      "WARN",
      { reason: "sync_failing", latestDay: input.latestStoredDay },
      { severity: "WARN" },
    );
  }
  const latestDay = input.latestStoredDay;
  if (latestDay === null) return unknownResult("MH24", "no_data");
  if (
    latestDay < addDays(input.today, -MH24_LATE_DAYS) &&
    input.propertyHour >= MH24_LATE_HOUR
  ) {
    return checkResult(
      "MH24",
      "WARN",
      { reason: "sync_late", latestDay },
      { severity: "WARN" },
    );
  }
  return checkResult("MH24", "PASS", { reason: "ok", latestDay });
}

// MH2 dünün verisi geldi mi: saklanan günlerin kendisine bakar
// (lastDailyDate'e değil). Bağlantı sağlıksızsa MH24 raporlar.
export function checkMH2(
  input: GaHealthInputs,
  mh24Status: GaCheckStatus,
): GaCheckResult {
  if (mh24Status !== "PASS") return unknownResult("MH2", "not_checked");
  const expectedDay = addDays(input.today, -1);
  const latestDay = input.latestStoredDay;
  if (
    input.propertyHour >= MH2_LATE_HOUR &&
    (latestDay === null || latestDay < expectedDay)
  ) {
    return checkResult(
      "MH2",
      "WARN",
      { reason: "late", expectedDay, latestDay },
      { severity: "INFO" },
    );
  }
  return checkResult("MH2", "PASS", { reason: "ok", expectedDay, latestDay });
}

// Sitede görülen bağlantı/form ipuçlarından önerilen anahtar olaylar.
const HINT_EVENTS: readonly [keyof GaSiteHints, string][] = [
  ["tel", "click_to_call"],
  ["whatsapp", "whatsapp_click"],
  ["mailto", "email_click"],
  ["form", "generate_lead"],
  ["maps", "get_directions"],
  ["checkout", "begin_checkout"],
];

// MH5 anahtar olaylar tanımlı mı; yalnız 'purchase' varsa ama hiç gelir ya da
// işlem yoksa sitede satış izlenmiyor demektir.
export function checkMH5(input: GaHealthInputs): GaCheckResult {
  const keyEvents = input.link.keyEvents;
  const names = [
    ...new Set((keyEvents ?? []).map((event) => event.eventName)),
  ].sort();
  const hints = input.siteTag?.hints ?? null;
  const suggestions = hints
    ? HINT_EVENTS.filter(
        ([hint, name]) => hints[hint] && !names.includes(name),
      ).map(([, name]) => name)
    : [];
  const evidence = {
    count: names.length,
    names: names.slice(0, MH5_MAX_NAMES),
    suggestions,
  };
  if (keyEvents === null) {
    return checkResult("MH5", "UNKNOWN", { reason: "not_read", ...evidence });
  }
  if (names.length === 0) {
    return checkResult(
      "MH5",
      "WARN",
      { reason: "no_key_events", ...evidence },
      { severity: "WARN" },
    );
  }
  const sales = input.days.reduce(
    (total, day) => total + day.revenueMicros + day.transactions,
    0,
  );
  if (names.every((name) => name === "purchase") && sales === 0) {
    return checkResult(
      "MH5",
      "WARN",
      { reason: "only_purchase", ...evidence },
      { severity: "WARN" },
    );
  }
  return checkResult("MH5", "PASS", { reason: "ok", ...evidence });
}

// Saat diliminin `at` anındaki UTC farkı (dakika); geçersiz dilimde null.
export function tzOffsetMinutes(timeZone: string, at: Date): number | null {
  try {
    const part = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "longOffset",
    })
      .formatToParts(at)
      .find((item) => item.type === "timeZoneName")?.value;
    if (!part) return null;
    if (part === "GMT") return 0;
    const match = /^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(part);
    if (!match) return null;
    const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0);
    return match[1] === "-" ? -minutes : minutes;
  } catch {
    return null;
  }
}

// MH13 mülk saat dilimi projeninkiyle (Instagram yayın takvimi) aynı mı;
// adlar değil, şu anki UTC farkları kıyaslanır.
export function checkMH13(input: GaHealthInputs): GaCheckResult {
  const projectTimeZone = input.project.timeZone;
  const propertyTimeZone = input.link.timeZone;
  if (!projectTimeZone) return unknownResult("MH13", "no_project_tz");
  if (!propertyTimeZone) return unknownResult("MH13", "not_read");
  const evidence = { propertyTimeZone, projectTimeZone };
  const property = tzOffsetMinutes(propertyTimeZone, input.now);
  const project = tzOffsetMinutes(projectTimeZone, input.now);
  if (property === null || project === null) {
    return checkResult("MH13", "UNKNOWN", {
      reason: "invalid_tz",
      ...evidence,
    });
  }
  if (property !== project) {
    return checkResult(
      "MH13",
      "WARN",
      { reason: "timezone_mismatch", ...evidence },
      { severity: "INFO" },
    );
  }
  return checkResult("MH13", "PASS", { reason: "ok", ...evidence });
}

// MH14 olay verisi saklama süresi (iki ay, yıl karşılaştırmalarını kısar).
export function checkMH14(input: GaHealthInputs): GaCheckResult {
  const dataRetention = input.link.dataRetention;
  if (!dataRetention) return unknownResult("MH14", "not_read");
  if (dataRetention === "TWO_MONTHS") {
    return checkResult(
      "MH14",
      "WARN",
      { reason: "two_months", dataRetention },
      { severity: "INFO" },
    );
  }
  return checkResult("MH14", "PASS", { reason: "ok", dataRetention });
}

// MH15 Google Ads bağı: ambar sorgu dizesini attığı için gclid görünmez;
// vekil olarak 28 günde 'google / cpc' oturumları kullanılır.
export function checkMH15(input: GaHealthInputs): GaCheckResult {
  const links = input.link.googleAdsLinks;
  if (links === null) return unknownResult("MH15", "not_read");
  const paidSessions = input.window28.sourceMedium
    .filter(
      (row) =>
        (row.key[0] ?? "").toLowerCase() === "google" &&
        (row.key[1] ?? "").toLowerCase() === "cpc",
    )
    .reduce((total, row) => total + (row.values[0] ?? 0), 0);
  if (paidSessions < MH15_MIN_PAID_SESSIONS) {
    return checkResult("MH15", "PASS", {
      reason: "no_paid_search",
      paidSessions,
      links,
    });
  }
  if (links === 0) {
    return checkResult(
      "MH15",
      "WARN",
      { reason: "ads_not_linked", paidSessions, links },
      { severity: "INFO" },
    );
  }
  return checkResult("MH15", "PASS", { reason: "ok", paidSessions, links });
}

// MH21 mülkün web akışı projenin alan adıyla eşleşiyor mu (birbirinin alt
// alan adı da eşleşme sayılır).
export function checkMH21(input: GaHealthInputs): GaCheckResult {
  const projectDomain = hostOfUri(input.project.domain);
  if (!projectDomain) return unknownResult("MH21", "no_domain");
  const streamHost = hostOfUri(input.link.streamUri);
  if (!streamHost) return unknownResult("MH21", "no_stream");
  const evidence = { streamHost, projectDomain };
  if (
    sameOrSubdomain(streamHost, projectDomain) ||
    sameOrSubdomain(projectDomain, streamHost)
  ) {
    return checkResult("MH21", "PASS", { reason: "ok", ...evidence });
  }
  return checkResult(
    "MH21",
    "WARN",
    { reason: "domain_mismatch", ...evidence },
    { severity: "WARN" },
  );
}
