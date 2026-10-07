// BigQuery dışa aktarımının sabitleri ve ortamdan okunan üst sınırlar
// (docs/search-agency.md). Ortam değerleri çağrı anında okunur: sahibin
// tavanları süreç yeniden başlamadan değişebilir.

// Search Console toplu dışa aktarımının tablo adları.
export const BQ_TABLE_SITE = "searchdata_site_impression";
export const BQ_TABLE_URL = "searchdata_url_impression";
export const BQ_TABLE_LOG = "ExportLog";

const GIB = 1024 ** 3;

export const DEFAULT_MAX_BYTES_PER_QUERY = 10 * GIB;
export const DEFAULT_MONTHLY_BYTES = 300 * GIB;

// Kurulum kartındaki seçenekler (GB, ikili): müşteri bunların dışına çıkamaz.
export const MAX_BYTES_CHOICES_GB = [5, 10, 25, 50, 100] as const;
export const MONTHLY_CHOICES_GB = [50, 100, 300, 1000, 2000] as const;

// Sahibin sert tavanları: müşterinin ayarı bunların üstüne çıkamaz.
const DEFAULT_HARD_MAX_BYTES = 100 * GIB;
const DEFAULT_HARD_MONTHLY_BYTES = 2048 * GIB;
// İstemcinin mutlak sınırı (200 GiB) ile aynı: sorgu başına tavan bunu aşamaz.
const ABSOLUTE_MAX_BYTES = 200 * GIB;

const DEFAULT_ROW_CAP = 100_000;
const MIN_ROW_CAP = 1_000;
const MAX_ROW_CAP = 500_000;

type Env = Readonly<Record<string, string | undefined>>;

function positiveInt(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

// Dönem anahtarı başına içe aktarılan en çok satır (varsayılan 100.000).
export function rowCap(env: Env = process.env): number {
  const parsed = positiveInt(env.GSC_BQ_ROW_CAP);
  if (parsed === null) return DEFAULT_ROW_CAP;
  return Math.min(MAX_ROW_CAP, Math.max(MIN_ROW_CAP, parsed));
}

export function hardMaxBytes(env: Env = process.env): number {
  const parsed = positiveInt(env.GSC_BQ_HARD_MAX_BYTES);
  return Math.min(ABSOLUTE_MAX_BYTES, parsed ?? DEFAULT_HARD_MAX_BYTES);
}

export function hardMonthlyBytes(env: Env = process.env): number {
  return positiveInt(env.GSC_BQ_HARD_MONTHLY_BYTES) ?? DEFAULT_HARD_MONTHLY_BYTES;
}

// Seçenek GB (ikili) değerini bayta çevirir.
export function gbToBytes(gb: number): number {
  return gb * GIB;
}
