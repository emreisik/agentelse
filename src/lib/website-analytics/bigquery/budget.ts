// BigQuery bayt koruyucuları (GA-F8): sorgu başına sınır, aylık bütçe, ay devri.
// Saf modül. Env değerleri çağrı anında okunur. Her ifade ayrı tarama sayıldığı
// için tahmin ve bütçe üç kuru çalıştırmanın TOPLAMIdır (günlük + olaylar + sayfalar).

const DEFAULT_MAX_BYTES = 2_000_000_000;
const MIN_MAX_BYTES = 100_000_000;
// 100 GiB; SC-F9'un BQ_ABSOLUTE_MAX_BYTES (200 GiB) sınırının altında kalır.
const MAX_MAX_BYTES = 107_374_182_400;
const DEFAULT_MONTHLY_BYTES = 100_000_000_000;
const MIN_MONTHLY_BYTES = 100_000_000;
const MAX_MONTHLY_BYTES = 100_000_000_000_000;

function readNumber(raw: string | undefined): number | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

// Sorgu başına en çok faturalanacak bayt (GA_BIGQUERY_MAX_BYTES, 1e8..100 GiB).
export function maxBytesCap(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const value = readNumber(env.GA_BIGQUERY_MAX_BYTES);
  if (value === null) return DEFAULT_MAX_BYTES;
  return Math.min(MAX_MAX_BYTES, Math.max(MIN_MAX_BYTES, Math.floor(value)));
}

// Kaynak başına aylık bayt bütçesi (GA_BIGQUERY_MONTHLY_BYTES, varsayılan 100e9).
export function monthlyBudgetBytes(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const value = readNumber(env.GA_BIGQUERY_MONTHLY_BYTES);
  if (value === null) return DEFAULT_MONTHLY_BYTES;
  return Math.min(
    MAX_MONTHLY_BYTES,
    Math.max(MIN_MONTHLY_BYTES, Math.floor(value)),
  );
}

// Üç ifadenin kuru çalıştırma baytlarının toplamı (tahmin ve bütçe bununla yapılır).
export function sumBytes(values: readonly number[]): number {
  return values.reduce(
    (sum, value) => sum + (Number.isFinite(value) && value > 0 ? value : 0),
    0,
  );
}

// "YYYY-MM" (UTC).
export function monthKeyOf(now: Date): string {
  return now.toISOString().slice(0, 7);
}

// Gelecek ayın ilk günü (UTC gece yarısı): bütçe dolunca bir sonraki deneme.
export function firstOfNextMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

export function monthBudgetState(input: {
  usageMonth: string | null;
  usageBytes: number;
  monthlyBytes: number;
  estimateBytes: number;
  now: Date;
}): { month: string; usedBytes: number; allowed: boolean } {
  const month = monthKeyOf(input.now);
  // Ay değiştiyse sayaç sıfırdan başlar.
  const usedBytes =
    input.usageMonth === month && Number.isFinite(input.usageBytes)
      ? Math.max(0, input.usageBytes)
      : 0;
  const estimate = Number.isFinite(input.estimateBytes)
    ? Math.max(0, input.estimateBytes)
    : 0;
  return {
    month,
    usedBytes,
    allowed: usedBytes + estimate <= input.monthlyBytes,
  };
}

// Kullanıcıya gösterilecek bayt (ondalık birimler: BigQuery de böyle faturalar).
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const rounded = value >= 100 || unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}
