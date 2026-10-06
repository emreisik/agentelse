import {
  addDays,
  addMonths,
  addWeeks,
  dayRange,
  firstMonthStartOnOrAfter,
  firstWeekStartOnOrAfter,
  gscHour,
  gscToday,
  lastCompleteMonthStart,
  lastCompleteWeekStart,
  maxDay,
  minDay,
} from "./dates";

// Search Console senkronunun zamanlaması
// (docs/google-search-console-plan.md §3.3, §5; docs/search-analytics.md).
// Saf fonksiyonlar: runner yalnız bunların söylediğini yapar. Bütün günler
// Pasifik saatidir (Search Console'un günü).

export const GSC_SYNC_LEASE_MS = 300_000;
// Günlük çekim pencereleri (PT): sabah kesinleşen günler, akşam taze günler.
export const GSC_DAILY_HOURS = [6, 18] as const;
export const GSC_METADATA_EVERY_MS = 86_400_000;
// "Refresh" en çok bu sıklıkta (P1).
export const GSC_REFRESH_EVERY_MS = 300_000;
// Günlük çekimin geriye doğru penceresi: today−10 … dün.
export const GSC_DAILY_WINDOW_DAYS = 10;
// Tur başına istek bütçesi: P1 = Refresh, P2 = zamanlanmış tur.
export const GSC_RUN_REQUESTS = { P1: 12, P2: 45 } as const;
// Bir runDue çağrısının (bütün bağları için) ve bir Refresh'in duvar saati.
export const GSC_TICK_BUDGET_MS = 90_000;
export const GSC_REFRESH_BUDGET_MS = 25_000;
// Gün başına görünüm yedeği: turda en çok bu kadar gün.
export const GSC_APPEARANCE_DAYS_PER_RUN = 7;

// O anki günlük pencerenin anahtarı: "2026-10-06@18". 06:00'dan önce dünün
// akşam penceresi sürer.
export function dailySlot(now: Date): string {
  const day = gscToday(now);
  const hour = gscHour(now);
  if (hour >= GSC_DAILY_HOURS[1]) return `${day}@18`;
  if (hour >= GSC_DAILY_HOURS[0]) return `${day}@06`;
  return `${addDays(day, -1)}@18`;
}

export type GscSyncState = {
  lastMetadataAt: Date | null;
  lastDailyAt: Date | null;
  lastDailySlot: string | null;
  lastFinalDate: string | null;
  lastWeeklyWeek: string | null;
  lastMonthlyMonth: string | null;
  backfillDone: boolean;
  gapCount: number;
  heavyPending: number;
  heavyBlocked: boolean;
};

export type GscStages = {
  metadata: boolean;
  daily: boolean;
  weekly: boolean;
  monthly: boolean;
  backfill: boolean;
};

export function dueGscStages(state: GscSyncState, now: Date): GscStages {
  const metadata =
    !state.lastMetadataAt ||
    now.getTime() - state.lastMetadataAt.getTime() >= GSC_METADATA_EVERY_MS;
  // Yeni bağ pencere beklemez.
  const daily = !state.lastDailyAt || state.lastDailySlot !== dailySlot(now);
  const final = state.lastFinalDate;
  const weekly =
    final !== null &&
    (state.lastWeeklyWeek === null ||
      lastCompleteWeekStart(final) > state.lastWeeklyWeek);
  const monthly =
    final !== null &&
    (state.lastMonthlyMonth === null ||
      lastCompleteMonthStart(final) > state.lastMonthlyMonth);
  const backfill =
    final !== null &&
    (!state.backfillDone ||
      state.gapCount > 0 ||
      (state.heavyPending > 0 && !state.heavyBlocked));
  return { metadata, daily, weekly, monthly, backfill };
}

export function anyGscStageDue(stages: GscStages): boolean {
  return (
    stages.metadata ||
    stages.daily ||
    stages.weekly ||
    stages.monthly ||
    stages.backfill
  );
}

// Kesinleşen son gün: kesin yanıttaki son satır; yoksa
// first_incomplete_date − 1; o da yoksa today − 3. Önceki değerin gerisine
// düşmez, dünü geçmez.
export function resolveFinalThrough(input: {
  finalRowMax: string | null;
  firstIncompleteDate: string | null;
  today: string;
  previous: string | null;
}): string {
  const yesterday = addDays(input.today, -1);
  const candidate =
    input.finalRowMax ??
    (input.firstIncompleteDate
      ? addDays(input.firstIncompleteDate, -1)
      : addDays(input.today, -3));
  const atLeast = maxDay(candidate, input.previous) ?? candidate;
  return minDay(atLeast, yesterday) ?? yesterday;
}

// Bağ bir süre senkronlanamadıysa (kimlik kesintisi, geri çekilme, durdurulmuş
// proje) son kesin gün günlük pencerenin gerisine düşer: aradaki günler geri
// doldurmaya boşluk olarak eklenir. Google penceresinden eskisi istenmez.
export function detectGap(input: {
  previousFinal: string | null;
  dailyStart: string;
  windowStart: string;
}): { start: string; end: string } | null {
  if (!input.previousFinal) return null;
  const after = addDays(input.previousFinal, 1);
  if (after >= input.dailyStart) return null;
  const start = maxDay(after, input.windowStart) ?? after;
  const end = addDays(input.dailyStart, -1);
  return start > end ? null : { start, end };
}

// Çekilmesi gereken haftalar (Pazartesi anahtarları, eskiden yeniye). Hiç
// çekilmemişse yalnız son tam hafta: öncekiler geri doldurmanın işidir.
export function pendingWeeks(input: {
  lastWeeklyWeek: string | null;
  finalThrough: string;
  floor: string;
}): string[] {
  const latest = lastCompleteWeekStart(input.finalThrough);
  const floor = firstWeekStartOnOrAfter(input.floor);
  if (input.lastWeeklyWeek === null) return latest >= floor ? [latest] : [];
  const weeks: string[] = [];
  let week = maxDay(addWeeks(input.lastWeeklyWeek, 1), floor) ?? floor;
  while (week <= latest) {
    weeks.push(week);
    week = addWeeks(week, 1);
  }
  return weeks;
}

// Aylar için aynısı (ayın ilk günü anahtarları).
export function pendingMonths(input: {
  lastMonthlyMonth: string | null;
  finalThrough: string;
  floor: string;
}): string[] {
  const latest = lastCompleteMonthStart(input.finalThrough);
  const floor = firstMonthStartOnOrAfter(input.floor);
  if (input.lastMonthlyMonth === null) return latest >= floor ? [latest] : [];
  const months: string[] = [];
  let month = maxDay(addMonths(input.lastMonthlyMonth, 1), floor) ?? floor;
  while (month <= latest) {
    months.push(month);
    month = addMonths(month, 1);
  }
  return months;
}

export type DailyWrite = {
  day: string;
  source: "final" | "all";
  fresh: boolean;
};

// Günlük pencerenin yazım planı: finalThrough'a kadar kesin yanıttan (satır
// yoksa 0), sonrası taze yanıttan. Taze yanıtta satırı olmayan gün yalnız
// first_incomplete_date'ten önceyse sıfır yazılır; sonrasını Google henüz
// işlememiştir.
export function planDailyWrites(input: {
  start: string;
  yesterday: string;
  finalThrough: string;
  firstIncompleteDate: string | null;
  allDays: ReadonlySet<string>;
}): DailyWrite[] {
  const writes: DailyWrite[] = [];
  for (const day of dayRange(input.start, input.yesterday)) {
    if (day <= input.finalThrough) {
      writes.push({ day, source: "final", fresh: false });
      continue;
    }
    const complete =
      input.firstIncompleteDate !== null && day < input.firstIncompleteDate;
    if (input.allDays.has(day) || complete) {
      writes.push({ day, source: "all", fresh: true });
    }
  }
  return writes;
}

// Parçanın yazılacak günleri. Ana geçmiş yeniden eskiye yürür: parçada
// Google'ın döndürdüğü ilk günden önceki günler henüz sıfır sayılmaz (mülk o
// günlerde veri almıyor olabilir: yeni doğrulanmış mülk, pencerenin kenarı).
// Bu günler `pendingTo`'ya kadar bekleyen aralık olarak kalır; daha eski bir
// parçada satır gelince sıfır olarak yazılır, tabana ulaşan parçada düşer.
// Boşluk parçasının iki yanında veri vardır: her eksik gün sıfırdır.
export function backfillWriteDays(input: {
  days: readonly string[];
  returned: ReadonlySet<string>;
  atFloor: boolean;
  gap: boolean;
  // Bekleyen aralığın son günü (aralık parçanın son gününün ertesinden başlar).
  pendingTo: string | null;
}): { days: string[]; pendingTo: string | null } {
  const sorted = [...input.days].sort();
  if (input.gap) return { days: sorted, pendingTo: input.pendingTo };
  const oldest = sorted[0];
  const newest = sorted[sorted.length - 1];
  const first = sorted.find((day) => input.returned.has(day));
  if (!first || !oldest || !newest) {
    return {
      days: [],
      pendingTo: input.atFloor ? null : (input.pendingTo ?? newest ?? null),
    };
  }
  const confirmed =
    input.pendingTo && input.pendingTo > newest
      ? dayRange(addDays(newest, 1), input.pendingTo)
      : [];
  return {
    days: [...sorted.filter((day) => day >= first), ...confirmed],
    pendingTo: !input.atFloor && first > oldest ? addDays(first, -1) : null,
  };
}
