import type { RollingWindow } from "./catalog";
import {
  addDays,
  daysInRange,
  monthEnd,
  monthStart,
  previousMonthStart,
} from "./days";

// "Website" sayfasının dönemleri (docs/google-analytics-plan.md §3.9). Hepsi
// mülk saatiyle dünkü güne kadardır (bugün sürüyor); karşılaştırma aynı
// uzunluktaki bir önceki dönemle yapılır.

export const WEBSITE_PERIODS = [
  { key: "7d", label: "7 days" },
  { key: "28d", label: "28 days" },
  { key: "90d", label: "90 days" },
  { key: "this_month", label: "This month" },
  { key: "last_month", label: "Last month" },
] as const;
export type WebsitePeriodKey = (typeof WEBSITE_PERIODS)[number]["key"];
export const DEFAULT_WEBSITE_PERIOD: WebsitePeriodKey = "28d";

export function isWebsitePeriod(value: unknown): value is WebsitePeriodKey {
  return WEBSITE_PERIODS.some((period) => period.key === value);
}

export type WebsitePeriod = {
  key: WebsitePeriodKey;
  label: string;
  from: string;
  to: string;
  // 0: dönemde henüz tamamlanmış gün yok (ayın ilk günü "This month").
  days: number;
  previous: { from: string; to: string };
  // Tekil kullanıcıların kayan pencereden okunabildiği dönemler.
  rollingWindow: RollingWindow | null;
};

const ROLLING: Partial<Record<WebsitePeriodKey, RollingWindow>> = {
  "7d": 7,
  "28d": 28,
  "90d": 90,
};

export function resolveWebsitePeriod(
  key: WebsitePeriodKey,
  today: string,
): WebsitePeriod {
  const label =
    WEBSITE_PERIODS.find((period) => period.key === key)?.label ?? key;
  const yesterday = addDays(today, -1);
  const rolling = ROLLING[key];
  if (rolling) {
    const from = addDays(today, -rolling);
    return {
      key,
      label,
      from,
      to: yesterday,
      days: rolling,
      previous: { from: addDays(from, -rolling), to: addDays(from, -1) },
      rollingWindow: rolling,
    };
  }
  if (key === "this_month") {
    const from = monthStart(today);
    const days = from <= yesterday ? daysInRange(from, yesterday) : 0;
    const previousFrom = previousMonthStart(today);
    const previousTo = addDays(previousFrom, Math.max(days, 1) - 1);
    return {
      key,
      label,
      from,
      to: yesterday,
      days,
      previous: {
        from: previousFrom,
        to:
          previousTo > monthEnd(previousFrom)
            ? monthEnd(previousFrom)
            : previousTo,
      },
      rollingWindow: null,
    };
  }
  const from = previousMonthStart(today);
  const to = monthEnd(from);
  const before = previousMonthStart(from);
  return {
    key,
    label,
    from,
    to,
    days: daysInRange(from, to),
    previous: { from: before, to: monthEnd(before) },
    rollingWindow: null,
  };
}

// Değişim yüzdesi; önceki değer yoksa ya da sıfırsa null.
export function changePercent(
  current: number | null,
  previous: number | null,
): number | null {
  if (current === null || previous === null || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}
