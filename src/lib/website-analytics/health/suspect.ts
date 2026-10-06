import { addDays } from "@/lib/website-analytics/days";

import { isGaCheckKey } from "./registry";
import type { GaCheckKey, GaCheckResult } from "./types";

// Şüpheli günler (docs/measurement-health.md "Şüpheli günler"): verinin
// güvenilmez olabileceği günler GaHealthRun.suspectDays'te { gün: kontroller }
// olarak 400 gün tutulur; GA-F4 (readGaSuspectDays) bunları raporlarda işaretler.
// Her turda yalnız [today-7, today-1] penceresi yeniden kurulur; daha eski
// günler dondurulmuştur.

export type GaSuspectDays = Record<string, string[]>;

export const SUSPECT_CHECKS: readonly GaCheckKey[] = [
  "MH1",
  "MH4",
  "MH6",
  "MH20",
];
export const SUSPECT_RETENTION_DAYS = 400;

const WINDOW_DAYS = 7;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseSuspectDays(json: unknown): GaSuspectDays {
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    return {};
  }
  const out: GaSuspectDays = {};
  for (const [day, value] of Object.entries(json as Record<string, unknown>)) {
    if (!DAY_RE.test(day) || !Array.isArray(value)) continue;
    const checks = [...new Set(value.filter(isGaCheckKey))].sort();
    if (checks.length > 0) out[day] = checks;
  }
  return out;
}

// MH1 yalnız FAIL'de (sert düşüş), çift sayım / çift tetik / bot dalgası
// WARN'da da işaretler.
function marks(result: GaCheckResult): boolean {
  if (!SUSPECT_CHECKS.includes(result.key)) return false;
  if (result.key === "MH1") return result.status === "FAIL";
  return result.status === "WARN" || result.status === "FAIL";
}

export function mergeSuspectDays(
  existing: GaSuspectDays,
  results: readonly GaCheckResult[],
  input: { today: string },
): GaSuspectDays {
  const windowFrom = addDays(input.today, -WINDOW_DAYS);
  const windowTo = addDays(input.today, -1);
  const oldest = addDays(input.today, -SUSPECT_RETENTION_DAYS);
  const merged = new Map<string, Set<string>>();

  // Pencere dışındaki eski günler olduğu gibi kalır (400 günden eskisi düşer).
  for (const [day, checks] of Object.entries(existing)) {
    if (day < oldest) continue;
    if (day >= windowFrom && day <= windowTo) continue;
    if (checks.length > 0) merged.set(day, new Set(checks));
  }
  for (const result of results) {
    if (!marks(result)) continue;
    for (const day of result.days ?? []) {
      if (day < windowFrom || day > windowTo) continue;
      const set = merged.get(day) ?? new Set<string>();
      set.add(result.key);
      merged.set(day, set);
    }
  }

  const out: GaSuspectDays = {};
  for (const day of [...merged.keys()].sort()) {
    out[day] = [...merged.get(day)!].sort();
  }
  return out;
}

export function suspectDaysIn(
  days: GaSuspectDays,
  from: string,
  to: string,
): string[] {
  return Object.keys(days)
    .filter((day) => day >= from && day <= to && (days[day]?.length ?? 0) > 0)
    .sort();
}
