import {
  addDays,
  daysInRange,
  firstWeekStartOnOrAfter,
  lastCompleteWeekStart,
} from "./dates";

export { changePercent } from "@/lib/website-analytics/periods";

// "Search" sayfasının dönemleri (docs/search-analytics.md "Arayüz"). Hepsi
// kesinleşen son PT gününde (finalThrough) biter ve aynı uzunluktaki bir
// önceki dönemle karşılaştırılır. Sorgu/sayfa tabloları dönemin içindeki tam
// Pazartesi–Pazar haftalarını kullanır (haftalık özetler); dönemde tam hafta
// yoksa en son tam hafta.

export const SEARCH_PERIODS = [
  { key: "7d", label: "7 days", days: 7 },
  { key: "28d", label: "28 days", days: 28 },
  { key: "3m", label: "3 months", days: 91 },
  { key: "12m", label: "12 months", days: 364 },
] as const;
export type SearchPeriodKey = (typeof SEARCH_PERIODS)[number]["key"];
export const DEFAULT_SEARCH_PERIOD: SearchPeriodKey = "28d";

export function isSearchPeriod(value: unknown): value is SearchPeriodKey {
  return SEARCH_PERIODS.some((period) => period.key === value);
}

// Pazartesi anahtarları: ilk ve son haftanın başı.
export type SearchWeeks = { from: string; to: string; count: number };

export type SearchPeriod = {
  key: SearchPeriodKey;
  label: string;
  from: string;
  to: string;
  days: number;
  previous: { from: string; to: string };
  weeks: SearchWeeks;
};

// [from, to] içindeki tam haftalar; hiç yoksa `to`'dan sonra bitmeyen en son
// tam hafta. Hiçbir hafta `to`'dan sonraki bir günü içermez.
export function weeksWithin(from: string, to: string): SearchWeeks {
  const first = firstWeekStartOnOrAfter(from);
  const last = lastCompleteWeekStart(to);
  if (first > last) return { from: last, to: last, count: 1 };
  return {
    from: first,
    to: last,
    count: (daysInRange(first, last) - 1) / 7 + 1,
  };
}

export function resolveSearchPeriod(
  key: SearchPeriodKey,
  finalThrough: string,
): SearchPeriod {
  const definition =
    SEARCH_PERIODS.find((period) => period.key === key) ?? SEARCH_PERIODS[1];
  const days = definition.days;
  const to = finalThrough;
  const from = addDays(to, -(days - 1));
  const previousTo = addDays(from, -1);
  return {
    key: definition.key,
    label: definition.label,
    from,
    to,
    days,
    previous: { from: addDays(previousTo, -(days - 1)), to: previousTo },
    weeks: weeksWithin(from, to),
  };
}
