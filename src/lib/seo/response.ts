// Search Analytics yanıtının hoşgörülü ayrıştırılması
// (docs/google-search-console-plan.md §3.3, §3.4). Girdi `unknown`dır:
// beklenmeyen biçimde satır yoksa boş yanıt döner, sayısal olmayan metrik 0
// olur. `metadata.first_incomplete_date` yalnız dataState=all yanıtlarında
// gelir ve henüz kesinleşmemiş ilk günü bildirir (anlamı doğrulanmalı).

export type GscRow = {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

export type GscQueryResponse = {
  rows: GscRow[];
  responseAggregationType: string | null;
  firstIncompleteDate: string | null;
  firstIncompleteHour: string | null;
};

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseRow(value: unknown): GscRow | null {
  const row = record(value);
  if (!row) return null;
  const keys = Array.isArray(row.keys)
    ? row.keys.map((key) => (typeof key === "string" ? key : String(key)))
    : [];
  return {
    keys,
    clicks: number(row.clicks),
    impressions: number(row.impressions),
    ctr: number(row.ctr),
    position: number(row.position),
  };
}

export function parseGscResponse(raw: unknown): GscQueryResponse {
  const body = record(raw);
  const metadata = record(body?.metadata);
  const rows = Array.isArray(body?.rows)
    ? body.rows.map(parseRow).filter((row): row is GscRow => row !== null)
    : [];
  const firstIncomplete = text(metadata?.first_incomplete_date);
  return {
    rows,
    responseAggregationType: text(body?.responseAggregationType),
    firstIncompleteDate:
      firstIncomplete && DAY_KEY.test(firstIncomplete) ? firstIncomplete : null,
    firstIncompleteHour: text(metadata?.first_incomplete_hour),
  };
}

// Saklanan konum: position × impressions (dönem birleştirilirken gösterimle
// ağırlıklı ortalama alınır). Gösterim yoksa ya da konum sayı değilse 0.
export function positionWeighted(row: {
  position: number;
  impressions: number;
}): number {
  if (!(row.impressions > 0) || !Number.isFinite(row.position)) return 0;
  return row.position * row.impressions;
}
