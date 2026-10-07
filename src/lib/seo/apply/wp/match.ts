// SC-F8: sayfa adresini WordPress nesnesiyle eşler (slug araması sonrası kesin
// doğrulama). Sondaki eğik çizgi, www ikizi (www. atılarak karşılaştırılır), büyük/küçük harf ve sorgu dizesi
// eşleşmeyi bozmaz. Saf modül; node:crypto kullanan crawl-url'e dayanır
// (yalnız sunucu tarafı).

import { normalizeCrawlUrl } from "@/lib/seo/crawl-url";

import type { WpObject } from "./wp-types";

// Adresin son yol parçası (WordPress'in sakladığı gibi %-kodlu, küçük harf);
// ana sayfa ve "?p=12" biçimli kalıcı bağlantılarda null (doğrulanmalı: Türkçe
// slug'larda REST arama parametresi %-kodlu biçimi bekler).
export function slugOfUrl(url: string): string | null {
  const normalized = normalizeCrawlUrl(url);
  if (!normalized) return null;
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return null;
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  const last = segments.at(-1);
  if (!last) return null;
  return last.toLowerCase();
}

type Key = { host: string; path: string; query: string };

function decodeSafe(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function keyOf(url: string): Key | null {
  const normalized = normalizeCrawlUrl(url);
  if (!normalized) return null;
  try {
    const parsed = new URL(normalized);
    const path = decodeSafe(parsed.pathname).replace(/\/+$/, "").toLowerCase();
    return {
      host: parsed.host.toLowerCase().replace(/^www\./, ""),
      path: path || "/",
      query: parsed.search,
    };
  } catch {
    return null;
  }
}

export function matchWpObject(
  objects: readonly WpObject[],
  url: string,
): { kind: "one"; object: WpObject } | { kind: "none" } | { kind: "many" } {
  const wanted = keyOf(url);
  if (!wanted) return { kind: "none" };
  const hits: WpObject[] = [];
  for (const object of objects) {
    const key = keyOf(object.link);
    if (!key) continue;
    if (key.host !== wanted.host) continue;
    if (key.path !== wanted.path) continue;
    // Düz kalıcı bağlantıda ("/?p=12") ayırt edici olan sorgudur.
    if (key.path === "/" && key.query !== wanted.query) continue;
    hits.push(object);
  }
  if (hits.length === 1) return { kind: "one", object: hits[0]! };
  if (hits.length === 0) return { kind: "none" };
  // Aynı nesne iki sayfada gelmiş olabilir.
  const unique = new Set(hits.map((object) => `${object.type}:${object.id}`));
  if (unique.size === 1) return { kind: "one", object: hits[0]! };
  return { kind: "many" };
}
