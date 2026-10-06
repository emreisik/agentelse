import {
  maskGooglePath,
  maskGoogleText,
} from "@/server/integrations/google/pii";

import type { GaReportSpec } from "./catalog";
import { gaDateKey } from "./days";
import type { GaParsedReport, GaQuality } from "./response";

// Katalog raporunun mülk günü başına dilimlere bölünmesi (yazım) ve
// dilimlerin dönem tablosuna toplanması (okuma). Satırlar kompakt saklanır:
// [boyut değerleri..., metrik değerleri...].

export type GaSliceRow = (string | number)[];

export type GaDaySlice = {
  day: string;
  dimensionHeaders: string[];
  metricHeaders: string[];
  rows: GaSliceRow[];
  // O gün için kırpmadan önceki satır sayısı.
  rowCount: number;
  truncated: boolean;
  // Kırpılan satırların metrik toplamları (metricHeaders sırasıyla).
  otherRow: number[] | null;
};

const TEXT_DIMENSIONS = new Set(["pageTitle", "searchTerm"]);

function cleanDimension(name: string, value: string, spec: GaReportSpec) {
  if (!spec.pathDimensions.includes(name)) return value;
  return TEXT_DIMENSIONS.has(name)
    ? maskGoogleText(value)
    : maskGooglePath(value);
}

// Yanıtı `days` günlerine böler. Maskeleme sonrası aynılaşan satırlar
// birleşir; her gün ana metriğe göre sıralanıp `rowsPerDay`'e kırpılır.
// Satırı olmayan gün boş dilim olarak döner: o günün çekildiği bilinsin.
export function splitReportByDay(
  report: GaParsedReport,
  spec: GaReportSpec,
  days: string[],
): GaDaySlice[] {
  const dateIndex = report.dimensionHeaders.indexOf("date");
  const dimensionIndexes = report.dimensionHeaders
    .map((name, index) => ({ name, index }))
    .filter(({ name }) => name !== "date");
  const dimensionHeaders = dimensionIndexes.map(({ name }) => name);
  const metricHeaders = report.metricHeaders;
  const orderIndex = Math.max(0, metricHeaders.indexOf(spec.orderBy));
  // Google satır sınırına takıldıysa en küçük satırlar hiç gelmedi.
  const cutByGoogle = report.rowCount > report.rows.length;

  const wanted = new Set(days);
  const byDay = new Map<string, Map<string, GaSliceRow>>();
  for (const row of report.rows) {
    const day = gaDateKey(row.dimensions[dateIndex]);
    if (!day || !wanted.has(day)) continue;
    const dimensions = dimensionIndexes.map(({ name, index }) =>
      cleanDimension(name, row.dimensions[index] ?? "", spec),
    );
    const key = JSON.stringify(dimensions);
    const rows = byDay.get(day) ?? new Map<string, GaSliceRow>();
    const existing = rows.get(key);
    if (existing) {
      row.metrics.forEach((value, index) => {
        const at = dimensions.length + index;
        existing[at] = Number(existing[at] ?? 0) + value;
      });
    } else {
      rows.set(key, [...dimensions, ...row.metrics]);
    }
    byDay.set(day, rows);
  }

  return days.map((day) => {
    const all = [...(byDay.get(day)?.values() ?? [])].sort(
      (a, b) =>
        Number(b[dimensionHeaders.length + orderIndex] ?? 0) -
        Number(a[dimensionHeaders.length + orderIndex] ?? 0),
    );
    const keep = spec.rowsPerDay ? all.slice(0, spec.rowsPerDay) : all;
    const dropped = all.slice(keep.length);
    const otherRow =
      dropped.length > 0
        ? metricHeaders.map((_, index) =>
            dropped.reduce(
              (sum, row) =>
                sum + Number(row[dimensionHeaders.length + index] ?? 0),
              0,
            ),
          )
        : null;
    return {
      day,
      dimensionHeaders,
      metricHeaders,
      rows: keep,
      rowCount: all.length,
      truncated: dropped.length > 0 || cutByGoogle,
      otherRow,
    };
  });
}

export type GaStoredSlice = {
  day: string;
  dimensionHeaders: string[];
  metricHeaders: string[];
  rows: GaSliceRow[];
  truncated: boolean;
  otherRow: number[] | null;
  quality: GaQuality;
};

export type GaTableRow = { key: string[]; values: number[] };

// Dilimleri `groupBy` boyutlarına göre toplar; ilk metriğe göre azalan.
// Dilimde olmayan boyut "(not set)", olmayan metrik 0 sayılır.
export function aggregateSlices(
  slices: GaStoredSlice[],
  groupBy: string[],
  metrics: string[],
): GaTableRow[] {
  const totals = new Map<string, GaTableRow>();
  for (const slice of slices) {
    const dimensionAt = groupBy.map((name) =>
      slice.dimensionHeaders.indexOf(name),
    );
    const metricAt = metrics.map((name) => {
      const index = slice.metricHeaders.indexOf(name);
      return index < 0 ? -1 : slice.dimensionHeaders.length + index;
    });
    for (const row of slice.rows) {
      const key = dimensionAt.map((index) =>
        index < 0 ? "(not set)" : String(row[index] ?? ""),
      );
      const id = JSON.stringify(key);
      const entry = totals.get(id) ?? { key, values: metrics.map(() => 0) };
      metricAt.forEach((index, at) => {
        if (index >= 0) entry.values[at]! += Number(row[index] ?? 0);
      });
      totals.set(id, entry);
    }
  }
  return [...totals.values()].sort(
    (a, b) => (b.values[0] ?? 0) - (a.values[0] ?? 0),
  );
}

// Dilimlerde kırpılan satırların toplamı (metrics sırasıyla).
export function droppedTotals(
  slices: GaStoredSlice[],
  metrics: string[],
): number[] {
  return metrics.map((name) =>
    slices.reduce((sum, slice) => {
      const index = slice.metricHeaders.indexOf(name);
      return index < 0 || !slice.otherRow
        ? sum
        : sum + (slice.otherRow[index] ?? 0);
    }, 0),
  );
}
