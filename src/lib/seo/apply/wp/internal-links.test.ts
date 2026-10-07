import { describe, expect, it } from "vitest";

import {
  hasBuilderMarkers,
  insertInternalLinks,
  linksPresent,
} from "./internal-links";
import { wpFixtures } from "./test-support";
import { parseWpObject } from "./parse";

// Bu dosyanın kanıtladığı: ilk uygun eşleşmeye bağlantı yazılır; bağlantı,
// başlık, kod, etiket ve öznitelik içine yazılmaz; hedefe zaten bağlantı varsa
// değişiklik olmaz; sayfa oluşturucular reddedilir; bulunamayan çapalar listelenir;
// büyük/küçük harf korunur; Türkçe i/İ çapaları eşleşir; klasik editör içeriğine
// <p> eklenmeden satır içi bağlantı yazılır; karışık blok içeriğinde yalnız
// paragraflara dokunulur.

const TARGET = "https://example.com/yerel-seo/";

function block(text: string): string {
  return `<!-- wp:paragraph -->\n<p>${text}</p>\n<!-- /wp:paragraph -->`;
}

function run(raw: string, anchor: string, toUrl = TARGET) {
  return insertInternalLinks(raw, [{ toUrl, anchor }]);
}

function rawOf(result: ReturnType<typeof insertInternalLinks>): string {
  if (!result.ok) throw new Error(`beklenmedik red: ${result.code}`);
  return result.raw;
}

describe("block mode", () => {
  it("links the first eligible match only", () => {
    const raw = [block("Önce yerel seo rehberi var."), block("Sonra yerel seo rehberi yine.")].join("\n\n");
    const out = rawOf(run(raw, "yerel seo rehberi"));
    expect(out.match(/<a /g)).toHaveLength(1);
    expect(out).toContain(`<p>Önce <a href="${TARGET}">yerel seo rehberi</a> var.</p>`);
    expect(out).toContain("<p>Sonra yerel seo rehberi yine.</p>");
  });

  it("keeps the original case of the matched text", () => {
    const out = rawOf(run(block("Okuyun: Yerel SEO Rehberi bugün."), "yerel seo rehberi"));
    expect(out).toContain(`<a href="${TARGET}">Yerel SEO Rehberi</a>`);
  });

  it("does not write inside links, headings, code, buttons or attributes", () => {
    const raw = [
      '<!-- wp:heading -->\n<h2 class="wp-block-heading">Yerel SEO rehberi</h2>\n<!-- /wp:heading -->',
      block('<a href="https://x.com/">yerel seo rehberi</a> ve <code>yerel seo rehberi</code>'),
      block('<img alt="yerel seo rehberi" src="/a.png"> <span title="yerel seo rehberi">x</span>'),
      '<!-- wp:buttons -->\n<div class="wp-block-buttons"><!-- wp:button -->\n<div class="wp-block-button"><a class="wp-block-button__link">yerel seo rehberi</a></div>\n<!-- /wp:button --></div>\n<!-- /wp:buttons -->',
    ].join("\n\n");
    const result = run(raw, "yerel seo rehberi");
    expect(result).toEqual({
      ok: false,
      code: "anchor_not_found",
      missing: ["yerel seo rehberi"],
    });
  });

  it("skips ineligible text and takes a later eligible match", () => {
    const raw = [
      '<!-- wp:heading -->\n<h2>Yerel SEO rehberi</h2>\n<!-- /wp:heading -->',
      block("Ama burada yerel SEO rehberi geçiyor."),
    ].join("\n\n");
    const out = rawOf(run(raw, "yerel seo rehberi"));
    expect(out).toContain(`<h2>Yerel SEO rehberi</h2>`);
    expect(out).toContain(`<a href="${TARGET}">yerel SEO rehberi</a>`);
  });

  it("does not match inside a longer word or an HTML entity", () => {
    expect(run(block("Rehberimiz yerel seo rehberimiz hakkında."), "yerel seo rehber")).toMatchObject({
      ok: false,
      code: "anchor_not_found",
    });
    expect(run(block("Tom &amp; Jerry"), "amp")).toMatchObject({ ok: false });
    expect(run(block("Kod &#39; işareti"), "39")).toMatchObject({ ok: false });
  });

  it("matches whole words next to punctuation", () => {
    const out = rawOf(run(block("(yerel seo), değil mi?"), "yerel seo"));
    expect(out).toContain(`(<a href="${TARGET}">yerel seo</a>)`);
  });

  it("only touches paragraphs in mixed block content", () => {
    const raw = [
      '<!-- wp:list -->\n<ul class="wp-block-list"><!-- wp:list-item -->\n<li>yerel seo</li>\n<!-- /wp:list-item --></ul>\n<!-- /wp:list -->',
      '<!-- wp:html -->\n<p>yerel seo</p>\n<!-- /wp:html -->',
      '<!-- wp:code -->\n<pre class="wp-block-code"><code>yerel seo</code></pre>\n<!-- /wp:code -->',
      block("Burada yerel seo var."),
    ].join("\n\n");
    const out = rawOf(run(raw, "yerel seo"));
    expect(out.match(/<a /g)).toHaveLength(1);
    expect(out).toContain("<li>yerel seo</li>");
    expect(out).toContain("<!-- wp:html -->\n<p>yerel seo</p>");
    expect(out).toContain(`Burada <a href="${TARGET}">yerel seo</a> var.`);
  });

  it("links inside a quote paragraph", () => {
    const raw = `<!-- wp:quote -->\n<blockquote class="wp-block-quote">${block("yerel seo sözü")}</blockquote>\n<!-- /wp:quote -->`;
    expect(rawOf(run(raw, "yerel seo"))).toContain(`<a href="${TARGET}">yerel seo</a> sözü`);
  });

  it("escapes & in the href", () => {
    const out = rawOf(run(block("Bkz. yerel seo."), "yerel seo", "https://example.com/a?x=1&y=2"));
    expect(out).toContain('href="https://example.com/a?x=1&amp;y=2"');
  });

  it("is not confused by > inside an attribute value or by script bodies", () => {
    const raw = [
      '<!-- wp:html -->\n<script>if (a<b) { x = "<p>yerel seo</p>"; }</script>\n<!-- /wp:html -->',
      block('<span data-x="a>b">başka</span> yerel seo burada'),
    ].join("\n\n");
    const out = rawOf(run(raw, "yerel seo"));
    expect(out).toContain(`</span> <a href="${TARGET}">yerel seo</a> burada`);
    expect(out.match(/<a /g)).toHaveLength(1);
  });

  it("inserts several links, each once, and reports every missing anchor", () => {
    const raw = block("Önce ilk konu, sonra ikinci konu.");
    const ok = insertInternalLinks(raw, [
      { toUrl: "https://example.com/a/", anchor: "ilk konu" },
      { toUrl: "https://example.com/b/", anchor: "ikinci konu" },
    ]);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.inserted).toHaveLength(2);
      expect(ok.raw).toContain('<a href="https://example.com/a/">ilk konu</a>');
      expect(ok.raw).toContain('<a href="https://example.com/b/">ikinci konu</a>');
    }
    expect(
      insertInternalLinks(raw, [
        { toUrl: "https://example.com/a/", anchor: "ilk konu" },
        { toUrl: "https://example.com/b/", anchor: "yok bir" },
        { toUrl: "https://example.com/c/", anchor: "yok iki" },
      ]),
    ).toEqual({ ok: false, code: "anchor_not_found", missing: ["yok bir", "yok iki"] });
  });

  it("works on the fixture post", () => {
    const post = parseWpObject(wpFixtures.postEdit, "post");
    const out = rawOf(run(post!.content!, "yerel SEO rehberi hakkında"));
    expect(out).toContain(`<a href="${TARGET}">yerel SEO rehberi hakkında</a>`);
    // Başlıktaki "Yerel SEO rehberi" yazılmaz; yalnız paragraf eşleşir.
    expect(out).toContain('<h2 class="wp-block-heading">Yerel SEO rehberi</h2>');
  });
});

describe("idempotence", () => {
  it("treats a link already pointing at the target as satisfied", () => {
    const raw = block(`Bak <a href="${TARGET}">yerel seo</a> ve yerel seo rehberi.`);
    const result = run(raw, "yerel seo rehberi");
    expect(result).toEqual({ ok: true, raw, inserted: [], alreadyLinked: ["yerel seo rehberi"] });
  });

  it("compares targets ignoring trailing slash, www, fragment and entity-encoded &", () => {
    const raw = block('<a href="https://www.example.com/a?x=1&amp;y=2#top">bir</a>');
    expect(linksPresent(raw, [{ toUrl: "https://example.com/a/?x=1&y=2", anchor: "yok" }])).toBe(true);
    expect(linksPresent(raw, [{ toUrl: "https://example.com/b?x=1&y=2", anchor: "yok" }])).toBe(false);
    expect(linksPresent(raw, [{ toUrl: "https://example.com/a?x=1&y=2", anchor: "yok" }])).toBe(true);
    const slash = block('<a href="/yerel-seo">bir</a>');
    expect(linksPresent(slash, [{ toUrl: TARGET, anchor: "x" }])).toBe(true);
  });

  it("linksPresent needs every link and at least one", () => {
    const raw = block(`<a href="${TARGET}">yerel</a>`);
    expect(linksPresent(raw, [])).toBe(false);
    expect(
      linksPresent(raw, [
        { toUrl: TARGET, anchor: "a" },
        { toUrl: "https://example.com/b/", anchor: "b" },
      ]),
    ).toBe(false);
  });

  it("running the result again changes nothing", () => {
    const first = rawOf(run(block("Burada yerel seo var."), "yerel seo"));
    const second = run(first, "yerel seo");
    expect(second).toMatchObject({ ok: true, raw: first, inserted: [] });
  });
});

describe("refusals", () => {
  it("refuses page builders", () => {
    for (const raw of [
      '<div data-elementor-type="wp-page"><p>yerel seo</p></div>',
      '[et_pb_section][et_pb_text]yerel seo[/et_pb_text][/et_pb_section]',
      '[vc_row][vc_column]yerel seo[/vc_column][/vc_row]',
      '<div class="fusion-builder-row"><p>yerel seo</p></div>',
      '<div class="elementor-element"><p>yerel seo</p></div>',
    ]) {
      expect(run(raw, "yerel seo")).toEqual({ ok: false, code: "builder_page", missing: [] });
      expect(hasBuilderMarkers(raw)).toBe(true);
    }
    expect(hasBuilderMarkers(block("Elementor hakkında bir yazı."))).toBe(false);
  });

  it("refuses empty and oversized content", () => {
    expect(run("  \n ", "x")).toEqual({ ok: false, code: "empty_content", missing: [] });
    expect(run("a".repeat(200_001), "x")).toEqual({ ok: false, code: "too_large", missing: [] });
  });

  it("refuses anchors with markup or surrounding spaces", () => {
    const raw = block("Burada yerel seo var.");
    expect(run(raw, "<b>yerel seo</b>")).toMatchObject({ ok: false, code: "anchor_not_found" });
    expect(run(raw, " yerel seo")).toMatchObject({ ok: false, code: "anchor_not_found" });
  });
});

describe("unicode", () => {
  it("matches Turkish anchors regardless of i/İ/I/ı case", () => {
    const upper = rawOf(run(block("DİYABET İÇİN rehber"), "diyabet için"));
    expect(upper).toContain(`<a href="${TARGET}">DİYABET İÇİN</a>`);
    const lower = rawOf(run(block("Diyabet için rehber"), "DİYABET İÇİN"));
    expect(lower).toContain(`<a href="${TARGET}">Diyabet için</a>`);
    const dotless = rawOf(run(block("ISIL işlem"), "ısıl"));
    expect(dotless).toContain(`<a href="${TARGET}">ISIL</a>`);
  });

  it("does not match a Turkish word inside a longer one", () => {
    expect(run(block("kızıl ışık"), "kız")).toMatchObject({ ok: false });
  });

  it("keeps offsets right after a dotted capital I earlier in the text", () => {
    const out = rawOf(run(block("İstanbul İzmir ve yerel seo"), "yerel seo"));
    expect(out).toContain(`İstanbul İzmir ve <a href="${TARGET}">yerel seo</a>`);
  });
});

describe("classic editor content", () => {
  it("links blank-line separated text without adding <p>", () => {
    const page = parseWpObject(wpFixtures.pageEdit, "page")!;
    const out = rawOf(run(page.content!, "yerel SEO rehberi hazırlamak"));
    expect(out).toContain(
      `Hizmetlerimiz arasında <a href="${TARGET}">yerel SEO rehberi hazırlamak</a> da var.`,
    );
    expect(out).not.toContain("<p>");
    expect(out.startsWith("Biz yerel işletmelere")).toBe(true);
  });

  it("skips chunks that start with a block-level tag", () => {
    const raw = "<h2>yerel seo</h2>\n\n<ul>\n<li>yerel seo</li>\n</ul>\n\n<div>yerel seo</div>\n\n<!-- more -->\n\nSon yerel seo burada.";
    const out = rawOf(run(raw, "yerel seo"));
    expect(out.match(/<a /g)).toHaveLength(1);
    expect(out).toContain(`Son <a href="${TARGET}">yerel seo</a> burada.`);
  });

  it("does not write inside a pre block that contains blank lines", () => {
    const raw = "<pre>\nkod\n\nyerel seo\n</pre>\n\nGerçek yerel seo metni.";
    const out = rawOf(run(raw, "yerel seo"));
    expect(out).toContain("<pre>\nkod\n\nyerel seo\n</pre>");
    expect(out).toContain(`Gerçek <a href="${TARGET}">yerel seo</a> metni.`);
  });

  it("skips shortcode chunks", () => {
    const raw = '[caption id="x"]yerel seo[/caption]\n\nYine yerel seo.';
    const out = rawOf(run(raw, "yerel seo"));
    expect(out).toContain('[caption id="x"]yerel seo[/caption]');
    expect(out).toContain(`Yine <a href="${TARGET}">yerel seo</a>.`);
  });

  it("handles CRLF separators", () => {
    const out = rawOf(run("Birinci\r\n\r\nİkinci yerel seo satırı", "yerel seo"));
    expect(out).toContain(`İkinci <a href="${TARGET}">yerel seo</a> satırı`);
  });
});
