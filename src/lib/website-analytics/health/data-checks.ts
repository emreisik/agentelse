import { isValidDomain, normalizeDomain } from "@/lib/domain";
import { addDays } from "@/lib/website-analytics/days";
import type { GaTableRow } from "@/lib/website-analytics/slices";

import {
  lastDays,
  median,
  sameWeekdayMedian,
  share,
  sumColumn,
} from "./baseline";
import {
  ENHANCED_MEASUREMENT_EVENTS,
  MAX_LABELS,
  checkResult,
  cleanLabel,
  isGatewaySource,
  isStandardMedium,
  round3,
  unknownResult,
} from "./known-values";
import { siteDoubleLoad } from "./site-checks";
import type {
  GaCheckResult,
  GaCheckSeverity,
  GaCheckStatus,
  GaHealthDay,
  GaHealthInputs,
  GaRealtimeState,
} from "./types";

// GA-F3 veri kontrolleri (docs/measurement-health.md): GA-F2 ambarının günlük
// toplamları, 28 günlük dilimleri, kırılımları ve dilim kalitesi üzerinden
// MH1, MH1_RT, MH4, MH6–MH12, MH16–MH20 ve MH22. Sıfır Google çağrısı; saf
// modül. "Son N gün" pencereleri daima completeThrough'da (günlük çekimin
// bitirdiği son gün) biter, yarım bir dün asla yargılanmaz. Kanıtta sayfa
// yolu ya da değer yok; Google kökenli etiketler cleanLabel'dan geçer.

// MH1: aynı hafta günü medyanı bu oturumun altındaysa gün yargılanmaz.
const MH1_MIN_EXPECTED = 20;
const MH1_STOPPED_RATIO = 0.1;
const MH1_DROPPED_RATIO = 0.5;
const MH1_WEEK_BLOCKS = 8;
const MH1_MIN_BLOCKS = 4;
// Gün sonu çekimi bu kadar geride kaldıysa MH1 susar; MH24 raporlar.
const SYNC_LATE_DAYS = 3;

// MH1_RT: aynı mülk gününde art arda sıfır okuma.
const RT_ZERO_READINGS = 3;

const MH4_MIN_SESSIONS = 50;
const MH4_MIN_BASELINE_DAYS = 14;
const MH4_FACTOR = 2;
const MH4_ENGAGEMENT = 0.95;

const MH6_MIN_HISTORY_DAYS = 21;
const MH6_DOUBLE_FACTOR = 3;

const MIN_COVERAGE_DAYS = 21;
const MIN_ATTRIBUTION_SESSIONS = 200;
const MIN_UTM_SESSIONS = 50;
const MH7_UNASSIGNED_SHARE = 0.05;
const MH9_SELF_SHARE = 0.02;
const MH10_GATEWAY_SHARE = 0.005;
const MH11_NOT_SET_SHARE = 0.05;

const MH17_MIN_SESSIONS = 200;
const MH18_THRESHOLD_SHARE = 0.2;

const MH20_MIN_DAYS = 14;
const MH20_BASE_DAYS = 28;
const MH20_FACTOR = 3;
const MH20_FLOOR = 30;
const MH20_ENGAGEMENT = 0.05;

const MH22_MIN_SESSIONS = 50;
const MH22_MIN_SECONDS = 1;

const NOT_SET = "(not set)";

function sumDays(
  days: readonly GaHealthDay[],
  field: keyof Omit<GaHealthDay, "day" | "isFinal" | "synthetic">,
): number {
  return days.reduce((total, day) => total + day[field], 0);
}

function daysBetween(
  days: readonly GaHealthDay[],
  from: string,
  to: string,
): GaHealthDay[] {
  return days.filter((day) => day.day >= from && day.day <= to);
}

function laterDay(a: string, b: string): string {
  return a > b ? a : b;
}

// Kesir 3 ondalığa yuvarlı; payda 0 ise null.
function rate(part: number, total: number): number | null {
  const value = share(part, total);
  return value === null ? null : round3(value);
}

function last7Of(input: GaHealthInputs): GaHealthDay[] | null {
  return input.completeThrough
    ? lastDays(input.days, input.completeThrough, 7)
    : null;
}

// Oran → durum: < %10 durdu (kritik), < %50 sert düşüş.
function ratioVerdict(ratio: number): {
  status: GaCheckStatus;
  reason: string;
  severity?: GaCheckSeverity;
} {
  if (ratio < MH1_STOPPED_RATIO) {
    return { status: "FAIL", reason: "stopped", severity: "CRITICAL" };
  }
  if (ratio < MH1_DROPPED_RATIO) {
    return { status: "WARN", reason: "dropped", severity: "WARN" };
  }
  return { status: "PASS", reason: "ok" };
}

// MH1 veri geliyor mu: completeThrough'da biten son 7 günün her biri aynı
// hafta gününün 8 haftalık medyanıyla (şüpheli günler hariç) kıyaslanır;
// durum en yeni yargılanan günden gelir. Hiçbir gün yargılanamazsa (küçük
// site) 7 günlük toplam önceki 7 günlük blokların medyanıyla kıyaslanır.
export function checkMH1(input: GaHealthInputs): GaCheckResult {
  const end = input.completeThrough;
  if (!end) return unknownResult("MH1", "not_ready");
  if (input.days.length === 0) return unknownResult("MH1", "no_data");
  if (end < addDays(input.today, -SYNC_LATE_DAYS)) {
    return unknownResult("MH1", "sync_late");
  }
  const exclude = new Set(input.suspectDays);
  const from = laterDay(addDays(end, -6), addDays(input.today, -7));
  const judged: { day: GaHealthDay; expected: number; ratio: number }[] = [];
  for (const day of daysBetween(input.days, from, end)) {
    const base = sameWeekdayMedian(input.days, day.day, exclude);
    if (base.median === null || base.median < MH1_MIN_EXPECTED) continue;
    judged.push({
      day,
      expected: base.median,
      ratio: day.sessions / base.median,
    });
  }
  judged.sort((a, b) => (a.day.day < b.day.day ? -1 : 1));

  const latest = judged[judged.length - 1];
  if (latest) {
    const verdict = ratioVerdict(latest.ratio);
    return checkResult(
      "MH1",
      verdict.status,
      {
        reason: verdict.reason,
        mode: "day",
        day: latest.day.day,
        sessions: latest.day.sessions,
        expected: Math.round(latest.expected),
        ratio: round3(latest.ratio),
        synthetic: latest.day.synthetic,
      },
      {
        severity: verdict.severity,
        days: judged
          .filter((item) => item.ratio < MH1_STOPPED_RATIO)
          .map((item) => item.day.day),
      },
    );
  }

  // Hafta kipi: tam 7 günlük bloklar (C-7k'da biten), en az 4 blok.
  const last7 = lastDays(input.days, end, 7);
  if (!last7) return unknownResult("MH1", "low_volume");
  const blocks: number[] = [];
  for (let k = 1; k <= MH1_WEEK_BLOCKS; k += 1) {
    const block = lastDays(input.days, addDays(end, -7 * k), 7);
    if (block) blocks.push(sumDays(block, "sessions"));
  }
  const expected = blocks.length >= MH1_MIN_BLOCKS ? median(blocks) : null;
  if (expected === null || expected < MH1_MIN_EXPECTED) {
    return unknownResult("MH1", "low_volume");
  }
  const sessions = sumDays(last7, "sessions");
  const ratio = sessions / expected;
  const verdict = ratioVerdict(ratio);
  return checkResult(
    "MH1",
    verdict.status,
    {
      reason: verdict.reason,
      mode: "week",
      day: end,
      sessions,
      expected: Math.round(expected),
      ratio: round3(ratio),
      synthetic: last7.some((day) => day.synthetic),
    },
    {
      severity: verdict.severity,
      days: verdict.status === "FAIL" ? last7.map((day) => day.day) : [],
    },
  );
}

// MH1_RT: gün içi realtime okumaları (aynı mülk günü). Bayat gün ya da hiç
// okuma yoksa bilinmiyor; uyarıyı hiçbir zaman açık tutmaz.
export function checkMH1Realtime(input: {
  today: string;
  realtime: GaRealtimeState | null;
}): GaCheckResult {
  const state = input.realtime;
  if (!state || state.day !== input.today) {
    return unknownResult("MH1_RT", "not_checked");
  }
  const evidence = {
    zeros: state.zeros,
    checks: state.checks,
    lastAt: state.lastAt,
  };
  if (state.zeros >= RT_ZERO_READINGS) {
    return checkResult(
      "MH1_RT",
      "FAIL",
      { reason: "no_live_visitors", ...evidence },
      { severity: "CRITICAL" },
    );
  }
  if (state.checks > 0) {
    return checkResult("MH1_RT", "PASS", { reason: "ok", ...evidence });
  }
  return unknownResult("MH1_RT", "not_checked");
}

// MH4 çift sayım: önce veri (oturum başına görüntüleme taban çizgisinin iki
// katı ve neredeyse tüm oturumlar etkileşimli), sonra site taraması (etiket
// iki kez yükleniyor).
export function checkMH4(input: GaHealthInputs): GaCheckResult {
  const end = input.completeThrough;
  const last7 = last7Of(input);
  let base: number | null = null;
  if (end) {
    const history = daysBetween(input.days, addDays(end, -55), addDays(end, -7))
      .filter((day) => day.sessions > 0)
      .map((day) => day.screenPageViews / day.sessions);
    base = history.length >= MH4_MIN_BASELINE_DAYS ? median(history) : null;
  }
  const sessions = last7 ? sumDays(last7, "sessions") : 0;
  const views = last7 ? sumDays(last7, "screenPageViews") : 0;
  const engaged = last7 ? sumDays(last7, "engagedSessions") : 0;
  const evidence = {
    viewsPerSession: rate(views, sessions),
    baselineViewsPerSession: base === null ? null : round3(base),
    engagementRate: rate(engaged, sessions),
  };
  const dataEvaluable =
    last7 !== null && base !== null && base > 0 && sessions >= MH4_MIN_SESSIONS;
  if (dataEvaluable && base !== null && last7) {
    const doubled =
      views / sessions >= MH4_FACTOR * base &&
      engaged / sessions > MH4_ENGAGEMENT;
    if (doubled) {
      return checkResult(
        "MH4",
        "WARN",
        { reason: "double_count_data", ...evidence },
        {
          severity: "WARN",
          days: last7
            .filter(
              (day) =>
                day.sessions > 0 &&
                day.screenPageViews / day.sessions >= MH4_FACTOR * base,
            )
            .map((day) => day.day),
        },
      );
    }
  }
  const site = siteDoubleLoad(input.siteTag);
  if (site === true) {
    return checkResult(
      "MH4",
      "WARN",
      { reason: "double_load", ...evidence },
      { severity: "WARN" },
    );
  }
  if (!dataEvaluable && site === null) {
    return checkResult("MH4", "UNKNOWN", {
      reason: end ? "low_volume" : "not_ready",
      ...evidence,
    });
  }
  return checkResult("MH4", "PASS", { reason: "ok", ...evidence });
}

// MH6 anahtar olaylar geliyor mu: son 7 gün, önceki 28 günün (en az 21 satır)
// günlük ortalamasıyla kıyaslanır. Sıfıra düşüş kritik; üç kat artış ve
// oturum başına birden fazla anahtar olay çift tetiklemedir.
export function checkMH6(input: GaHealthInputs): GaCheckResult {
  const keyEvents = input.link.keyEvents;
  if (!keyEvents || keyEvents.length === 0) {
    return unknownResult("MH6", "no_key_events");
  }
  const end = input.completeThrough;
  if (!end) return unknownResult("MH6", "not_ready");
  const last7 = lastDays(input.days, end, 7);
  const previous = daysBetween(input.days, addDays(end, -34), addDays(end, -7));
  if (!last7 || previous.length < MH6_MIN_HISTORY_DAYS) {
    return unknownResult("MH6", "low_history");
  }
  const prevDaily = sumDays(previous, "keyEvents") / previous.length;
  const prevSessionsDaily = sumDays(previous, "sessions") / previous.length;
  const recentEvents = sumDays(last7, "keyEvents");
  const recentSessions = sumDays(last7, "sessions");
  const evidence = {
    last7: recentEvents,
    dailyBaseline: round3(prevDaily),
    perSession: rate(recentEvents, recentSessions),
  };
  if (
    recentEvents === 0 &&
    prevDaily >= 1 &&
    recentSessions >= 0.5 * 7 * prevSessionsDaily
  ) {
    return checkResult(
      "MH6",
      "FAIL",
      { reason: "stopped", ...evidence },
      { severity: "CRITICAL", days: last7.map((day) => day.day) },
    );
  }
  if (
    prevDaily > 0 &&
    recentEvents / 7 >= MH6_DOUBLE_FACTOR * prevDaily &&
    recentSessions > 0 &&
    recentEvents / recentSessions > 1
  ) {
    return checkResult(
      "MH6",
      "WARN",
      { reason: "double_fire", ...evidence },
      {
        severity: "WARN",
        days: last7
          .filter((day) => day.keyEvents >= MH6_DOUBLE_FACTOR * prevDaily)
          .map((day) => day.day),
      },
    );
  }
  return checkResult("MH6", "PASS", { reason: "ok", ...evidence });
}

// Kaynak / medium tablosunun satırları: [kaynak, medium] × [oturum, ...].
function sourceMediumRows(rows: readonly GaTableRow[]) {
  return rows.map((row) => ({
    source: row.key[0] ?? NOT_SET,
    medium: row.key[1] ?? NOT_SET,
    sessions: row.values[0] ?? 0,
  }));
}

function coverage(
  input: GaHealthInputs,
  slice: keyof GaHealthInputs["window28"]["coverage"],
): number {
  return input.window28.coverage[slice] ?? 0;
}

// Oturuma göre azalan, tekilleştirilmiş en çok 5 etiket.
function topLabels(entries: { label: string; sessions: number }[]): string[] {
  const totals = new Map<string, number>();
  for (const entry of entries) {
    const label = cleanLabel(entry.label);
    totals.set(label, (totals.get(label) ?? 0) + entry.sessions);
  }
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, MAX_LABELS)
    .map(([label]) => label);
}

// MH7 kanalsız (Unassigned) oturum payı.
export function checkMH7(input: GaHealthInputs): GaCheckResult {
  const rows = input.window28.channel;
  const total = sumColumn(rows, 0);
  if (
    coverage(input, "channel") < MIN_COVERAGE_DAYS ||
    total < MIN_ATTRIBUTION_SESSIONS
  ) {
    return unknownResult("MH7", "low_volume");
  }
  const sessions = sumColumn(
    rows.filter((row) => (row.key[0] ?? "").toLowerCase() === "unassigned"),
    0,
  );
  const value = sessions / total;
  if (value > MH7_UNASSIGNED_SHARE) {
    const pairs = topLabels(
      sourceMediumRows(input.window28.sourceMedium)
        .filter(
          (row) => !isStandardMedium(row.medium) || row.source === NOT_SET,
        )
        .map((row) => ({
          label: `${row.source} / ${row.medium}`,
          sessions: row.sessions,
        })),
    );
    return checkResult(
      "MH7",
      "WARN",
      { reason: "high_unassigned", share: round3(value), sessions, pairs },
      { severity: "WARN" },
    );
  }
  return checkResult("MH7", "PASS", {
    reason: "ok",
    share: round3(value),
    sessions,
  });
}

// Yalnız büyük/küçük harfle ayrışan yazımlar: "Instagram / instagram".
function caseVariants(values: { value: string; sessions: number }[]) {
  const groups = new Map<string, Map<string, number>>();
  for (const { value, sessions } of values) {
    const group = groups.get(value.toLowerCase()) ?? new Map<string, number>();
    group.set(value, (group.get(value) ?? 0) + sessions);
    groups.set(value.toLowerCase(), group);
  }
  const variants: { label: string; sessions: number }[] = [];
  for (const group of groups.values()) {
    if (group.size < 2) continue;
    const spellings = [...group.keys()].sort();
    const sessions = [...group.values()].reduce((sum, n) => sum + n, 0);
    variants.push({ label: spellings.join(" / "), sessions });
  }
  return variants;
}

// MH8 UTM yazım tutarlılığı: aynı kaynak/medium'un farklı harf yazımları ve
// GA'nın kanal kurallarının tanımadığı medium'lar.
export function checkMH8(input: GaHealthInputs): GaCheckResult {
  const rows = sourceMediumRows(input.window28.sourceMedium);
  const total = rows.reduce((sum, row) => sum + row.sessions, 0);
  if (
    coverage(input, "source_medium") < MIN_COVERAGE_DAYS ||
    total < MIN_UTM_SESSIONS
  ) {
    return unknownResult("MH8", "low_volume");
  }
  const variants = topLabels([
    ...caseVariants(
      rows.map((row) => ({ value: row.source, sessions: row.sessions })),
    ),
    ...caseVariants(
      rows.map((row) => ({ value: row.medium, sessions: row.sessions })),
    ),
  ]);
  const mediums = topLabels(
    rows
      .filter((row) => !isStandardMedium(row.medium))
      .map((row) => ({ label: row.medium, sessions: row.sessions })),
  );
  if (variants.length > 0 || mediums.length > 0) {
    return checkResult(
      "MH8",
      "WARN",
      { reason: "utm_variants", variants, mediums },
      { severity: "INFO" },
    );
  }
  return checkResult("MH8", "PASS", { reason: "ok", variants, mediums });
}

// Adres ya da alan adından çıplak ana makine; geçersizse null.
export function hostOfUri(value: string | null): string | null {
  if (!value) return null;
  const host = normalizeDomain(value).replace(/:\d+$/, "");
  return isValidDomain(host) ? host : null;
}

// a, b'nin kendisi ya da alt alan adı mı.
export function sameOrSubdomain(a: string, b: string): boolean {
  return a === b || a.endsWith(`.${b}`);
}

// MH9 kendi sitesinden yönlendirme: sitenin kendisi referral olarak görünüyor.
export function checkMH9(input: GaHealthInputs): GaCheckResult {
  const domain =
    hostOfUri(input.project.domain) ?? hostOfUri(input.link.streamUri);
  if (!domain) return unknownResult("MH9", "no_domain");
  const rows = sourceMediumRows(input.window28.sourceMedium);
  const total = rows.reduce((sum, row) => sum + row.sessions, 0);
  if (
    coverage(input, "source_medium") < MIN_COVERAGE_DAYS ||
    total < MIN_ATTRIBUTION_SESSIONS
  ) {
    return unknownResult("MH9", "low_volume");
  }
  const sessions = rows
    .filter((row) => {
      if (row.medium.toLowerCase() !== "referral") return false;
      const host = hostOfUri(row.source);
      return host !== null && sameOrSubdomain(host, domain);
    })
    .reduce((sum, row) => sum + row.sessions, 0);
  const value = sessions / total;
  if (value > MH9_SELF_SHARE) {
    return checkResult(
      "MH9",
      "WARN",
      { reason: "self_referral", share: round3(value), sessions, domain },
      { severity: "WARN" },
    );
  }
  return checkResult("MH9", "PASS", {
    reason: "ok",
    share: round3(value),
    sessions,
    domain,
  });
}

// MH10 ödeme/giriş sayfası yönlendirmeleri.
export function checkMH10(input: GaHealthInputs): GaCheckResult {
  const rows = sourceMediumRows(input.window28.sourceMedium);
  const total = rows.reduce((sum, row) => sum + row.sessions, 0);
  if (
    coverage(input, "source_medium") < MIN_COVERAGE_DAYS ||
    total < MIN_ATTRIBUTION_SESSIONS
  ) {
    return unknownResult("MH10", "low_volume");
  }
  const gateways = rows.filter((row) => isGatewaySource(row.source));
  const sessions = gateways.reduce((sum, row) => sum + row.sessions, 0);
  const value = sessions / total;
  if (value > MH10_GATEWAY_SHARE) {
    return checkResult(
      "MH10",
      "WARN",
      {
        reason: "gateway_referrals",
        share: round3(value),
        sources: topLabels(
          gateways.map((row) => ({
            label: row.source,
            sessions: row.sessions,
          })),
        ),
      },
      { severity: "WARN" },
    );
  }
  return checkResult("MH10", "PASS", { reason: "ok", share: round3(value) });
}

// MH11 açılış sayfası olmayan oturumlar; payda açılış tablosunun kendi
// toplamıdır ("(not set)" satırı dahil).
export function checkMH11(input: GaHealthInputs): GaCheckResult {
  const rows = input.window28.landing;
  const total = sumColumn(rows, 0);
  if (
    coverage(input, "landing_page") < MIN_COVERAGE_DAYS ||
    total < MIN_ATTRIBUTION_SESSIONS
  ) {
    return unknownResult("MH11", "low_volume");
  }
  const sessions = sumColumn(
    rows.filter((row) => (row.key[0] ?? NOT_SET) === NOT_SET),
    0,
  );
  const value = sessions / total;
  if (value > MH11_NOT_SET_SHARE) {
    return checkResult(
      "MH11",
      "WARN",
      { reason: "not_set_landing", share: round3(value), sessions },
      { severity: "WARN" },
    );
  }
  return checkResult("MH11", "PASS", {
    reason: "ok",
    share: round3(value),
    sessions,
  });
}

// MH12 sayfa adreslerinde kişisel veri: PII yoklaması (sorgu dizesi dahil)
// ve son 7 günün ambar maskeleri. Kanıtta asla yol ya da değer yok; yalnız
// izinli parametre adları ve sayılar. Gerçek düzeltmeden sonra yapılan temiz
// bir yoklama ('I fixed it') eski maskeleri yalnız bilgi notuna indirir.
export function checkMH12(input: GaHealthInputs): GaCheckResult {
  const end = input.completeThrough;
  const recent = end
    ? input.piiMarkers
        .filter(
          (marker) =>
            marker.count > 0 &&
            marker.day >= addDays(end, -6) &&
            marker.day <= end,
        )
        .map((marker) => marker.day)
    : [];
  const markerDays = new Set(recent).size;
  const newest = recent.length > 0 ? [...recent].sort().reverse()[0]! : null;
  const probe =
    input.piiProbe && input.piiProbe.outcome === "ok" ? input.piiProbe : null;

  if (probe && (probe.email || probe.phone || probe.params.length > 0)) {
    return checkResult(
      "MH12",
      "FAIL",
      {
        reason: "pii_in_url",
        params: probe.params,
        pages: probe.pages,
        views: probe.views,
        email: probe.email,
        phone: probe.phone,
        checkedAt: probe.at,
        probeFrom: probe.from,
        probeTo: probe.to,
      },
      { severity: "CRITICAL" },
    );
  }
  if (newest) {
    if (probe && probe.from > newest) {
      return checkResult(
        "MH12",
        "WARN",
        { reason: "recent_history", markerDays, checkedAt: probe.at },
        { severity: "INFO" },
      );
    }
    return checkResult(
      "MH12",
      "FAIL",
      { reason: "pii_in_path", markerDays },
      { severity: "CRITICAL" },
    );
  }
  if (probe) {
    return checkResult("MH12", "PASS", { reason: "ok", checkedAt: probe.at });
  }
  return unknownResult("MH12", "not_checked");
}

// MH16 GA'da Search Console bağlantısı (GA-F2b katalog durumu).
export function checkMH16(input: GaHealthInputs): GaCheckResult {
  switch (input.link.searchConsoleReport) {
    case "on":
      return checkResult("MH16", "PASS", { reason: "ok" });
    case "off":
      return checkResult(
        "MH16",
        "WARN",
        { reason: "not_linked" },
        { severity: "INFO" },
      );
    default:
      return unknownResult("MH16", "catalog_off");
  }
}

// MH17 gelişmiş ölçüm: otomatik olaylardan biri ambarda görünüyor mu.
export function checkMH17(input: GaHealthInputs): GaCheckResult {
  const counts = new Map<string, number>();
  for (const row of input.window28.events) {
    const name = row.key[0] ?? "";
    counts.set(name, (counts.get(name) ?? 0) + (row.values[0] ?? 0));
  }
  const seen = ENHANCED_MEASUREMENT_EVENTS.filter(
    (name) => (counts.get(name) ?? 0) > 0,
  );
  if (seen.length > 0) {
    return checkResult("MH17", "PASS", { reason: "ok", seen });
  }
  // Olay dilimi hiç yoksa (rapor kapalı ya da henüz çekilmedi) yokluk kanıt
  // sayılmaz.
  if (coverage(input, "events") === 0) {
    return checkResult("MH17", "UNKNOWN", { reason: "low_volume", seen });
  }
  const sessions = sumDays(
    daysBetween(input.days, input.window28.from, input.window28.to),
    "sessions",
  );
  if (sessions >= MH17_MIN_SESSIONS) {
    return checkResult(
      "MH17",
      "WARN",
      { reason: "enhanced_off", seen },
      { severity: "INFO" },
    );
  }
  return checkResult("MH17", "UNKNOWN", { reason: "low_volume", seen });
}

// Rapor anahtarı başına bayrak: anahtarın herhangi bir günlük dilimi
// işaretliyse anahtar işaretlidir.
function flaggedReports(
  input: GaHealthInputs,
  flag: "thresholded" | "otherRow",
): { keys: number; flagged: string[] } {
  const byKey = new Map<string, boolean>();
  for (const slice of input.quality) {
    byKey.set(
      slice.reportKey,
      (byKey.get(slice.reportKey) ?? false) || slice[flag],
    );
  }
  const flagged = [...byKey.entries()]
    .filter(([, value]) => value)
    .map(([key]) => key)
    .sort();
  return { keys: byKey.size, flagged };
}

// MH18 Google'ın eşikleme ile gizlediği küçük değerler.
export function checkMH18(input: GaHealthInputs): GaCheckResult {
  if (input.quality.length === 0) return unknownResult("MH18", "no_data");
  const { keys, flagged } = flaggedReports(input, "thresholded");
  const value = flagged.length / keys;
  const reports = flagged.slice(0, MAX_LABELS).map(cleanLabel);
  if (value > MH18_THRESHOLD_SHARE) {
    return checkResult(
      "MH18",
      "WARN",
      { reason: "thresholding", share: round3(value), reports },
      { severity: "INFO" },
    );
  }
  return checkResult("MH18", "PASS", {
    reason: "ok",
    share: round3(value),
    reports,
  });
}

// MH19 "(other)" satırına toplanan satırlar.
export function checkMH19(input: GaHealthInputs): GaCheckResult {
  if (input.quality.length === 0) return unknownResult("MH19", "no_data");
  const { flagged } = flaggedReports(input, "otherRow");
  const reports = flagged.slice(0, MAX_LABELS).map(cleanLabel);
  if (flagged.length > 0) {
    return checkResult(
      "MH19",
      "WARN",
      { reason: "other_row", reports },
      { severity: "INFO" },
    );
  }
  return checkResult("MH19", "PASS", { reason: "ok", reports });
}

type Mh20Spike = {
  dimension: "country" | "source";
  label: string;
  day: string;
  sessions: number;
};

// MH20 bot/spam dalgası: bir ülke ya da kaynakta, önceki 28 günün
// medyanının üç katını (en az 30) aşan ve neredeyse hiç etkileşim almayan
// oturum sıçraması.
export function checkMH20(input: GaHealthInputs): GaCheckResult {
  const end = input.completeThrough;
  const stored = end ? input.breakdowns.filter((day) => day.day <= end) : [];
  if (!end || stored.length < MH20_MIN_DAYS) {
    return unknownResult("MH20", "low_history");
  }
  const spikes: Mh20Spike[] = [];
  const from = laterDay(addDays(input.today, -7), addDays(end, -6));
  for (const dimension of ["country", "source"] as const) {
    // gün → anahtar → [oturum, etkileşimli oturum]
    const byDay = new Map<string, Map<string, [number, number]>>();
    for (const day of stored) {
      const keys = new Map<string, [number, number]>();
      for (const row of day[dimension]) {
        const key = row.key[0] ?? NOT_SET;
        const previous = keys.get(key) ?? [0, 0];
        keys.set(key, [
          previous[0] + (row.values[0] ?? 0),
          previous[1] + (row.values[1] ?? 0),
        ]);
      }
      byDay.set(day.day, keys);
    }
    for (let day = from; day <= end; day = addDays(day, 1)) {
      const keys = byDay.get(day);
      if (!keys) continue;
      for (const [key, [sessions, engaged]] of keys) {
        if (sessions <= 0) continue;
        const history: number[] = [];
        for (let back = 1; back <= MH20_BASE_DAYS; back += 1) {
          history.push(byDay.get(addDays(day, -back))?.get(key)?.[0] ?? 0);
        }
        const base = median(history) ?? 0;
        if (
          sessions >= Math.max(MH20_FACTOR * base, MH20_FLOOR) &&
          engaged / sessions < MH20_ENGAGEMENT
        ) {
          spikes.push({ dimension, label: key, day, sessions });
        }
      }
    }
  }
  if (spikes.length === 0) return checkResult("MH20", "PASS", { reason: "ok" });
  const largest = [...spikes].sort((a, b) => b.sessions - a.sessions)[0]!;
  const days = [...new Set(spikes.map((spike) => spike.day))].sort();
  return checkResult(
    "MH20",
    "WARN",
    {
      reason: "bot_wave",
      dimension: largest.dimension,
      label: cleanLabel(largest.label),
      spikeDays: days.length,
      sessions: largest.sessions,
    },
    { severity: "WARN", days },
  );
}

// MH22 etkileşim süresi kaydediliyor mu (oturum başına en az 1 saniye).
export function checkMH22(input: GaHealthInputs): GaCheckResult {
  if (!input.completeThrough) return unknownResult("MH22", "not_ready");
  const last7 = last7Of(input);
  const sessions = last7 ? sumDays(last7, "sessions") : 0;
  if (!last7 || sessions < MH22_MIN_SESSIONS) {
    return unknownResult("MH22", "low_volume");
  }
  const seconds = sumDays(last7, "engagementSec") / sessions;
  const secondsPerSession = round3(seconds);
  if (seconds < MH22_MIN_SECONDS) {
    return checkResult(
      "MH22",
      "WARN",
      { reason: "no_engagement_time", secondsPerSession },
      { severity: "WARN" },
    );
  }
  return checkResult("MH22", "PASS", { reason: "ok", secondsPerSession });
}
