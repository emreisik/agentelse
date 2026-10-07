import { describe, expect, it } from "vitest";

import { SEO_UNDO_WINDOW_MS } from "../lifecycle";
import type { SeoChangeKind, SeoChangeParams, SeoChangeStatus, WpSnapshot } from "../types";
import { contentHashOf } from "./snapshot";
import { planUndo, undoPrecondition, verifyUndo, type UndoOp } from "./undo";
import { fieldsFixture, snapshotFixture, wpObjectFixture } from "./test-support";

// Bu dosyanın kanıtladığı: geri alma önkoşulları (bizden sonra düzenlendiyse
// cannot_undo), çöpe yalnız dokunulmamış taslak, makale -> yayına al -> yayını geri al ->
// makaleyi geri al zinciri (güncellenen after.modified ile), geri yükleme gövdeleri,
// sonrası bilinmeyen FAILED satır, çok eski ve noop.

const NOW = new Date("2026-10-01T10:00:00Z");
const APPLIED = new Date("2026-09-20T10:00:00Z");
const yoast = fieldsFixture("yoast");

function change(
  kind: SeoChangeKind,
  params: SeoChangeParams,
  overrides: Partial<{
    noop: boolean;
    status: SeoChangeStatus;
    before: WpSnapshot | null;
    after: WpSnapshot | null;
    appliedAt: Date | null;
  }> = {},
) {
  return {
    kind,
    noop: false,
    status: "VERIFIED" as SeoChangeStatus,
    before: null,
    after: null,
    params,
    appliedAt: APPLIED,
    ...overrides,
  };
}

const article: SeoChangeParams = {
  kind: "PUBLISH_ARTICLE",
  creativeId: "c1",
  versionId: "v1",
  title: "T",
  metaDescription: "D",
  markdown: "x",
  language: null,
};
const liveParams: SeoChangeParams = {
  kind: "PUBLISH_LIVE",
  draftChangeId: "d1",
  wpType: "post",
  wpId: 77,
  link: null,
  expectModified: "2026-09-10T12:30:00Z",
  creativeId: "c1",
};
const titleMeta: SeoChangeParams = {
  kind: "TITLE_META",
  url: "https://example.com/x/",
  wpType: "post",
  wpId: 42,
  expectModified: "2026-09-10T12:30:00Z",
  title: "Yeni",
  metaDescription: "Yeni açıklama",
};
const linksParams: SeoChangeParams = {
  kind: "INTERNAL_LINKS",
  url: "https://example.com/x/",
  wpType: "page",
  wpId: 7,
  expectModified: "2026-09-10T12:30:00Z",
  links: [{ toUrl: "https://example.com/a/", anchor: "a" }],
};

const plan = (c: ReturnType<typeof change>, fields = yoast) => planUndo(c, { fields, now: NOW });

describe("planUndo", () => {
  it("PUBLISH_ARTICLE trashes the draft by the id in the after snapshot", () => {
    const result = plan(change("PUBLISH_ARTICLE", article, { after: snapshotFixture({ id: 77, status: "draft" }) }));
    expect(result).toEqual({ ok: true, undo: { op: "trash", type: "post", id: 77 } });
  });

  it("PUBLISH_ARTICLE with an unknown id cannot be undone here", () => {
    expect(plan(change("PUBLISH_ARTICLE", article, { status: "FAILED", after: null }))).toMatchObject({
      ok: false,
      code: "cannot_undo",
    });
  });

  it("PUBLISH_LIVE unpublishes the post", () => {
    expect(plan(change("PUBLISH_LIVE", liveParams))).toEqual({
      ok: true,
      undo: { op: "unpublish", type: "post", id: 77 },
    });
  });

  it("TITLE_META restores the before values through meta", () => {
    const before = snapshotFixture({ seoTitle: "Eski", seoDescription: "Eski açıklama" });
    expect(plan(change("TITLE_META", titleMeta, { before }))).toEqual({
      ok: true,
      undo: {
        op: "restore",
        type: "post",
        id: 42,
        body: { meta: { _yoast_wpseo_title: "Eski", _yoast_wpseo_metadesc: "Eski açıklama" } },
        endpointMeta: null,
      },
    });
  });

  it("TITLE_META restores an empty before value with an empty string", () => {
    const before = snapshotFixture({ seoTitle: "", seoDescription: null });
    const result = plan(change("TITLE_META", titleMeta, { before }));
    expect(result).toMatchObject({
      ok: true,
      undo: { body: { meta: { _yoast_wpseo_title: "", _yoast_wpseo_metadesc: "" } } },
    });
  });

  it("TITLE_META restores only the fields the change touched", () => {
    const before = snapshotFixture({ seoTitle: "Eski", seoDescription: "Eski açıklama" });
    const result = plan(change("TITLE_META", { ...titleMeta, metaDescription: null }, { before }));
    expect(result).toMatchObject({
      ok: true,
      undo: { body: { meta: { _yoast_wpseo_title: "Eski" } } },
    });
    if (result.ok && result.undo.op === "restore") {
      expect(result.undo.body.meta).not.toHaveProperty("_yoast_wpseo_metadesc");
    }
  });

  it("TITLE_META restores the core title when the plugin hides its fields", () => {
    const before = snapshotFixture({ title: "Eski başlık" });
    const result = plan(change("TITLE_META", { ...titleMeta, metaDescription: null }, { before }), fieldsFixture("yoast-hidden"));
    expect(result).toEqual({
      ok: true,
      undo: { op: "restore", type: "post", id: 42, body: { title: "Eski başlık" }, endpointMeta: null },
    });
  });

  it("TITLE_META restores Rank Math endpoint fields through endpointMeta", () => {
    const before = snapshotFixture({ seoTitle: null, seoDescription: null });
    const result = plan(change("TITLE_META", titleMeta, { before }), fieldsFixture("rankmath-endpoint"));
    expect(result).toEqual({
      ok: true,
      undo: {
        op: "restore",
        type: "post",
        id: 42,
        body: {},
        endpointMeta: { rank_math_title: "", rank_math_description: "" },
      },
    });
  });

  it("TITLE_META without a plugin and only a description has nothing to restore", () => {
    const before = snapshotFixture();
    expect(
      plan(change("TITLE_META", { ...titleMeta, title: null }, { before }), fieldsFixture("none")),
    ).toMatchObject({ ok: false, code: "cannot_undo" });
  });

  it("TITLE_META without a before snapshot cannot be undone", () => {
    expect(plan(change("TITLE_META", titleMeta))).toMatchObject({ ok: false, code: "cannot_undo" });
    expect(plan(change("TITLE_META", titleMeta, { before: snapshotFixture({ exists: false }) }))).toMatchObject({
      ok: false,
    });
  });

  it("INTERNAL_LINKS restores the stored raw content", () => {
    const before = snapshotFixture({ type: "page", id: 7, contentRaw: "<p>orijinal</p>" });
    expect(plan(change("INTERNAL_LINKS", linksParams, { before }))).toEqual({
      ok: true,
      undo: {
        op: "restore",
        type: "page",
        id: 7,
        body: { content: "<p>orijinal</p>" },
        endpointMeta: null,
      },
    });
  });

  it("INTERNAL_LINKS cannot be undone once the raw content was dropped (too old)", () => {
    expect(plan(change("INTERNAL_LINKS", linksParams, { before: snapshotFixture({ contentRaw: null }) }))).toMatchObject({
      ok: false,
      code: "cannot_undo",
    });
  });

  it("allows a written FAILED row and restores only touched fields with an unknown after", () => {
    const before = snapshotFixture({ seoTitle: "Eski", seoDescription: "Eski açıklama" });
    const result = plan(change("TITLE_META", { ...titleMeta, metaDescription: null }, { status: "FAILED", before, after: null }));
    expect(result).toMatchObject({ ok: true, undo: { body: { meta: { _yoast_wpseo_title: "Eski" } } } });
  });

  it("refuses noops, never-written rows, unfinished rows and rows past the window", () => {
    const before = snapshotFixture({ seoTitle: "Eski", seoDescription: "x" });
    expect(plan(change("TITLE_META", titleMeta, { before, noop: true }))).toMatchObject({ ok: false });
    expect(plan(change("TITLE_META", titleMeta, { before, appliedAt: null }))).toMatchObject({ ok: false });
    expect(plan(change("TITLE_META", titleMeta, { before, status: "APPLIED" }))).toMatchObject({ ok: false });
    expect(plan(change("TITLE_META", titleMeta, { before, status: "FAILED", appliedAt: null }))).toMatchObject({
      ok: false,
    });
    const old = new Date(NOW.getTime() - SEO_UNDO_WINDOW_MS - 1000);
    expect(plan(change("TITLE_META", titleMeta, { before, appliedAt: old }))).toMatchObject({
      ok: false,
      code: "cannot_undo",
    });
    const edge = new Date(NOW.getTime() - SEO_UNDO_WINDOW_MS);
    expect(plan(change("TITLE_META", titleMeta, { before, appliedAt: edge })).ok).toBe(true);
  });
});

describe("undoPrecondition", () => {
  const after = snapshotFixture({ id: 77, status: "draft", modified: "2026-09-10T12:35:00Z" });

  it("PUBLISH_ARTICLE: only an untouched draft", () => {
    const base = { kind: "PUBLISH_ARTICLE" as const, status: "VERIFIED" as const, after };
    expect(undoPrecondition(base, wpObjectFixture({ status: "draft", modified: "2026-09-10T12:35:00Z" }))).toBe(true);
    // Kullanıcı taslağı düzenledi.
    expect(undoPrecondition(base, wpObjectFixture({ status: "draft", modified: "2026-09-11T00:00:00Z" }))).toBe(false);
    // Taslak yayınlanmış.
    expect(undoPrecondition(base, wpObjectFixture({ status: "publish", modified: "2026-09-10T12:35:00Z" }))).toBe(false);
    expect(undoPrecondition(base, null)).toBe(false);
    expect(undoPrecondition({ ...base, after: null }, wpObjectFixture({ status: "draft" }))).toBe(false);
  });

  it("PUBLISH_LIVE: the post must still be public", () => {
    const base = { kind: "PUBLISH_LIVE" as const, status: "VERIFIED" as const, after: null };
    expect(undoPrecondition(base, wpObjectFixture({ status: "publish" }))).toBe(true);
    expect(undoPrecondition(base, wpObjectFixture({ status: "draft" }))).toBe(false);
  });

  it("TITLE_META and INTERNAL_LINKS: modified must equal the after snapshot", () => {
    for (const kind of ["TITLE_META", "INTERNAL_LINKS"] as const) {
      const base = { kind, status: "VERIFIED" as const, after: snapshotFixture({ modified: "2026-09-10T12:35:00Z" }) };
      expect(undoPrecondition(base, wpObjectFixture({ modified: "2026-09-10T12:35:00Z" }))).toBe(true);
      expect(undoPrecondition(base, wpObjectFixture({ modified: "2026-09-12T00:00:00Z" }))).toBe(false);
    }
  });

  it("skips the modified check only for a FAILED row with an unknown after", () => {
    const failed = { kind: "TITLE_META" as const, status: "FAILED" as const, after: null };
    expect(undoPrecondition(failed, wpObjectFixture({ modified: "2030-01-01T00:00:00Z" }))).toBe(true);
    expect(undoPrecondition({ ...failed, status: "VERIFIED" }, wpObjectFixture())).toBe(false);
    expect(undoPrecondition(failed, null)).toBe(false);
  });
});

describe("article -> make live -> undo live -> undo article chain", () => {
  it("works when the engine keeps after.modified current across the live cycle", () => {
    // 1. Makale taslağı oluşturuldu.
    let articleAfter = snapshotFixture({ id: 77, status: "draft", modified: "2026-09-10T12:00:00Z" });
    let site = wpObjectFixture({ id: 77, status: "draft", modified: "2026-09-10T12:00:00Z" });
    const articleChange = () => ({ kind: "PUBLISH_ARTICLE" as const, status: "VERIFIED" as const, after: articleAfter });

    // 2. Yayına alındı: site modified ilerler, motor taslak değişikliğinin after'ını günceller.
    site = { ...site, status: "publish", modified: "2026-09-10T13:00:00Z" };
    articleAfter = { ...articleAfter, status: "publish", modified: "2026-09-10T13:00:00Z" };
    // Yayındaki makale çöpe atılamaz.
    expect(undoPrecondition(articleChange(), site)).toBe(false);

    // 3. Yayın geri alındı (taslağa döndü): modified yine ilerler, after yine güncellenir.
    expect(undoPrecondition({ kind: "PUBLISH_LIVE", status: "VERIFIED", after: null }, site)).toBe(true);
    site = { ...site, status: "draft", modified: "2026-09-10T14:00:00Z" };
    articleAfter = { ...articleAfter, status: "draft", modified: "2026-09-10T14:00:00Z" };

    // 4. Makale artık geri alınabilir.
    expect(undoPrecondition(articleChange(), site)).toBe(true);
    expect(plan(change("PUBLISH_ARTICLE", article, { after: articleAfter }))).toMatchObject({
      ok: true,
      undo: { op: "trash", id: 77 },
    });
  });

  it("would refuse if the after snapshot were left stale", () => {
    const stale = { kind: "PUBLISH_ARTICLE" as const, status: "VERIFIED" as const, after: snapshotFixture({ status: "draft", modified: "2026-09-10T12:00:00Z" }) };
    expect(undoPrecondition(stale, wpObjectFixture({ status: "draft", modified: "2026-09-10T14:00:00Z" }))).toBe(false);
  });
});

describe("verifyUndo", () => {
  it("trash: the object is gone or in the trash", () => {
    const op: UndoOp = { op: "trash", type: "post", id: 77 };
    expect(verifyUndo(op, null, null)).toBe(true);
    expect(verifyUndo(op, wpObjectFixture({ status: "trash" }), null)).toBe(true);
    expect(verifyUndo(op, wpObjectFixture({ status: "draft" }), null)).toBe(false);
  });

  it("unpublish: the post is a draft again", () => {
    const op: UndoOp = { op: "unpublish", type: "post", id: 77 };
    expect(verifyUndo(op, wpObjectFixture({ status: "draft" }), null)).toBe(true);
    expect(verifyUndo(op, wpObjectFixture({ status: "publish" }), null)).toBe(false);
    expect(verifyUndo(op, null, null)).toBe(false);
  });

  it("restore: title, content and exposed meta match", () => {
    const raw = "<p>orijinal</p>";
    const op: UndoOp = {
      op: "restore",
      type: "page",
      id: 7,
      body: { title: "Eski", content: raw, meta: { _yoast_wpseo_title: "Eski SEO" } },
      endpointMeta: null,
    };
    const good = wpObjectFixture({ title: "Eski", content: raw, meta: { _yoast_wpseo_title: "Eski SEO" } });
    expect(verifyUndo(op, good, snapshotFixture({ contentHash: contentHashOf(raw) }))).toBe(true);
    expect(verifyUndo(op, { ...good, title: "Yeni" }, null)).toBe(false);
    expect(verifyUndo(op, { ...good, content: "<p>başka</p>" }, null)).toBe(false);
    expect(verifyUndo(op, { ...good, content: null }, null)).toBe(false);
    expect(verifyUndo(op, { ...good, meta: { _yoast_wpseo_title: "Yeni SEO" } }, null)).toBe(false);
    // Görünmeyen meta anahtarı denetlenemez, engel değildir.
    expect(verifyUndo(op, { ...good, meta: {} }, null)).toBe(true);
    expect(verifyUndo(op, null, null)).toBe(false);
  });
});
