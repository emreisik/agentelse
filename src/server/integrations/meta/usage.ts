// Meta'nın kullanım başlıklarının saf ayrıştırması (docs/meta-ads-plan.md
// §3.1, §5.1). Karar Meta'nın kendi ölçümüne göre verilir: hesap başına
// X-Ad-Account-Usage, iş kullanım durumu başına X-Business-Use-Case-Usage
// (çağrı sayısı, CPU ve duvar saati yüzdeleri), insights için
// X-FB-Ads-Insights-Throttle ve uygulama düzeyi X-App-Usage.

import type { MetaLane } from "./call-context";

export type AccountUsage = {
  // 0-100: başlıklardaki yüzdelerin en büyüğü.
  pct: number;
  at: string;
  tier?: string;
  // Meta'nın "erişim geri gelir" tahmini (saniye).
  regainSeconds?: number;
  // X-Ad-Account-Usage.reset_time_duration (saniye).
  resetSeconds?: number;
  appPct?: number;
};

type HeaderSource = { get(name: string): string | null };

function json(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function num(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

export function usageFromHeaders(
  headers: HeaderSource,
  now: Date,
): AccountUsage | null {
  const percents: number[] = [];
  let tier: string | undefined;
  let regainSeconds: number | undefined;
  let resetSeconds: number | undefined;
  let appPct: number | undefined;

  const account = json(headers.get("x-ad-account-usage")) as Record<
    string,
    unknown
  > | null;
  if (account) {
    const pct = num(account.acc_id_util_pct);
    if (pct !== undefined) percents.push(pct);
    const reset = num(account.reset_time_duration);
    if (reset !== undefined && reset > 0) resetSeconds = reset;
    if (typeof account.ads_api_access_tier === "string") {
      tier = account.ads_api_access_tier;
    }
  }

  const buc = json(headers.get("x-business-use-case-usage")) as Record<
    string,
    unknown
  > | null;
  if (buc) {
    for (const entries of Object.values(buc)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries as Record<string, unknown>[]) {
        for (const key of ["call_count", "total_cputime", "total_time"]) {
          const pct = num(entry[key]);
          if (pct !== undefined) percents.push(pct);
        }
        // Meta bunu dakika cinsinden verir.
        const regainMinutes = num(entry.estimated_time_to_regain_access);
        if (regainMinutes !== undefined && regainMinutes > 0) {
          regainSeconds = Math.max(regainSeconds ?? 0, regainMinutes * 60);
        }
        if (typeof entry.ads_api_access_tier === "string" && !tier) {
          tier = entry.ads_api_access_tier;
        }
      }
    }
  }

  const insights = json(headers.get("x-fb-ads-insights-throttle")) as Record<
    string,
    unknown
  > | null;
  if (insights) {
    const pct = num(insights.acc_id_util_pct);
    if (pct !== undefined) percents.push(pct);
    appPct = num(insights.app_id_util_pct);
  }

  const app = json(headers.get("x-app-usage")) as Record<string, unknown> | null;
  if (app) {
    const values = ["call_count", "total_cputime", "total_time"]
      .map((key) => num(app[key]))
      .filter((value): value is number => value !== undefined);
    if (values.length > 0) appPct = Math.max(appPct ?? 0, ...values);
  }

  if (percents.length === 0 && appPct === undefined) return null;
  return {
    pct: percents.length > 0 ? Math.max(...percents) : 0,
    at: now.toISOString(),
    ...(tier ? { tier } : {}),
    ...(regainSeconds ? { regainSeconds } : {}),
    ...(resetSeconds ? { resetSeconds } : {}),
    ...(appPct !== undefined ? { appPct } : {}),
  };
}

// Şerit kararı: Meta'nın bloğu herkes için geçerlidir; %75'te arka plan,
// %90'da kullanıcı işi de bekler, güvenlik şeridi (P0) yalnız bloğa uyar.
export const BACKGROUND_PAUSE_PCT = 75;
export const USER_PAUSE_PCT = 90;

export type LaneDecision =
  | { allow: true }
  | { allow: false; retryAt: Date; reason: string };

export function laneDecision(input: {
  lane: MetaLane;
  usage: AccountUsage | null;
  blockedUntil: Date | null;
  now: Date;
}): LaneDecision {
  const { lane, usage, blockedUntil, now } = input;
  if (blockedUntil && blockedUntil.getTime() > now.getTime()) {
    return {
      allow: false,
      retryAt: blockedUntil,
      reason: "Meta is rate-limiting this ad account",
    };
  }
  if (!usage || lane === "P0_SAFETY") return { allow: true };
  // Eski bir ölçüm kararı bağlamasın: 5 dakikadan eskiyse serbest.
  if (now.getTime() - Date.parse(usage.at) > 5 * 60_000) return { allow: true };
  const retryAt = new Date(now.getTime() + 60_000);
  if (usage.pct >= USER_PAUSE_PCT) {
    return { allow: false, retryAt, reason: "ad account usage above 90%" };
  }
  if (usage.pct >= BACKGROUND_PAUSE_PCT && lane === "P2_BACKGROUND") {
    return { allow: false, retryAt, reason: "ad account usage above 75%" };
  }
  return { allow: true };
}

// Kota hatasından sonra bekleme: Meta'nın tahmini varsa o, yoksa sabit blok
// süresi (Dev 300 sn, Full 60 sn; bütçe değişim sınırı 60 dk; günlük
// spend_cap sınırı gün sonu; alt kodsuz 613 kötüye kullanım koruması 60 dk).
export function blockedUntilAfter(input: {
  code?: number;
  subcode?: number;
  usage: AccountUsage | null;
  now: Date;
}): Date {
  const { code, subcode, usage, now } = input;
  const at = (seconds: number) => new Date(now.getTime() + seconds * 1000);
  if (code === 613 && subcode === 1487632) return at(60 * 60);
  if (code === 17 && subcode === 1885172) {
    const endOfDay = new Date(now);
    endOfDay.setUTCHours(24, 0, 0, 0);
    return endOfDay;
  }
  const meta = Math.max(usage?.regainSeconds ?? 0, usage?.resetSeconds ?? 0);
  if (meta > 0) return at(meta);
  if (code === 613 && subcode === undefined) return at(60 * 60);
  const full =
    usage?.tier === "standard_access" || usage?.tier?.toLowerCase() === "full";
  return at(full ? 60 : 300);
}
