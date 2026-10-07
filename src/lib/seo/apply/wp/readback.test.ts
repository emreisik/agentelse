import { describe, expect, it } from "vitest";

import { verifyReadBack } from "./readback";
import { contentHashOf, textHashOf } from "./snapshot";
import { fieldsFixture, wpObjectFixture } from "./test-support";

// Bu dosyanın kanıtladığı: çekirdek alanlar birebir karşılaştırılır (yalnız HTML
// varlık kodlaması farkı tolere edilir), yeni içerik metin özetiyle (blokların yeniden
// serileştirilmesi sorun değil), mevcut içerik bayt özetiyle doğrulanır; uç nokta
// eklentisinde partial=true döner; uyuşmazlıkta nedenler ve okunan görüntü verilir.

const yoast = fieldsFixture("yoast");
const options = { fields: yoast, withContentRaw: false };

describe("verifyReadBack", () => {
  it("accepts matching core fields", () => {
    const after = wpObjectFixture({ status: "draft", title: "Başlık", excerpt: "Özet" });
    const result = verifyReadBack({ status: "draft", title: "Başlık", excerpt: "Özet" }, after, options);
    expect(result).toMatchObject({ ok: true, partial: false });
    if (result.ok) expect(result.snapshot).toMatchObject({ id: 42, status: "draft", title: "Başlık" });
  });

  it("fails on a different status or title and names the fields", () => {
    const after = wpObjectFixture({ status: "publish", title: "Başka" });
    const result = verifyReadBack({ status: "draft", title: "Başlık" }, after, options);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.reason).toContain("status");
      expect(result.reason).toContain("title");
      expect(result.snapshot).toMatchObject({ status: "publish", title: "Başka" });
    }
  });

  it("tolerates HTML entity encoding that WordPress adds for restricted users", () => {
    const after = wpObjectFixture({ title: "Tom &amp; Jerry", excerpt: "A &lt; B" });
    expect(verifyReadBack({ title: "Tom & Jerry", excerpt: "A < B" }, after, options).ok).toBe(true);
    expect(verifyReadBack({ title: "Tom and Jerry" }, after, options).ok).toBe(false);
  });

  it("compares the text hash for created content, tolerating re-serialized blocks", () => {
    const created = '<!-- wp:paragraph -->\n<p>Merhaba <strong>dünya</strong></p>\n<!-- /wp:paragraph -->';
    const stored = '<p>Merhaba <strong>dünya</strong></p>';
    expect(verifyReadBack({ textHash: textHashOf(created) }, wpObjectFixture({ content: stored }), options).ok).toBe(true);
    const changed = verifyReadBack({ textHash: textHashOf(created) }, wpObjectFixture({ content: "<p>Merhaba</p>" }), options);
    expect(changed).toMatchObject({ ok: false });
    if (!changed.ok) expect(changed.reason).toContain("content");
  });

  it("compares the content hash exactly for edited pages", () => {
    const raw = "<p>a</p>";
    expect(verifyReadBack({ contentHash: contentHashOf(raw) }, wpObjectFixture({ content: raw }), options).ok).toBe(true);
    expect(verifyReadBack({ contentHash: contentHashOf(raw) }, wpObjectFixture({ content: raw + " " }), options).ok).toBe(false);
    expect(verifyReadBack({ contentHash: contentHashOf(raw) }, wpObjectFixture({ content: null }), options).ok).toBe(false);
  });

  it("reads Yoast fields through meta", () => {
    const after = wpObjectFixture({ meta: { _yoast_wpseo_title: "T", _yoast_wpseo_metadesc: "D" } });
    expect(verifyReadBack({ seoTitle: "T", seoDescription: "D" }, after, options)).toMatchObject({ ok: true, partial: false });
    const wrong = verifyReadBack({ seoTitle: "T", seoDescription: "X" }, after, options);
    expect(wrong).toMatchObject({ ok: false });
    if (!wrong.ok) expect(wrong.reason).toContain("seoDescription");
  });

  it("reports partial when a plugin field cannot be read", () => {
    const fields = fieldsFixture("rankmath-endpoint");
    const result = verifyReadBack({}, wpObjectFixture(), { fields, withContentRaw: false });
    expect(result).toMatchObject({ ok: true, partial: true });
  });

  it("still checks exposed meta fields on a partly endpoint-backed plugin", () => {
    const fields = { ...fieldsFixture("rankmath"), descriptionVia: "RANKMATH_ENDPOINT" as const, verifiable: false };
    const after = wpObjectFixture({ meta: { rank_math_title: "T" } });
    expect(verifyReadBack({ seoTitle: "T" }, after, { fields, withContentRaw: false })).toMatchObject({ ok: true, partial: true });
    expect(verifyReadBack({ seoTitle: "Y" }, after, { fields, withContentRaw: false }).ok).toBe(false);
  });

  it("fails without a snapshot when the object cannot be read", () => {
    expect(verifyReadBack({ status: "draft" }, null, options)).toEqual({
      ok: false,
      reason: "The item could not be read back.",
      snapshot: null,
    });
  });

  it("keeps the content when asked to", () => {
    const after = wpObjectFixture({ content: "<p>x</p>" });
    const result = verifyReadBack({}, after, { fields: yoast, withContentRaw: true });
    if (!result.ok) throw new Error("ok bekleniyordu");
    expect(result.snapshot.contentRaw).toBe("<p>x</p>");
  });

  it("an empty expectation passes", () => {
    expect(verifyReadBack({}, wpObjectFixture(), options)).toMatchObject({ ok: true });
  });
});
