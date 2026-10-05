// How a report number reads: one format everywhere (the card's tiles, the
// exports and the numbers the AI summary is given), in the Works cards' own
// en-US style ("1,234.56 TRY", "2.35%"). Fixed locale and no clock, so the
// server render and the browser always agree. Pure.

export const METRIC_FORMATS = [
  "count",
  "money",
  "percent",
  "duration",
  "position",
] as const;
export type MetricFormat = (typeof METRIC_FORMATS)[number];

const GROUPED = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const COMPACT = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const MONEY = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const PERCENT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const POSITION = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

// Tiles are narrow: from a million up a count reads "12.3M", and an amount
// from a hundred thousand up "1.2M TRY".
const COMPACT_FROM = 1_000_000;
const COMPACT_MONEY_FROM = 100_000;

export function isCurrencyCode(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z]{3}$/.test(value);
}

export function formatCount(value: number, compact = false): string {
  return compact && Math.abs(value) >= COMPACT_FROM
    ? COMPACT.format(value)
    : GROUPED.format(value);
}

// "400 TRY", "38.20 TRY": a whole amount loses its decimals.
export function formatMoney(
  value: number,
  currency: string | null,
  compact = false,
): string {
  const number =
    compact && Math.abs(value) >= COMPACT_MONEY_FROM
      ? COMPACT.format(value)
      : Number.isInteger(value)
        ? GROUPED.format(value)
        : MONEY.format(value);
  return isCurrencyCode(currency) ? `${number} ${currency}` : number;
}

// The value is already in percent units: 2.35 reads "2.35%".
export function formatPercent(value: number): string {
  return `${PERCENT.format(value)}%`;
}

// Seconds as "45s", "1m 35s", "1h 2m".
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
  return `${rest}s`;
}

export function formatPosition(value: number): string {
  return POSITION.format(value);
}

export function formatMetric(
  format: MetricFormat,
  value: number,
  currency: string | null,
  options: { compact?: boolean } = {},
): string {
  switch (format) {
    case "count":
      return formatCount(value, options.compact);
    case "money":
      return formatMoney(value, currency, options.compact);
    case "percent":
      return formatPercent(value);
    case "duration":
      return formatDuration(value);
    case "position":
      return formatPosition(value);
  }
}

// "5 Oct 2026, 14:32" in the project's timezone (UTC without one).
export function formatBuiltAt(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const options: Intl.DateTimeFormatOptions = {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  };
  try {
    return new Intl.DateTimeFormat("en-GB", {
      ...options,
      timeZone: timeZone || "UTC",
    }).format(date);
  } catch {
    // An unknown timezone name: UTC rather than nothing.
    return new Intl.DateTimeFormat("en-GB", {
      ...options,
      timeZone: "UTC",
    }).format(date);
  }
}
