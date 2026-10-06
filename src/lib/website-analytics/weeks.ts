import { addDays } from "./days";

// Ambarın ISO hafta yardımcıları (docs/google-analytics-plan.md §3.3
// "Haftalık dilimler", GA-F2 bölüm 2). Gün anahtarları mülk saatindeki
// "YYYY-MM-DD"dir; WEEK diliminin periodStart'ı haftanın Pazartesi'sidir.
// GA'nın `isoYearIsoWeek` boyutu "YYYYWW" biçimindedir: ISO yılı haftanın
// Perşembe'sinin yılıdır, 1. hafta 4 Ocak'ı içerir (53 haftalık yıllar var).
// Saf ve izomorfik modül.

function weekday(day: string): number {
  // 0 = Pazartesi … 6 = Pazar.
  return (new Date(`${day}T00:00:00.000Z`).getUTCDay() + 6) % 7;
}

function daysBetween(from: string, to: string): number {
  return Math.round(
    (new Date(`${to}T00:00:00.000Z`).getTime() -
      new Date(`${from}T00:00:00.000Z`).getTime()) /
      86_400_000,
  );
}

export function isoWeekMonday(day: string): string {
  return addDays(day, -weekday(day));
}

export function weekSunday(monday: string): string {
  return addDays(monday, 6);
}

// "2026-10-05" → "202641"; "2026-12-28" → "202653"; "2027-01-04" → "202701".
export function isoYearIsoWeekKey(day: string): string {
  const monday = isoWeekMonday(day);
  const isoYear = addDays(monday, 3).slice(0, 4);
  const firstMonday = isoWeekMonday(`${isoYear}-01-04`);
  const week = daysBetween(firstMonday, monday) / 7 + 1;
  return `${isoYear}${String(week).padStart(2, "0")}`;
}

// "202641" → "2026-10-05"; tanınmayan ya da yılda olmayan hafta null.
export function mondayOfIsoYearIsoWeek(
  value: string | undefined,
): string | null {
  if (!value || !/^\d{6}$/.test(value)) return null;
  const year = value.slice(0, 4);
  const week = Number(value.slice(4));
  if (week < 1 || week > 53) return null;
  const monday = addDays(isoWeekMonday(`${year}-01-04`), (week - 1) * 7);
  return isoYearIsoWeekKey(monday) === value ? monday : null;
}

// İki uç dahil, artan; from > to ise boş.
export function mondaysBetween(fromMonday: string, toMonday: string): string[] {
  const mondays: string[] = [];
  for (
    let monday = fromMonday;
    monday <= toMonday;
    monday = addDays(monday, 7)
  ) {
    mondays.push(monday);
  }
  return mondays;
}

// [from, to] içinde bütün günleri kalan haftaların Pazartesi'leri.
export function weeksInside(from: string, to: string): string[] {
  let monday = isoWeekMonday(from);
  if (monday < from) monday = addDays(monday, 7);
  const mondays: string[] = [];
  for (; weekSunday(monday) <= to; monday = addDays(monday, 7)) {
    mondays.push(monday);
  }
  return mondays;
}

// Pazar'ı today-lagDays'ten sonra olmayan son haftanın Pazartesi'si.
export function latestCompleteWeek(today: string, lagDays: number): string {
  const cutoff = addDays(today, -lagDays);
  const monday = isoWeekMonday(cutoff);
  return weekSunday(monday) <= cutoff ? monday : addDays(monday, -7);
}

// Haftalık kapsamın ilk haftası: today-retentionDays'te ya da sonrasındaki ilk
// Pazartesi; mülk daha yeniyse oluşturulduğu hafta.
export function weeklyFloor(
  today: string,
  retentionDays: number,
  propertyCreated: string | null,
): string {
  const oldest = addDays(today, -retentionDays);
  let floor = isoWeekMonday(oldest);
  if (floor < oldest) floor = addDays(floor, 7);
  if (propertyCreated) {
    const created = isoWeekMonday(propertyCreated);
    if (created > floor) return created;
  }
  return floor;
}
