import { dayKeyInTimezone } from "@/lib/timezone";

import { addDays, hourInTimezone } from "./days";

// GA senkronunun zamanlaması (docs/google-analytics-plan.md §3.3 "Tazelik ve
// revizyon politikası", §5). Saf fonksiyonlar: runner yalnız bunların
// söylediğini yapar.

export const GA_SYNC_LEASE_MS = 5 * 60_000;
export const GA_METADATA_EVERY_MS = 24 * 3_600_000;
// Günlük çekim pencereleri (mülk saati): standart mülkte önceki gün tipik
// olarak ~15:30'da raporlarda olur; gelmediyse 18:00 ve 21:00'de yeniden
// denenir. 21:00 denemesi son denemedir.
export const GA_DAILY_HOURS = [16, 18, 21] as const;
// "Refresh" en çok bu sıklıkta (P1).
export const GA_REFRESH_EVERY_MS = 5 * 60_000;

export type GaSyncState = {
  lastMetadataAt: Date | null;
  // Son günlük çekim denemesi.
  lastDailyAt: Date | null;
  // Günlük çekimin tamamlandığı mülk günü (dünkü veri geldiyse ya da son
  // pencere denendiyse).
  lastDailyDate: string | null;
  backfillDone: boolean;
};

export type GaStages = {
  metadata: boolean;
  daily: boolean;
  backfill: boolean;
};

// `hour`'a kadar açılmış son pencere; ilk pencereden önce null.
export function dailyWindow(hour: number): number | null {
  let window: number | null = null;
  for (const start of GA_DAILY_HOURS) if (hour >= start) window = start;
  return window;
}

export function isLastDailyWindow(window: number | null): boolean {
  return window === GA_DAILY_HOURS[GA_DAILY_HOURS.length - 1];
}

export function dueGaStages(
  state: GaSyncState,
  input: { now: Date; timeZone: string },
): GaStages {
  const { now, timeZone } = input;
  const today = dayKeyInTimezone(now, timeZone);
  const metadata =
    !state.lastMetadataAt ||
    now.getTime() - state.lastMetadataAt.getTime() >= GA_METADATA_EVERY_MS;

  let daily = false;
  if (state.lastDailyDate !== today) {
    const triedToday =
      state.lastDailyAt !== null &&
      dayKeyInTimezone(state.lastDailyAt, timeZone) === today;
    if (!triedToday) {
      // Hiç senkronlanmamış bağlantı saati beklemez: sayfa hemen dolsun.
      daily =
        state.lastDailyDate === null ||
        dailyWindow(hourInTimezone(now, timeZone)) !== null;
    } else {
      const current = dailyWindow(hourInTimezone(now, timeZone));
      const tried = dailyWindow(hourInTimezone(state.lastDailyAt!, timeZone));
      daily = current !== null && (tried === null || tried < current);
    }
  }
  return {
    metadata,
    daily,
    // Geri doldurma ilk günlük çekim denemesinden sonra başlar (aynı turda
    // olabilir).
    backfill: !state.backfillDone && (state.lastDailyAt !== null || daily),
  };
}

// Bir günlük çekim denemesi o günü tamamlar mı: pencerelerden birinde
// (16:00 sonrası) dünün verisi geldiyse ya da son pencere denendiyse. İlk
// pencereden önceki deneme (ilk bağlanış, "Refresh") günü tamamlamaz: dünün
// verisi öğleden sonra kesinleşir ve 16:00 çekimi yine yapılır.
export function dailyAttemptCompletes(input: {
  hour: number;
  yesterdayIn: boolean;
}): boolean {
  const window = dailyWindow(input.hour);
  return window !== null && (input.yesterdayIn || isLastDailyWindow(window));
}

export function anyGaStageDue(stages: GaStages): boolean {
  return stages.metadata || stages.daily || stages.backfill;
}

// Kesinleşen son gün: revizyon penceresinden (D-1…D-n) çıkan gün bir daha
// çekilmez. Bugünkü çekimden önce de doğru olsun diye bir gün pay bırakılır:
// D-(n+1) ve öncesi kesindir.
export function finalThrough(today: string, revisionDays: number): string {
  return addDays(today, -(revisionDays + 1));
}
