import {
  firstMonthStartOnOrAfter,
  firstWeekStartOnOrAfter,
  addDays,
  addMonths,
  monthEnd,
  weekEndOf,
} from "@/lib/seo/dates";

import type { BqPeriodKind } from "./sql";

// Hangi dönemlerin BigQuery'den içe aktarılacağı (saf). BigQuery'nin yazdığı
// dönem SON halidir (kırpılmış olsa da yeniden seçilmez); API'nin kırpılmış ya
// da eksik dönemi BigQuery ile değişir. Günlük toplamlara BigQuery asla yazmaz.

export type BqFetchState = { source: "API" | "BQ"; truncated: boolean };

export type BqPeriodTask = {
  grain: "WEEK" | "MONTH";
  periodStart: string;
  key: BqPeriodKind;
  reason: "API_TRUNCATED" | "MISSING" | "IMPORT_ALL";
};

export const bqPeriodKey = (
  grain: "WEEK" | "MONTH",
  periodStart: string,
  key: string,
): string => `${grain}|${periodStart}|${key}`;

const WEEK_KEYS: readonly BqPeriodKind[] = ["query", "page", "query_page"];
// Aylık sorgu×sayfa özeti hiç saklanmaz.
const MONTH_KEYS: readonly BqPeriodKind[] = ["query", "page"];

const MAX_WEEKS = 1_000;
const MAX_MONTHS = 240;

const REASON_RANK: Record<BqPeriodTask["reason"], number> = {
  API_TRUNCATED: 0,
  MISSING: 1,
  IMPORT_ALL: 2,
};

function reasonFor(
  state: BqFetchState | undefined,
  importAll: boolean,
): BqPeriodTask["reason"] | null {
  if (!state) return "MISSING";
  if (state.source === "BQ") return null;
  if (state.truncated) return "API_TRUNCATED";
  return importAll ? "IMPORT_ALL" : null;
}

export function planBqPeriods(input: {
  exportStart: string;
  exportedThrough: string;
  importAll: boolean;
  fetched: ReadonlyMap<string, BqFetchState>;
  maxTasks?: number;
}): BqPeriodTask[] {
  const tasks: BqPeriodTask[] = [];
  const add = (
    grain: "WEEK" | "MONTH",
    periodStart: string,
    keys: readonly BqPeriodKind[],
  ) => {
    for (const key of keys) {
      const reason = reasonFor(
        input.fetched.get(bqPeriodKey(grain, periodStart, key)),
        input.importAll,
      );
      if (reason) tasks.push({ grain, periodStart, key, reason });
    }
  };

  // Yalnız dışa aktarım penceresinin tamamen içindeki dönemler.
  // Üst sınırlar bozuk bir pencere (çok eski başlangıç) için döngü koruması.
  let week = firstWeekStartOnOrAfter(input.exportStart);
  for (
    let guard = 0;
    guard < MAX_WEEKS && weekEndOf(week) <= input.exportedThrough;
    guard += 1
  ) {
    add("WEEK", week, WEEK_KEYS);
    week = addDays(week, 7);
  }
  let month = firstMonthStartOnOrAfter(input.exportStart);
  for (
    let guard = 0;
    guard < MAX_MONTHS && monthEnd(month) <= input.exportedThrough;
    guard += 1
  ) {
    add("MONTH", month, MONTH_KEYS);
    month = addMonths(month, 1);
  }

  const keyRank = (key: BqPeriodKind) => WEEK_KEYS.indexOf(key);
  tasks.sort(
    (a, b) =>
      REASON_RANK[a.reason] - REASON_RANK[b.reason] ||
      (a.grain === b.grain ? 0 : a.grain === "WEEK" ? -1 : 1) ||
      (a.periodStart === b.periodStart
        ? 0
        : a.periodStart > b.periodStart
          ? -1
          : 1) ||
      keyRank(a.key) - keyRank(b.key),
  );
  return tasks.slice(0, Math.max(0, input.maxTasks ?? 6));
}
