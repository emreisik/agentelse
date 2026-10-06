// GA Data API runReport yanıtının ayrıştırılması ve veri kalitesi bayrakları
// (docs/google-analytics-plan.md §3.3 "Kalite bayrakları", §3.4).

export type GaQuotaStatus = { consumed: number; remaining: number };

export const GA_QUOTA_KEYS = [
  "tokensPerDay",
  "tokensPerHour",
  "tokensPerProjectPerHour",
  "concurrentRequests",
  "serverErrorsPerProjectPerHour",
  "potentiallyThresholdedRequestsPerHour",
] as const;
export type GaQuotaKey = (typeof GA_QUOTA_KEYS)[number];
export type GaPropertyQuota = Partial<Record<GaQuotaKey, GaQuotaStatus>>;

// Bir yanıtın kalite notları; her dilim ve günlük toplamla saklanır.
export type GaQuality = {
  thresholded?: boolean;
  otherRow?: boolean;
  sampled?: boolean;
  // Google'ın bildirdiği eksik veri nedenleri (saklama süresi vb.).
  truncationReasons?: string[];
  emptyReason?: string;
  timeZone?: string;
  currencyCode?: string;
  // Satır sınırına ulaşıldı: yalnız en büyük satırlar tutuldu.
  truncated?: boolean;
};

export type GaRow = { dimensions: string[]; metrics: number[] };

export type GaParsedReport = {
  dimensionHeaders: string[];
  metricHeaders: string[];
  rows: GaRow[];
  // Google'ın bildirdiği toplam satır (sınırdan önce).
  rowCount: number;
  quality: GaQuality;
  propertyQuota: GaPropertyQuota | null;
};

type RawValue = { value?: string };
export type GaRawReport = {
  dimensionHeaders?: { name?: string }[];
  metricHeaders?: { name?: string; type?: string }[];
  rows?: { dimensionValues?: RawValue[]; metricValues?: RawValue[] }[];
  rowCount?: number;
  metadata?: {
    subjectToThresholding?: boolean;
    dataLossFromOtherRow?: boolean;
    samplingMetadatas?: unknown[];
    emptyReason?: string;
    timeZone?: string;
    currencyCode?: string;
    dataTruncationReasons?: unknown[];
  };
  propertyQuota?: Record<string, { consumed?: number; remaining?: number }>;
};

function number(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseQuota(raw: GaRawReport["propertyQuota"]): GaPropertyQuota | null {
  if (!raw) return null;
  const quota: GaPropertyQuota = {};
  for (const key of GA_QUOTA_KEYS) {
    const status = raw[key];
    if (status && typeof status === "object") {
      quota[key] = {
        consumed: Number(status.consumed ?? 0) || 0,
        remaining: Number(status.remaining ?? 0) || 0,
      };
    }
  }
  return Object.keys(quota).length > 0 ? quota : null;
}

export function parseGaReport(raw: GaRawReport | null): GaParsedReport {
  const report = raw ?? {};
  const metadata = report.metadata ?? {};
  const rows: GaRow[] = (report.rows ?? []).map((row) => ({
    dimensions: (row.dimensionValues ?? []).map((value) => value.value ?? ""),
    metrics: (row.metricValues ?? []).map((value) => number(value.value)),
  }));
  const quality: GaQuality = {};
  if (metadata.subjectToThresholding) quality.thresholded = true;
  if (metadata.dataLossFromOtherRow) quality.otherRow = true;
  if ((metadata.samplingMetadatas ?? []).length > 0) quality.sampled = true;
  const reasons = (metadata.dataTruncationReasons ?? []).filter(
    (reason): reason is string => typeof reason === "string",
  );
  if (reasons.length > 0) quality.truncationReasons = reasons;
  if (metadata.emptyReason) quality.emptyReason = metadata.emptyReason;
  if (metadata.timeZone) quality.timeZone = metadata.timeZone;
  if (metadata.currencyCode) quality.currencyCode = metadata.currencyCode;
  return {
    dimensionHeaders: (report.dimensionHeaders ?? []).map((h) => h.name ?? ""),
    metricHeaders: (report.metricHeaders ?? []).map((h) => h.name ?? ""),
    rows,
    rowCount: Number(report.rowCount ?? rows.length) || rows.length,
    quality,
    propertyQuota: parseQuota(report.propertyQuota),
  };
}

// Bir metriğin satırdaki değeri; başlıkta yoksa 0.
export function metricOf(
  report: Pick<GaParsedReport, "metricHeaders">,
  row: GaRow,
  name: string,
): number {
  const index = report.metricHeaders.indexOf(name);
  return index < 0 ? 0 : (row.metrics[index] ?? 0);
}

export function dimensionOf(
  report: Pick<GaParsedReport, "dimensionHeaders">,
  row: GaRow,
  name: string,
): string | undefined {
  const index = report.dimensionHeaders.indexOf(name);
  return index < 0 ? undefined : row.dimensions[index];
}

// Kullanıcıya gösterilen kalite notları (İngilizce arayüz).
export function qualityNotes(quality: GaQuality): string[] {
  const notes: string[] = [];
  if (quality.thresholded) {
    notes.push("Google hid some small values to protect privacy.");
  }
  if (quality.otherRow) {
    notes.push("Some rows are grouped as (other) by Google.");
  }
  if (quality.sampled) notes.push("Google sampled part of this data.");
  if (quality.truncated) notes.push("Only the largest rows are kept.");
  if (quality.truncationReasons?.length) {
    notes.push("Google limits how far back some of this data goes.");
  }
  return notes;
}

// Birden çok yanıtın notlarını birleştirir (herhangi birinde varsa var).
export function mergeQuality(qualities: GaQuality[]): GaQuality {
  const merged: GaQuality = {};
  for (const quality of qualities) {
    if (quality.thresholded) merged.thresholded = true;
    if (quality.otherRow) merged.otherRow = true;
    if (quality.sampled) merged.sampled = true;
    if (quality.truncated) merged.truncated = true;
    if (quality.truncationReasons?.length) {
      merged.truncationReasons = [
        ...new Set([
          ...(merged.truncationReasons ?? []),
          ...quality.truncationReasons,
        ]),
      ];
    }
  }
  return merged;
}
