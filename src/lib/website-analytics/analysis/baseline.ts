import { addDays } from "@/lib/website-analytics/days";

import type { GaAnalysisDay, GaAnomalyMetric, GaRange } from "./types";

// GA-F4 taban çizgisi yardımcıları (docs/google-analytics-plan.md §6.2 AN1,
// §6.3; ayrıntı docs/website-insights.md "İstatistik"). Taban aynı haftanın
// günüdür (8 hafta); şüpheli ve tatil günleri (AN16 düzelticisi) çağıranın
// verdiği `exclude` kümesiyle dışarıda kalır. Saf ve izomorfik.

// keyEventRate = keyEvents / sessions (oturum 0 ise null); KESİR, 1'i
// aşabilir.
export function metricOfDay(
  day: GaAnalysisDay,
  metric: GaAnomalyMetric,
): number | null {
  if (metric === "keyEventRate") {
    return day.sessions > 0 ? day.keyEvents / day.sessions : null;
  }
  const value = day[metric];
  return Number.isFinite(value) ? value : null;
}

function byDay(days: readonly GaAnalysisDay[]): Map<string, GaAnalysisDay> {
  return new Map(days.map((day) => [day.day, day]));
}

// target−7, −14 … −7·weeks günlerini gezer; hariç tutulan, eksik ve değeri
// null olan günler atlanır. minValues'tan az değer kalırsa null. Sıra
// yeniden eskiye.
export function sameWeekdayBaseline(
  days: readonly GaAnalysisDay[],
  target: string,
  pick: (d: GaAnalysisDay) => number | null,
  options: {
    exclude: ReadonlySet<string>;
    weeks?: number;
    minValues?: number;
  },
): { values: number[]; days: string[] } | null {
  const weeks = options.weeks ?? 8;
  const minValues = options.minValues ?? 4;
  const index = byDay(days);
  const values: number[] = [];
  const used: string[] = [];
  for (let week = 1; week <= weeks; week++) {
    const key = addDays(target, -7 * week);
    if (options.exclude.has(key)) continue;
    const row = index.get(key);
    if (!row) continue;
    const value = pick(row);
    if (value === null || !Number.isFinite(value)) continue;
    values.push(value);
    used.push(key);
  }
  return values.length >= minValues ? { values, days: used } : null;
}

// Pazartesi başına haftalık toplam; clean = 7 satırın hepsi var ve hiçbiri
// hariç değil. Hariç günler toplama girmez.
export function weeklySums(
  days: readonly GaAnalysisDay[],
  mondays: readonly string[],
  pick: (d: GaAnalysisDay) => number,
  exclude: ReadonlySet<string>,
): { monday: string; value: number; clean: boolean }[] {
  const index = byDay(days);
  return mondays.map((monday) => {
    let value = 0;
    let present = 0;
    let excluded = false;
    for (let offset = 0; offset < 7; offset++) {
      const key = addDays(monday, offset);
      const row = index.get(key);
      if (!row) continue;
      present += 1;
      if (exclude.has(key)) {
        excluded = true;
        continue;
      }
      const picked = pick(row);
      if (Number.isFinite(picked)) value += picked;
    }
    return { monday, value, clean: present === 7 && !excluded };
  });
}

// Aralıktaki (hariç olmayan) satırların toplamı ve kullanılan gün sayısı.
export function sumRange(
  days: readonly GaAnalysisDay[],
  range: GaRange,
  pick: (d: GaAnalysisDay) => number,
  exclude?: ReadonlySet<string>,
): { value: number; days: number } {
  let value = 0;
  let count = 0;
  for (const row of days) {
    if (row.day < range.from || row.day > range.to) continue;
    if (exclude?.has(row.day)) continue;
    const picked = pick(row);
    if (Number.isFinite(picked)) value += picked;
    count += 1;
  }
  return { value, days: count };
}

// Kümenin aralık içindeki elemanları, sıralı.
export function daysIn(range: GaRange, set: ReadonlySet<string>): string[] {
  return [...set].filter((day) => day >= range.from && day <= range.to).sort();
}
