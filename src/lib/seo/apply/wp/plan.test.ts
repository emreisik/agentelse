import { describe, expect, it } from "vitest";

import type { SeoChangeParams, WpCapabilities, WpSnapshot } from "../types";
import { contentHashOf, snapshotOf, textHashOf } from "./snapshot";
import { markdownToBlocks } from "./blocks";
import { planChange, type ChangePlan } from "./plan";
import { probeSeoFields, SEO_META_KEYS } from "./plugin-fields";
import {
  articleMarkdown,
  editorCapabilities,
  fieldsFixture,
  snapshotFixture,
  wpObjectFixture,
} from "./test-support";

// Bu dosyanın kanıtladığı: her değişiklik türü için yaz / noop / reddet; yeniden
// deneme matrisi (zaman aşımına uğrayıp inmiş yazma noop+landedEarlier olur, page_changed
// değil; denemeler arasında kullanıcı düzenlemesi page_changed; çok yazmalı değişiklikte
// ilk yazma inmişse yalnız kalan yazma gönderilir; benimsenen taslak noop+landedEarlier;
// PUBLISH_LIVE page_changed ve landedEarlier); yazı her zaman taslak; yazılabilir alan yoksa
// meta açıklama yok; rankMathMeta ikinci yazma.

const BASE_MODIFIED = "2026-09-10T12:30:00Z";
const LATER_MODIFIED = "2026-09-10T12:31:00Z";
const TARGET = "https://example.com/yerel-seo/";

const yoast = fieldsFixture("yoast");
const caps = editorCapabilities();
const noCaps: WpCapabilities = {
  draftPosts: false,
  publishPosts: false,
  editPublishedPosts: false,
  editPages: false,
  editPublishedPages: false,
  editOthers: false,
  deletePosts: false,
};

function ctx(
  overrides: {
    fields?: typeof yoast;
    capabilities?: WpCapabilities;
    prior?: WpSnapshot | null;
  } = {},
) {
  return {
    fields: overrides.fields ?? yoast,
    capabilities: overrides.capabilities ?? caps,
    prior: overrides.prior ?? null,
  };
}

function expectWrite(plan: ChangePlan) {
  if (plan.kind !== "write") throw new Error(`write bekleniyordu: ${JSON.stringify(plan)}`);
  return plan;
}

// ---- TITLE_META -----------------------------------------------------------------

const titleMeta: Extract<SeoChangeParams, { kind: "TITLE_META" }> = {
  kind: "TITLE_META",
  url: "https://example.com/ornek-yazi/",
  wpType: "post",
  wpId: 42,
  expectModified: BASE_MODIFIED,
  title: "Yeni başlık",
  metaDescription: "Yeni açıklama",
};

function metaLive(overrides: Parameters<typeof wpObjectFixture>[0] = {}) {
  return wpObjectFixture({
    meta: { _yoast_wpseo_title: "Eski", _yoast_wpseo_metadesc: "Eski açıklama" },
    ...overrides,
  });
}

const rankMathMixed = probeSeoFields("RANK_MATH", {
  metaKeys: [SEO_META_KEYS.rankMath.title],
  namespaces: ["wp/v2", "rankmath/v1"],
});

describe("TITLE_META", () => {
  it("writes title and description through Yoast meta", () => {
    const live = metaLive();
    const plan = expectWrite(planChange(titleMeta, live, ctx()));
    expect(plan.writes).toEqual([
      {
        op: "update",
        type: "post",
        id: 42,
        body: {
          meta: { _yoast_wpseo_title: "Yeni başlık", _yoast_wpseo_metadesc: "Yeni açıklama" },
        },
      },
    ]);
    expect(plan.expectAfter).toEqual({ seoTitle: "Yeni başlık", seoDescription: "Yeni açıklama" });
    expect(plan.before).toEqual(snapshotOf(live, yoast, { withContentRaw: false }));
    expect(plan.before.seoTitle).toBe("Eski");
    expect(plan.resumed).toBe(false);
  });

  it("falls back to the core title when the SEO plugin hides its fields", () => {
    const plan = expectWrite(
      planChange({ ...titleMeta, metaDescription: null }, wpObjectFixture(), ctx({ fields: fieldsFixture("yoast-hidden") })),
    );
    expect(plan.writes).toEqual([
      { op: "update", type: "post", id: 42, body: { title: "Yeni başlık" } },
    ]);
    expect(plan.expectAfter).toEqual({ title: "Yeni başlık" });
  });

  it("refuses a description without a writable field", () => {
    for (const kind of ["none", "yoast-hidden"] as const) {
      expect(planChange(titleMeta, wpObjectFixture(), ctx({ fields: fieldsFixture(kind) }))).toEqual({
        kind: "refuse",
        code: "seo_plugin_unsupported",
      });
    }
  });

  it("never writes a meta key when only the title is changed on a plain site", () => {
    const plan = expectWrite(
      planChange({ ...titleMeta, metaDescription: null }, wpObjectFixture(), ctx({ fields: fieldsFixture("none") })),
    );
    expect(plan.writes).toEqual([
      { op: "update", type: "post", id: 42, body: { title: "Yeni başlık" } },
    ]);
  });

  it("sends only the Rank Math endpoint write when both keys are hidden", () => {
    const plan = expectWrite(
      planChange(titleMeta, wpObjectFixture(), ctx({ fields: fieldsFixture("rankmath-endpoint") })),
    );
    expect(plan.writes).toEqual([
      {
        op: "rankMathMeta",
        id: 42,
        meta: { rank_math_title: "Yeni başlık", rank_math_description: "Yeni açıklama" },
      },
    ]);
    // Uç nokta alanları geri okunamaz: beklenen sonuçta yer almaz.
    expect(plan.expectAfter).toEqual({});
  });

  it("never reports an endpoint-only change as already satisfied", () => {
    const live = wpObjectFixture({ meta: { rank_math_title: "Yeni başlık" } });
    expect(planChange(titleMeta, live, ctx({ fields: fieldsFixture("rankmath-endpoint") })).kind).toBe("write");
  });

  it("writes rankMathMeta as the second write after the meta update", () => {
    const plan = expectWrite(planChange(titleMeta, wpObjectFixture(), ctx({ fields: rankMathMixed })));
    expect(plan.writes.map((write) => write.op)).toEqual(["update", "rankMathMeta"]);
    expect(plan.writes[0]).toMatchObject({ body: { meta: { rank_math_title: "Yeni başlık" } } });
    expect(plan.writes[1]).toEqual({ op: "rankMathMeta", id: 42, meta: { rank_math_description: "Yeni açıklama" } });
    expect(plan.expectAfter).toEqual({ seoTitle: "Yeni başlık" });
  });

  it("is a plain noop when the page already has the values", () => {
    const live = metaLive({
      meta: { _yoast_wpseo_title: "Yeni başlık", _yoast_wpseo_metadesc: "Yeni açıklama" },
    });
    const plan = planChange(titleMeta, live, ctx());
    expect(plan).toEqual({
      kind: "noop",
      snapshot: snapshotOf(live, yoast, { withContentRaw: false }),
      landedEarlier: false,
    });
  });

  it("noop is checked before the stale check (modified may differ)", () => {
    const live = metaLive({
      modified: LATER_MODIFIED,
      meta: { _yoast_wpseo_title: "Yeni başlık", _yoast_wpseo_metadesc: "Yeni açıklama" },
    });
    expect(planChange(titleMeta, live, ctx()).kind).toBe("noop");
  });

  it("a timed-out update that landed becomes noop with landedEarlier, not page_changed", () => {
    const prior = snapshotOf(metaLive(), yoast, { withContentRaw: false });
    const live = metaLive({
      modified: LATER_MODIFIED,
      meta: { _yoast_wpseo_title: "Yeni başlık", _yoast_wpseo_metadesc: "Yeni açıklama" },
    });
    const plan = planChange(titleMeta, live, ctx({ prior }));
    expect(plan).toMatchObject({ kind: "noop", landedEarlier: true });
  });

  it("is not landedEarlier when the prior snapshot already satisfied the change", () => {
    const satisfied = metaLive({
      meta: { _yoast_wpseo_title: "Yeni başlık", _yoast_wpseo_metadesc: "Yeni açıklama" },
    });
    const prior = snapshotOf(satisfied, yoast, { withContentRaw: false });
    expect(planChange(titleMeta, satisfied, ctx({ prior }))).toMatchObject({ kind: "noop", landedEarlier: false });
  });

  it("refuses page_changed when the user edited the page between attempts", () => {
    const prior = snapshotOf(metaLive(), yoast, { withContentRaw: false });
    const live = metaLive({ modified: LATER_MODIFIED, title: "Kullanıcı düzenledi" });
    expect(planChange(titleMeta, live, ctx({ prior }))).toEqual({ kind: "refuse", code: "page_changed" });
  });

  it("refuses page_changed on the first attempt when the page changed since proposal", () => {
    expect(planChange(titleMeta, metaLive({ modified: LATER_MODIFIED }), ctx())).toEqual({
      kind: "refuse",
      code: "page_changed",
    });
  });

  it("compares against the stored first-attempt snapshot on a retry", () => {
    // expectModified bayat olsa bile, ilk denemede saklanan before tabandır.
    const prior = snapshotFixture({ modified: LATER_MODIFIED, seoTitle: "Eski", seoDescription: "Eski açıklama" });
    const live = metaLive({ modified: LATER_MODIFIED });
    expect(planChange(titleMeta, live, ctx({ prior })).kind).toBe("write");
  });

  it("resumes only the remaining write when the first write of a multi-write change landed", () => {
    const prior = snapshotOf(wpObjectFixture(), rankMathMixed, { withContentRaw: false });
    const live = wpObjectFixture({ modified: LATER_MODIFIED, meta: { rank_math_title: "Yeni başlık" } });
    const plan = expectWrite(planChange(titleMeta, live, ctx({ fields: rankMathMixed, prior })));
    expect(plan.resumed).toBe(true);
    expect(plan.writes).toEqual([
      { op: "rankMathMeta", id: 42, meta: { rank_math_description: "Yeni açıklama" } },
    ]);
    expect(plan.before).toBe(prior);
    expect(plan.expectAfter).toEqual({ seoTitle: "Yeni başlık" });
  });

  it("does not resume when the page was edited and the first write is not there", () => {
    const prior = snapshotOf(wpObjectFixture(), rankMathMixed, { withContentRaw: false });
    const live = wpObjectFixture({ modified: LATER_MODIFIED, meta: { rank_math_title: "Başkası yazdı" } });
    expect(planChange(titleMeta, live, ctx({ fields: rankMathMixed, prior }))).toEqual({
      kind: "refuse",
      code: "page_changed",
    });
  });

  it("does not resume without a prior snapshot", () => {
    const live = wpObjectFixture({ modified: LATER_MODIFIED, meta: { rank_math_title: "Yeni başlık" } });
    expect(planChange(titleMeta, live, ctx({ fields: rankMathMixed }))).toEqual({
      kind: "refuse",
      code: "page_changed",
    });
  });

  it("sends every write again when the first write did not land (page unchanged)", () => {
    const live = wpObjectFixture();
    const prior = snapshotOf(live, rankMathMixed, { withContentRaw: false });
    const plan = expectWrite(planChange(titleMeta, live, ctx({ fields: rankMathMixed, prior })));
    expect(plan.resumed).toBe(false);
    expect(plan.writes).toHaveLength(2);
  });

  it("refuses when the object is gone", () => {
    expect(planChange(titleMeta, null, ctx())).toEqual({ kind: "refuse", code: "page_not_found" });
  });

  it("refuses without the editing capability", () => {
    expect(planChange(titleMeta, metaLive(), ctx({ capabilities: noCaps }))).toEqual({
      kind: "refuse",
      code: "no_permission",
    });
  });

  it("works for pages", () => {
    const live = metaLive({ type: "page", id: 7, link: "https://example.com/hakkimizda/" });
    const plan = expectWrite(planChange({ ...titleMeta, wpType: "page", wpId: 7 }, live, ctx()));
    expect(plan.writes[0]).toMatchObject({ op: "update", type: "page", id: 7 });
  });
});

// ---- INTERNAL_LINKS -------------------------------------------------------------

const para = (text: string) => `<!-- wp:paragraph -->\n<p>${text}</p>\n<!-- /wp:paragraph -->`;
const links: Extract<SeoChangeParams, { kind: "INTERNAL_LINKS" }> = {
  kind: "INTERNAL_LINKS",
  url: "https://example.com/ornek-yazi/",
  wpType: "post",
  wpId: 42,
  expectModified: BASE_MODIFIED,
  links: [{ toUrl: TARGET, anchor: "yerel seo rehberi" }],
};

describe("INTERNAL_LINKS", () => {
  const raw = para("Burada yerel seo rehberi var.");
  const linked = para(`Burada <a href="${TARGET}">yerel seo rehberi</a> var.`);

  it("writes the new content and expects its hash", () => {
    const live = wpObjectFixture({ content: raw });
    const plan = expectWrite(planChange(links, live, ctx()));
    expect(plan.writes).toEqual([{ op: "update", type: "post", id: 42, body: { content: linked } }]);
    expect(plan.expectAfter).toEqual({ contentHash: contentHashOf(linked) });
    expect(plan.before.contentRaw).toBe(raw);
    expect(plan.resumed).toBe(false);
  });

  it("is a plain noop when the link is already there", () => {
    const live = wpObjectFixture({ content: linked });
    expect(planChange(links, live, ctx())).toMatchObject({ kind: "noop", landedEarlier: false });
  });

  it("a write that landed after a timeout is noop with landedEarlier", () => {
    const prior = snapshotOf(wpObjectFixture({ content: raw }), yoast, { withContentRaw: true });
    const live = wpObjectFixture({ content: linked, modified: LATER_MODIFIED });
    expect(planChange(links, live, ctx({ prior }))).toMatchObject({ kind: "noop", landedEarlier: true });
  });

  it("refuses page_changed when the content changed in between", () => {
    const prior = snapshotOf(wpObjectFixture({ content: raw }), yoast, { withContentRaw: true });
    const live = wpObjectFixture({ content: raw + "\n\n" + para("Yeni paragraf"), modified: LATER_MODIFIED });
    expect(planChange(links, live, ctx({ prior }))).toEqual({ kind: "refuse", code: "page_changed" });
    expect(planChange(links, live, ctx())).toEqual({ kind: "refuse", code: "page_changed" });
  });

  it("refuses page builders and unreadable content", () => {
    expect(
      planChange(links, wpObjectFixture({ content: '<div data-elementor-type="wp-page"><p>yerel seo rehberi</p></div>' }), ctx()),
    ).toEqual({ kind: "refuse", code: "builder_page" });
    expect(planChange(links, wpObjectFixture({ content: null }), ctx())).toEqual({
      kind: "refuse",
      code: "builder_page",
    });
    expect(planChange(links, wpObjectFixture({ content: "" }), ctx())).toEqual({
      kind: "refuse",
      code: "builder_page",
    });
  });

  it("refuses when an anchor is not in an eligible paragraph", () => {
    const live = wpObjectFixture({ content: para("Hiç ilgisiz bir metin.") });
    expect(planChange(links, live, ctx())).toEqual({ kind: "refuse", code: "anchor_not_found" });
  });

  it("refuses when the object is gone or the capability is missing", () => {
    expect(planChange(links, null, ctx())).toEqual({ kind: "refuse", code: "page_not_found" });
    expect(planChange(links, wpObjectFixture({ content: raw }), ctx({ capabilities: noCaps }))).toEqual({
      kind: "refuse",
      code: "no_permission",
    });
  });
});

// ---- PUBLISH_ARTICLE ------------------------------------------------------------

const article: Extract<SeoChangeParams, { kind: "PUBLISH_ARTICLE" }> = {
  kind: "PUBLISH_ARTICLE",
  creativeId: "c1",
  versionId: "v1",
  title: "Yerel SEO rehberi",
  metaDescription: "Yerel işletmeler için kısa ve uygulanabilir bir rehber.",
  markdown: articleMarkdown(),
  language: "tr",
};

describe("PUBLISH_ARTICLE", () => {
  it("creates a draft with blocks, excerpt and the Yoast description", () => {
    const plan = expectWrite(planChange(article, null, ctx()));
    const { content } = markdownToBlocks(article.markdown, { title: article.title });
    expect(plan.writes).toEqual([
      {
        op: "create",
        type: "post",
        body: {
          title: "Yerel SEO rehberi",
          status: "draft",
          content,
          excerpt: article.metaDescription,
          meta: { _yoast_wpseo_metadesc: article.metaDescription },
        },
      },
    ]);
    expect(plan.expectAfter).toEqual({
      status: "draft",
      title: "Yerel SEO rehberi",
      textHash: textHashOf(content),
      excerpt: article.metaDescription,
      seoDescription: article.metaDescription,
    });
    expect(plan.before.exists).toBe(false);
  });

  it("always creates the post as a draft, whatever the SEO plugin", () => {
    for (const kind of ["yoast", "yoast-hidden", "rankmath", "rankmath-endpoint", "none"] as const) {
      const plan = expectWrite(planChange(article, null, ctx({ fields: fieldsFixture(kind) })));
      for (const write of plan.writes) {
        expect(write.op).toBe("create");
        if (write.op === "create") expect(write.body.status).toBe("draft");
      }
      expect(plan.expectAfter.status).toBe("draft");
    }
  });

  it("puts no meta description in the body without a writable field", () => {
    for (const kind of ["none", "yoast-hidden", "rankmath-endpoint"] as const) {
      const plan = expectWrite(planChange(article, null, ctx({ fields: fieldsFixture(kind) })));
      const write = plan.writes[0];
      expect(write && write.op === "create" ? write.body.meta : "x").toBeUndefined();
      expect(plan.expectAfter.seoDescription).toBeUndefined();
    }
  });

  it("cuts the excerpt at 300 characters and the post title at 120", () => {
    const long = { ...article, title: "T".repeat(150), metaDescription: "A".repeat(400) };
    const write = expectWrite(planChange(long, null, ctx())).writes[0];
    if (!write || write.op !== "create") throw new Error("create bekleniyordu");
    expect(write.body.excerpt).toHaveLength(300);
    expect(write.body.title.length).toBeLessThanOrEqual(120);
  });

  it("adopts an existing draft as noop with landedEarlier", () => {
    const draft = wpObjectFixture({ id: 77, status: "draft", link: "https://example.com/?p=77" });
    const plan = planChange(article, draft, ctx());
    expect(plan).toMatchObject({ kind: "noop", landedEarlier: true });
    if (plan.kind === "noop") expect(plan.snapshot.id).toBe(77);
  });

  it("refuses without the draft capability", () => {
    expect(planChange(article, null, ctx({ capabilities: noCaps }))).toEqual({
      kind: "refuse",
      code: "no_permission",
    });
  });
});

// ---- PUBLISH_LIVE ---------------------------------------------------------------

const live: Extract<SeoChangeParams, { kind: "PUBLISH_LIVE" }> = {
  kind: "PUBLISH_LIVE",
  draftChangeId: "d1",
  wpType: "post",
  wpId: 77,
  link: null,
  expectModified: BASE_MODIFIED,
  creativeId: "c1",
};

const draft = (overrides: Parameters<typeof wpObjectFixture>[0] = {}) =>
  wpObjectFixture({ id: 77, status: "draft", ...overrides });

describe("PUBLISH_LIVE", () => {
  it("publishes a draft that was not touched", () => {
    const plan = expectWrite(planChange(live, draft(), ctx()));
    expect(plan.writes).toEqual([{ op: "update", type: "post", id: 77, body: { status: "publish" } }]);
    expect(plan.expectAfter).toEqual({ status: "publish" });
    expect(plan.before.status).toBe("draft");
  });

  it("accepts pending, future and private posts but refuses trash and auto-draft", () => {
    for (const status of ["pending", "future", "private"]) {
      expect(planChange(live, draft({ status }), ctx()).kind).toBe("write");
    }
    for (const status of ["trash", "auto-draft"]) {
      expect(planChange(live, draft({ status }), ctx())).toEqual({ kind: "refuse", code: "rejected_by_site" });
    }
  });

  it("refuses page_changed when the draft was edited after approval", () => {
    expect(planChange(live, draft({ modified: LATER_MODIFIED }), ctx())).toEqual({
      kind: "refuse",
      code: "page_changed",
    });
  });

  it("is a plain noop when the post is already public", () => {
    expect(planChange(live, draft({ status: "publish", modified: LATER_MODIFIED }), ctx())).toMatchObject({
      kind: "noop",
      landedEarlier: false,
    });
  });

  it("is landedEarlier when our earlier publish landed (prior was a draft)", () => {
    const prior = snapshotFixture({ id: 77, status: "draft", modified: BASE_MODIFIED });
    const plan = planChange(live, draft({ status: "publish", modified: LATER_MODIFIED }), ctx({ prior }));
    expect(plan).toMatchObject({ kind: "noop", landedEarlier: true });
  });

  it("is not landedEarlier when the prior snapshot was already public", () => {
    const prior = snapshotFixture({ id: 77, status: "publish" });
    expect(planChange(live, draft({ status: "publish" }), ctx({ prior }))).toMatchObject({
      kind: "noop",
      landedEarlier: false,
    });
  });

  it("uses the prior snapshot as the stale baseline on a retry", () => {
    const prior = snapshotFixture({ id: 77, status: "draft", modified: LATER_MODIFIED });
    expect(planChange(live, draft({ modified: LATER_MODIFIED }), ctx({ prior })).kind).toBe("write");
    expect(planChange(live, draft({ modified: "2026-09-11T00:00:00Z" }), ctx({ prior }))).toEqual({
      kind: "refuse",
      code: "page_changed",
    });
  });

  it("refuses when the post is gone or the capability is missing", () => {
    expect(planChange(live, null, ctx())).toEqual({ kind: "refuse", code: "page_not_found" });
    expect(planChange(live, draft(), ctx({ capabilities: { ...caps, publishPosts: false } }))).toEqual({
      kind: "refuse",
      code: "no_permission",
    });
  });
});
