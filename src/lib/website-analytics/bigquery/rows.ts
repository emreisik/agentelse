// BigQuery sonuç matrisini (sütunlar + hücre satırları) kayıtlara çevirir (GA-F8).
// Saf modül. Eksik sütun ya da kısa satır null verir; hiç fırlatmaz.

export type BqRecordCell = string | number | boolean | null;

export function rowsToRecords(
  columns: readonly { name: string }[],
  rows: readonly (string | number | boolean | null)[][],
): Record<string, BqRecordCell>[] {
  return rows.map((row) => {
    const record: Record<string, BqRecordCell> = {};
    columns.forEach((column, index) => {
      record[column.name] = row[index] ?? null;
    });
    return record;
  });
}

// Hücre → tamsayı (INT64 hücreleri sayı ya da sayısal dize gelebilir).
export function cellToInt(cell: BqRecordCell | undefined): number {
  if (typeof cell === "number") return Number.isFinite(cell) ? Math.trunc(cell) : 0;
  if (typeof cell === "string" && cell.trim() !== "") {
    const value = Number(cell);
    return Number.isFinite(value) ? Math.trunc(value) : 0;
  }
  return 0;
}

export function cellToString(cell: BqRecordCell | undefined): string | null {
  if (typeof cell === "string") return cell;
  if (typeof cell === "number") return String(cell);
  return null;
}
