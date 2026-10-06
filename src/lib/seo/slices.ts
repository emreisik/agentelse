import { GSC_COUNTRY_TOP } from "./catalog";

// Günlük kırılım satırları (GscDailySlice.rows): [anahtar, tıklama, gösterim,
// position × gösterim]. Tıklamaya, eşitlikte gösterime göre sıralı. Ülkede
// ilk 50 tutulur, kalanı "other"a toplanır; cihaz ve arama görünümü az
// satırlıdır, kırpılmaz. 16 aydan eski günler aylık toplamlara (kind
// "<kind>_month") katlanır. Saf modül.

export type SliceRow = [string, number, number, number];

type Other = [number, number, number];

function baseKind(kind: string): string {
  return kind.endsWith("_month") ? kind.slice(0, -"_month".length) : kind;
}

function compareRows(a: SliceRow, b: SliceRow): number {
  return b[1] - a[1] || b[2] - a[2] || a[0].localeCompare(b[0]);
}

function addOther(target: Other | null, add: Other | null): Other | null {
  if (!add) return target;
  if (!target) return [add[0], add[1], add[2]];
  return [target[0] + add[0], target[1] + add[1], target[2] + add[2]];
}

export function trimSliceDay(
  kind: string,
  rows: SliceRow[],
): { rows: SliceRow[]; other: Other | null } {
  const sorted = [...rows].sort(compareRows);
  if (baseKind(kind) !== "country" || sorted.length <= GSC_COUNTRY_TOP) {
    return { rows: sorted, other: null };
  }
  let other: Other = [0, 0, 0];
  for (const row of sorted.slice(GSC_COUNTRY_TOP)) {
    other = [other[0] + row[1], other[1] + row[2], other[2] + row[3]];
  }
  return { rows: sorted.slice(0, GSC_COUNTRY_TOP), other };
}

// Ayın günlerini anahtar başına toplar (günlerin "other"ları dahil), sonra
// günlük kuralla kırpar.
export function rollupSliceMonth(
  kind: string,
  days: { rows: SliceRow[]; other: Other | null }[],
): { rows: SliceRow[]; other: Other | null } {
  const sums = new Map<string, SliceRow>();
  let other: Other | null = null;
  for (const day of days) {
    for (const row of day.rows) {
      const current = sums.get(row[0]);
      sums.set(
        row[0],
        current
          ? [
              row[0],
              current[1] + row[1],
              current[2] + row[2],
              current[3] + row[3],
            ]
          : [row[0], row[1], row[2], row[3]],
      );
    }
    other = addOther(other, day.other);
  }
  const trimmed = trimSliceDay(kind, [...sums.values()]);
  return { rows: trimmed.rows, other: addOther(other, trimmed.other) };
}
