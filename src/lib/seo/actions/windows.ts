import {
  addDays,
  addWeeks,
  dayKeyToDate,
  firstWeekStartOnOrAfter,
  gscToday,
  weekEndOf,
  weekStartOf,
} from "@/lib/seo/dates";

// Değerlendirme pencereleri (docs/google-search-console-plan.md SC-F6).
// Her an PT gün anahtarına çevrilir (gscToday) ve gün anahtarları dize olarak
// karşılaştırılır; bir anı dayKeyToDate(gün) ile kıyaslamak yasaktır (yaz/kış
// saati kaydırır). Saf.

export const PRE_WEEKS = 8;
export const MIN_PRE_WEEKS = 4;
export const MIN_POST_WEEKS = 2;
export const EXCLUDE_DAYS_AFTER_CHANGE = 7;
export const OVERLAP_LOOKBACK_DAYS = 28;
export const YOY_WEEKS = 52;

// Eylemin sonucunu bozabilecek sıralama güncellemeleri.
export const ACTION_UPDATE_KINDS: readonly string[] = [
  "CORE",
  "SPAM",
  "REVIEWS",
  "HELPFUL_CONTENT",
  "OTHER_RANKING",
];

export type EvaluationWindows = {
  anchorDay: string;
  preWeeks: string[];
  postWeeks: string[];
  lastNeededWeek: string;
  overlapFrom: string;
  // weekEndOf(lastNeededWeek)
  overlapTo: string;
  // preWeeks[0]
  windowFrom: string;
};

export function evaluationWindows(input: {
  measureFrom: Date;
  windowDays: number;
}): EvaluationWindows {
  const anchorDay = gscToday(input.measureFrom);
  const anchorWeek = weekStartOf(anchorDay);
  const preWeeks = Array.from({ length: PRE_WEEKS }, (_, index) =>
    addWeeks(anchorWeek, index - PRE_WEEKS),
  );
  // İlk 7 gün dışarıda; sonrasında tam haftalar, pencere sonunu aşmayan.
  const first = firstWeekStartOnOrAfter(
    addDays(anchorDay, EXCLUDE_DAYS_AFTER_CHANGE),
  );
  const limit = addDays(anchorDay, input.windowDays);
  const postWeeks: string[] = [];
  for (let week = first; weekEndOf(week) <= limit; week = addWeeks(week, 1)) {
    postWeeks.push(week);
  }
  // Pencere kısaysa en az iki hafta olacak şekilde uzatılır.
  while (postWeeks.length < MIN_POST_WEEKS) {
    const last = postWeeks[postWeeks.length - 1];
    postWeeks.push(last === undefined ? first : addWeeks(last, 1));
  }
  const lastNeededWeek = postWeeks[postWeeks.length - 1] ?? first;
  return {
    anchorDay,
    preWeeks,
    postWeeks,
    lastNeededWeek,
    overlapFrom: addDays(anchorDay, -OVERLAP_LOOKBACK_DAYS),
    overlapTo: weekEndOf(lastNeededWeek),
    windowFrom: preWeeks[0] ?? anchorWeek,
  };
}

// Geçen yılın aynı haftaları (52 hafta önce).
export function yearAgoWeeks(weeks: readonly string[]): string[] {
  return weeks.map((week) => addWeeks(week, -YOY_WEEKS));
}

// Ambarın haftalık verisi son gereken haftaya kadar geldi mi?
export function windowReady(
  windows: EvaluationWindows,
  lastWeeklyWeek: string | null,
): boolean {
  return (lastWeeklyWeek ?? "") >= windows.lastNeededWeek;
}

// from <= gscToday(instant) <= to (gün anahtarları dize olarak).
export function dayInRange(instant: Date, from: string, to: string): boolean {
  const day = gscToday(instant);
  return from <= day && day <= to;
}

// Kaba SQL sınırı: her uçta bir gün genişletilir, çağıran dayInRange ile
// inceltir. Saat dilimi kaymasına karşı güvenlidir.
export function queryBounds(
  from: string,
  to: string,
): { gte: Date; lt: Date } {
  return {
    gte: dayKeyToDate(addDays(from, -1)),
    lt: dayKeyToDate(addDays(to, 2)),
  };
}

// Aralıkla kesişen sıralama güncellemeleri; sürmekte olan (endedAt yok)
// güncelleme şimdiye kadar sürmüş sayılır.
export function rankingUpdatesOverlapping<
  T extends { kind: string; startedAt: Date; endedAt: Date | null },
>(
  updates: readonly T[],
  windows: EvaluationWindows,
  now: Date,
): T[] {
  return updates.filter(
    (update) =>
      ACTION_UPDATE_KINDS.includes(update.kind) &&
      gscToday(update.startedAt) <= windows.overlapTo &&
      gscToday(update.endedAt ?? now) >= windows.overlapFrom,
  );
}
