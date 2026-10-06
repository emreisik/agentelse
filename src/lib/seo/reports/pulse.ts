import type { SliceRow } from "@/lib/seo/slices";

import type { SeoReportPulse } from "./types";

// Search pulse kuralları (docs/search-reports.md "Pulse"). Saf: günün değeri,
// önceki haftaların aynı hafta gününün medyanıyla kıyaslanır; yeterince
// farklıysa (ya da yeni CRITICAL uyarı varsa) bildirilir.

export const PULSE_MIN_USUAL = 10;
export const PULSE_MIN_CHANGE = 0.3;
export const PULSE_MIN_ABS = 10;
export const PULSE_HISTORY_WEEKS = 8;
export const PULSE_MIN_HISTORY = 3;
export const PULSE_SLICE_WEEKS = 4;

// Çift sayıda değerde ortadaki ikisinin ortalaması; değer yoksa null.
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

// Aynı hafta gününün geçmiş değerlerinin medyanı; yeterli geçmiş yoksa null.
export function usualValue(sameWeekday: readonly number[]): number | null {
  return sameWeekday.length >= PULSE_MIN_HISTORY ? median(sameWeekday) : null;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

// Günün ülke ya da cihaz kırılımında, geçmiş haftaların medyanından en çok
// sapan anahtar (mutlak tıklama farkı). "other" toplama kovası ülke sayılmaz.
// Yeterli geçmiş yoksa ya da hiç sapma yoksa null.
export function biggestSliceChange(input: {
  dimension: "country" | "device";
  day: readonly SliceRow[];
  history: readonly (readonly SliceRow[])[];
}): SeoReportPulse["biggest"] {
  if (input.history.length < PULSE_MIN_HISTORY) return null;

  const today = new Map<string, number>();
  for (const row of input.day) today.set(row[0], row[1]);
  const keys = new Set<string>(today.keys());
  const past = input.history.map((rows) => {
    const clicks = new Map<string, number>();
    for (const row of rows) {
      clicks.set(row[0], row[1]);
      keys.add(row[0]);
    }
    return clicks;
  });

  let best: { key: string; value: number; usual: number } | null = null;
  let bestChange = 0;
  for (const key of [...keys].sort()) {
    if (key === "other") continue;
    const value = today.get(key) ?? 0;
    // Yoksa o hafta 0 tıklama sayılır.
    const usual = median(past.map((clicks) => clicks.get(key) ?? 0));
    if (usual === null) continue;
    const change = Math.abs(value - usual);
    if (change > bestChange) {
      bestChange = change;
      best = { key, value, usual: round1(usual) };
    }
  }
  return best ? { dimension: input.dimension, ...best } : null;
}

// Bildirmeye değer mi: günlük değer olağan değerden en az %30 ve en az 10
// tıklama farklı (olağan değer ≥ 10), ya da yeni CRITICAL uyarı var.
export function pulseNotable(pulse: SeoReportPulse): boolean {
  if (pulse.newCritical > 0) return true;
  const usual = pulse.usual;
  if (usual === null || usual < PULSE_MIN_USUAL) return false;
  const difference = Math.abs(pulse.value - usual);
  return (
    difference >= PULSE_MIN_ABS && difference / usual >= PULSE_MIN_CHANGE - 1e-9
  );
}
