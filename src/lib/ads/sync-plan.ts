// Ayna senkronunun zamanlaması (docs/meta-ads-plan.md §3.2). Saf
// fonksiyonlar: runner yalnız bunların söylediğini yapar.

export const SYNC_LEASE_MS = 5 * 60_000;
export const HEALTH_EVERY_MS = 6 * 60 * 60_000;
export const STRUCTURE_ACTIVE_MS = 60 * 60_000;
export const STRUCTURE_IDLE_MS = 6 * 60 * 60_000;
export const INSIGHTS_ACTIVE_MS = 30 * 60_000;
export const INSIGHTS_IDLE_MS = 6 * 60 * 60_000;
// Atıf değişikliklerini yakalamak için her gün yeniden çekilen gün sayısı.
export const BACKFILL_DAYS = 28;
// Hesap ilk bağlandığında.
export const INITIAL_DAYS = 90;
// Senkron insights çağrısının en büyük aralığı (async rapor F8'de).
export const CHUNK_DAYS = 30;
// Geri doldurma hesap saatiyle bu saatten sonra koşar.
export const BACKFILL_LOCAL_HOUR = 4;
const BACKOFF_START_MS = 5 * 60_000;
const BACKOFF_MAX_MS = 6 * 60 * 60_000;

// 5 dk, 10 dk, 20 dk ... en çok 6 saat.
export function backoffMs(consecutiveFailures: number): number {
  const steps = Math.max(0, consecutiveFailures - 1);
  return Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** Math.min(steps, 12));
}

export type SyncStages = {
  health: boolean;
  structure: boolean;
  insights: boolean;
  backfill: "none" | "daily" | "initial";
};

function older(at: Date | null, now: Date, ms: number): boolean {
  return !at || now.getTime() - at.getTime() >= ms;
}

export function dueStages(input: {
  now: Date;
  lastHealthAt: Date | null;
  lastStructureAt: Date | null;
  lastInsightsAt: Date | null;
  // Hesap gününe göre son geri doldurma (YYYY-MM-DD).
  lastBackfillDate: string | null;
  // Teslimatı süren nesne var mı (aynadan)?
  activeDelivery: boolean;
  accountToday: string;
  accountHour: number;
}): SyncStages {
  const { now } = input;
  const backfill: SyncStages["backfill"] = !input.lastBackfillDate
    ? "initial"
    : input.lastBackfillDate < input.accountToday &&
        input.accountHour >= BACKFILL_LOCAL_HOUR
      ? "daily"
      : "none";
  return {
    health: older(input.lastHealthAt, now, HEALTH_EVERY_MS),
    structure: older(
      input.lastStructureAt,
      now,
      input.activeDelivery ? STRUCTURE_ACTIVE_MS : STRUCTURE_IDLE_MS,
    ),
    insights: older(
      input.lastInsightsAt,
      now,
      input.activeDelivery ? INSIGHTS_ACTIVE_MS : INSIGHTS_IDLE_MS,
    ),
    backfill,
  };
}

export function anyStageDue(stages: SyncStages): boolean {
  return (
    stages.health ||
    stages.structure ||
    stages.insights ||
    stages.backfill !== "none"
  );
}

// "2026-10-06" + n gün. Takvim aritmetiği UTC'de yapılır: anahtar zaten
// hesabın yerel günüdür.
export function addDays(dayKey: string, days: number): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d! + days));
  return date.toISOString().slice(0, 10);
}

// [since, until] aralığını en çok `chunkDays` günlük parçalara böler (eskiden
// yeniye).
export function dayRanges(
  since: string,
  until: string,
  chunkDays: number = CHUNK_DAYS,
): { since: string; until: string }[] {
  const ranges: { since: string; until: string }[] = [];
  let start = since;
  while (start <= until) {
    const end = addDays(start, chunkDays - 1);
    ranges.push({ since: start, until: end < until ? end : until });
    start = addDays(end, 1);
  }
  return ranges;
}

// Hesap saatiyle saat (0-23).
export function hourInTimezone(date: Date, timeZone: string): number {
  const hour = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    hour: "2-digit",
  }).format(date);
  return Number(hour) % 24;
}

// Hesap saat dilimi bilinmiyorsa UTC; geçersiz IANA adı da UTC'ye düşer.
export function safeTimezone(timeZone: string | null | undefined): string {
  if (!timeZone) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
    return timeZone;
  } catch {
    return "UTC";
  }
}

// Hesap saatiyle bu haftanın Pazar günü (Meta'nın haftalık 7× sınırı
// Pazar-Cumartesi takvim haftasıdır).
export function weekStartSunday(dayKey: string): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  const weekday = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
  return addDays(dayKey, -weekday);
}
