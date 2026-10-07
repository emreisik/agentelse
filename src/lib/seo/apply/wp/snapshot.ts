// SC-F8: değişiklik öncesi/sonrası görüntüsü (WpSnapshot) ve içerik özetleri.
// contentHashOf bayt düzeyinde (CRLF normalleştirilmiş), textHashOf yalnız görünen
// metin üzerinden: WordPress blokları yeniden serileştirse de aynı kalır.
// Saf modül; node:crypto kullanır (yalnız sunucu tarafı).

import { createHash } from "node:crypto";

import { countWords } from "@/lib/module-flows/seo/markdown";

import type { SeoFieldsCapability, WpSnapshot } from "../types";
import { seoValuesOf } from "./plugin-fields";
import type { WpObject } from "./wp-types";

const CONTENT_RAW_MAX = 200_000;

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

export function contentHashOf(raw: string): string {
  return sha(raw.replace(/\r\n?/g, "\n"));
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

// Blok yorumları ve etiketler atılır, varlıklar çözülür, boşluklar tek boşluğa iner.
export function normalizedTextOf(raw: string): string {
  return decodeEntities(
    raw.replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]*>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

export function textHashOf(raw: string): string {
  return sha(normalizedTextOf(raw));
}

export function snapshotOf(
  object: WpObject | null,
  fields: SeoFieldsCapability,
  options: { withContentRaw: boolean },
): WpSnapshot {
  if (!object) {
    return {
      exists: false,
      type: null,
      id: null,
      status: null,
      link: null,
      modified: null,
      title: null,
      excerpt: null,
      seoTitle: null,
      seoDescription: null,
      contentHash: null,
      contentWords: null,
      contentRaw: null,
    };
  }
  const seo = seoValuesOf(fields, object.meta);
  const content = object.content;
  return {
    exists: true,
    type: object.type,
    id: object.id,
    status: object.status,
    link: object.link,
    modified: object.modified,
    title: object.title,
    excerpt: object.excerpt,
    seoTitle: seo.seoTitle,
    seoDescription: seo.seoDescription,
    contentHash: content === null ? null : contentHashOf(content),
    contentWords: content === null ? null : countWords(normalizedTextOf(content)),
    contentRaw:
      options.withContentRaw && content !== null && content.length <= CONTENT_RAW_MAX
        ? content
        : null,
  };
}
