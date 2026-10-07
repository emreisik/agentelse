// SC-F8: yazmadan sonra canlı nesneyi geri okuyup beklenenle karşılaştırır (saf).
// Çekirdek alanlar birebir (yalnız HTML varlık kodlaması farkı tolere edilir:
// unfiltered_html yetkisi olmayan kullanıcılarda WordPress "&" -> "&amp;" yapar),
// yeni içerik metin özetiyle (blokların yeniden serileştirilmesi sorun değil),
// mevcut sayfanın içeriği bayt özetiyle. Eklenti alanları yalnız META yolunda
// okunur; uç nokta (Rank Math updateMeta) ile yazılanlar okunamaz -> partial.
// Uyuşmazlıkta okunanın görüntüsü de döner (motor after olarak saklar).
// Yalnız sunucu tarafı (snapshot.ts node:crypto kullanır).

import type { SeoFieldsCapability, WpSnapshot } from "../types";
import type { ExpectedAfter } from "./plan";
import { seoValuesOf } from "./plugin-fields";
import {
  contentHashOf,
  decodeEntities,
  snapshotOf,
  textHashOf,
} from "./snapshot";
import type { WpObject } from "./wp-types";

function sameText(expected: string, actual: string): boolean {
  if (expected === actual) return true;
  return decodeEntities(expected).trim() === decodeEntities(actual).trim();
}

export function verifyReadBack(
  expect: ExpectedAfter,
  after: WpObject | null,
  ctx: { fields: SeoFieldsCapability; withContentRaw: boolean },
):
  | { ok: true; snapshot: WpSnapshot; partial: boolean }
  | { ok: false; reason: string; snapshot: WpSnapshot | null } {
  if (!after) {
    return { ok: false, reason: "The item could not be read back.", snapshot: null };
  }
  const snapshot = snapshotOf(after, ctx.fields, {
    withContentRaw: ctx.withContentRaw,
  });
  const differs: string[] = [];

  if (expect.status !== undefined && after.status !== expect.status) {
    differs.push("status");
  }
  if (expect.title !== undefined && !sameText(expect.title, after.title)) {
    differs.push("title");
  }
  if (expect.excerpt !== undefined && !sameText(expect.excerpt, after.excerpt)) {
    differs.push("excerpt");
  }
  if (expect.textHash !== undefined) {
    if (after.content === null || textHashOf(after.content) !== expect.textHash) {
      differs.push("content");
    }
  }
  if (expect.contentHash !== undefined) {
    if (
      after.content === null ||
      contentHashOf(after.content) !== expect.contentHash
    ) {
      differs.push("content");
    }
  }

  const seo = seoValuesOf(ctx.fields, after.meta);
  if (expect.seoTitle !== undefined && seo.seoTitle !== expect.seoTitle) {
    differs.push("seoTitle");
  }
  if (
    expect.seoDescription !== undefined &&
    seo.seoDescription !== expect.seoDescription
  ) {
    differs.push("seoDescription");
  }

  if (differs.length) {
    return {
      ok: false,
      reason: `Fields that differ: ${[...new Set(differs)].join(", ")}.`,
      snapshot,
    };
  }
  return { ok: true, snapshot, partial: !ctx.fields.verifiable };
}
