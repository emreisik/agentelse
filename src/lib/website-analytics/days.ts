// Ambarın gün anahtarları: GA'nın `date` boyutu mülkün saat dilimindeki
// gündür ve "YYYY-MM-DD" olarak taşınır. Takvim aritmetiği UTC'de yapılır;
// anahtar zaten mülkün yerel günüdür. Saat dilimi yardımcıları Meta aynasıyla
// ortaktır.

export { addDays, hourInTimezone, safeTimezone } from "@/lib/ads/sync-plan";

// GA "20261005" → "2026-10-05"; tanınmayan değer null.
export function gaDateKey(value: string | undefined): string | null {
  if (!value || !/^\d{8}$/.test(value)) return null;
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

// "2026-10-05" → Prisma'nın @db.Date alanı için UTC gece yarısı.
export function dayKeyToDate(dayKey: string): Date {
  return new Date(`${dayKey}T00:00:00.000Z`);
}

// @db.Date alanından gün anahtarı.
export function dateToDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// [from, to] aralığındaki gün sayısı (iki uç dahil); ters aralıkta 0.
export function daysInRange(from: string, to: string): number {
  const ms = dayKeyToDate(to).getTime() - dayKeyToDate(from).getTime();
  return ms < 0 ? 0 : Math.round(ms / 86_400_000) + 1;
}

// Ayın ilk günü: "2026-10-05" → "2026-10-01".
export function monthStart(dayKey: string): string {
  return `${dayKey.slice(0, 7)}-01`;
}

// Ayın son günü: "2026-02-10" → "2026-02-28".
export function monthEnd(dayKey: string): string {
  const [y, m] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10);
}

// Bir önceki ayın ilk günü: "2026-01-15" → "2025-12-01".
export function previousMonthStart(dayKey: string): string {
  const [y, m] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 2, 1)).toISOString().slice(0, 10);
}
