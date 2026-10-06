import { addDays } from "@/lib/website-analytics/days";
import type { GaTableRow } from "@/lib/website-analytics/slices";

import type { GaHealthDay } from "./types";

// Kontrollerin ortak taban çizgisi yardımcıları (saf): medyan, pay, sütun
// toplamı, aynı hafta günü medyanı ve ardışık son günler.

const MIN_WEEKDAY_VALUES = 4;

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

// part/total; total sıfır ya da geçersizse null.
export function share(part: number, total: number): number | null {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) {
    return null;
  }
  return part / total;
}

export function sumColumn(rows: readonly GaTableRow[], index: number): number {
  let sum = 0;
  for (const row of rows) {
    const value = row.values[index];
    if (typeof value === "number" && Number.isFinite(value)) sum += value;
  }
  return sum;
}

// Hedef günden 7k gün önceki (k = 1..weeks) günlerin oturum medyanı; eksik ve
// hariç tutulan (şüpheli) günler atlanır. 4 değerden azsa medyan yok.
export function sameWeekdayMedian(
  days: readonly GaHealthDay[],
  target: string,
  exclude: ReadonlySet<string>,
  weeks = 8,
): { median: number | null; count: number } {
  const byDay = new Map(days.map((day) => [day.day, day]));
  const values: number[] = [];
  for (let k = 1; k <= weeks; k += 1) {
    const key = addDays(target, -7 * k);
    if (exclude.has(key)) continue;
    const day = byDay.get(key);
    if (day) values.push(day.sessions);
  }
  return {
    median: values.length >= MIN_WEEKDAY_VALUES ? median(values) : null,
    count: values.length,
  };
}

// `end` ile biten tam `count` ardışık gün (artan sırada); biri eksikse null.
export function lastDays(
  days: readonly GaHealthDay[],
  end: string,
  count: number,
): GaHealthDay[] | null {
  const byDay = new Map(days.map((day) => [day.day, day]));
  const out: GaHealthDay[] = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const day = byDay.get(addDays(end, -offset));
    if (!day) return null;
    out.push(day);
  }
  return out;
}
