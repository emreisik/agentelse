import { describe, expect, it } from "vitest";

import {
  contentHashOf,
  decodeEntities,
  normalizedTextOf,
  snapshotOf,
  textHashOf,
} from "./snapshot";
import { fieldsFixture, wpObjectFixture } from "./test-support";

// Bu dosyanın kanıtladığı: özetler CRLF'ten etkilenmez, metin özeti blok/etiket
// farklarından etkilenmez ama sözcük değişimini yakalar; snapshotOf alanları,
// SEO alanlarını ve contentRaw sınırını doğru doldurur.

describe("hashes", () => {
  it("contentHashOf is stable across CRLF and differs on content", () => {
    expect(contentHashOf("a\r\nb\r\nc")).toBe(contentHashOf("a\nb\nc"));
    expect(contentHashOf("a\nb")).not.toBe(contentHashOf("a\nB"));
    expect(contentHashOf("x")).toMatch(/^[0-9a-f]{32}$/);
  });

  it("normalizedTextOf drops comments and tags, decodes entities, collapses spaces", () => {
    expect(
      normalizedTextOf(
        '<!-- wp:paragraph -->\n<p>Tom &amp; <strong>Jerry</strong>\n  &#39;s &nbsp;show</p>\n<!-- /wp:paragraph -->',
      ),
    ).toBe("Tom & Jerry 's show");
  });

  it("decodeEntities keeps unknown entities", () => {
    expect(decodeEntities("&foo; &#x41; &#66; &#0;")).toBe("&foo; A B &#0;");
  });

  it("textHashOf ignores block markup differences but not words", () => {
    const created = '<!-- wp:paragraph -->\n<p>Merhaba <em>dünya</em></p>\n<!-- /wp:paragraph -->';
    const reserialized = '<p>Merhaba <em>dünya</em></p>';
    expect(textHashOf(created)).toBe(textHashOf(reserialized));
    expect(textHashOf(created)).not.toBe(textHashOf("<p>Merhaba dünyalar</p>"));
  });
});

describe("snapshotOf", () => {
  it("returns the empty snapshot for a missing object", () => {
    expect(snapshotOf(null, fieldsFixture("yoast"), { withContentRaw: true })).toEqual({
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
    });
  });

  it("fills fields, SEO values, hash and word count", () => {
    const object = wpObjectFixture({
      content: "<p>bir iki üç dört</p>",
      meta: { _yoast_wpseo_title: "Başlık", _yoast_wpseo_metadesc: "Açıklama" },
    });
    const snapshot = snapshotOf(object, fieldsFixture("yoast"), { withContentRaw: false });
    expect(snapshot).toMatchObject({
      exists: true,
      type: "post",
      id: 42,
      status: "publish",
      modified: "2026-09-10T12:30:00Z",
      seoTitle: "Başlık",
      seoDescription: "Açıklama",
      contentHash: contentHashOf("<p>bir iki üç dört</p>"),
      contentWords: 4,
      contentRaw: null,
    });
  });

  it("keeps contentRaw only when asked and within the limit", () => {
    const object = wpObjectFixture({ content: "<p>x</p>" });
    expect(snapshotOf(object, fieldsFixture("none"), { withContentRaw: true }).contentRaw).toBe("<p>x</p>");
    const big = wpObjectFixture({ content: "a".repeat(200_001) });
    expect(snapshotOf(big, fieldsFixture("none"), { withContentRaw: true }).contentRaw).toBeNull();
  });

  it("handles unavailable content", () => {
    const snapshot = snapshotOf(wpObjectFixture({ content: null }), fieldsFixture("none"), {
      withContentRaw: true,
    });
    expect(snapshot).toMatchObject({ contentHash: null, contentWords: null, contentRaw: null });
  });

  it("does not read SEO values the endpoint cannot return", () => {
    const object = wpObjectFixture({ meta: { rank_math_title: "x" } });
    expect(
      snapshotOf(object, fieldsFixture("rankmath-endpoint"), { withContentRaw: false }).seoTitle,
    ).toBeNull();
  });
});
