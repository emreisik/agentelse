import { createHash } from "node:crypto";

import {
  maskGooglePath,
  maskGoogleText,
} from "@/server/integrations/google/pii";

// Search Console sözlüklerinin normalleştirmesi
// (docs/google-search-console-plan.md §3.11 "Veri azaltımı"): sorgu metni
// kişisel veriden arındırılır (e-posta, telefon), sayfa adresi sorgu dizesi ve
// parçası atılmış, yolu maskelenmiş olarak saklanır. Maskeden sonra aynı
// metne düşen satırlar toplanır (sözlükte ve özet tablolarında tek satır).
// Saf modül.

export type GscMetrics = {
  clicks: number;
  impressions: number;
  positionWeighted: number;
};

export function textHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

export function normalizeQueryText(value: string): string | null {
  const text = maskGoogleText(value).replace(/\s+/g, " ").trim();
  return text ? text : null;
}

export type NormalizedPage = {
  url: string;
  hash: string;
  path: string;
  pageGroup: string;
  host: string;
};

export function normalizePageUrl(value: string): NormalizedPage | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const masked = maskGooglePath(parsed.pathname);
  const path = masked ? (masked.startsWith("/") ? masked : `/${masked}`) : "/";
  const url = `${parsed.origin}${path}`;
  const first = path.split("/").find(Boolean);
  return {
    url,
    hash: textHash(url),
    path,
    pageGroup: first ? `/${first}` : "/",
    host: parsed.host,
  };
}

// Aynı anahtara düşen satırların metrikleri toplanır; ilk satırın diğer
// alanları korunur. Sıra ilk görülme sırasıdır.
export function mergeRows<T extends GscMetrics>(
  rows: readonly T[],
  keyOf: (row: T) => string,
): T[] {
  const merged = new Map<string, T>();
  for (const row of rows) {
    const key = keyOf(row);
    const current = merged.get(key);
    if (!current) {
      merged.set(key, { ...row });
      continue;
    }
    current.clicks += row.clicks;
    current.impressions += row.impressions;
    current.positionWeighted += row.positionWeighted;
  }
  return [...merged.values()];
}

// Sorgu×sayfa satırları için çift anahtar.
export function pairKey(queryHash: string, pageHash: string): string {
  return `${queryHash}|${pageHash}`;
}
