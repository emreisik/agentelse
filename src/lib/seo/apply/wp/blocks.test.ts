import { describe, expect, it } from "vitest";

import { markdownToBlocks } from "./blocks";

// Bu dosyanın kanıtladığı: Gutenberg çıktısı altın metinle eşleşir, ilk H1 (başlıkla
// aynıysa) düşer, güvenli olmayan bağlantılar düz metin olur, metin kaçışlanır ve
// çıktı bayt düzeyinde kararlıdır.

const SAMPLE = [
  "# Yerel SEO rehberi",
  "",
  "Giriş **kalın** ve *italik* ve `kod` ile [bağlantı](https://example.com/a?x=1&y=2).",
  "",
  "## Alt başlık",
  "",
  "- Bir",
  "- İki",
  "",
  "1. Birinci",
  "2. İkinci",
  "",
  "> Alıntı metni",
  "",
  "### Daha alt",
].join("\n");

describe("markdownToBlocks", () => {
  it("serializes headings, paragraphs, lists and quotes", () => {
    const { content, words, headings } = markdownToBlocks(SAMPLE, {
      title: "Yerel SEO rehberi",
    });
    expect(content).toBe(
      [
        '<!-- wp:paragraph -->\n<p>Giriş <strong>kalın</strong> ve <em>italik</em> ve <code>kod</code> ile <a href="https://example.com/a?x=1&amp;y=2">bağlantı</a>.</p>\n<!-- /wp:paragraph -->',
        '<!-- wp:heading -->\n<h2 class="wp-block-heading">Alt başlık</h2>\n<!-- /wp:heading -->',
        '<!-- wp:list -->\n<ul class="wp-block-list"><!-- wp:list-item -->\n<li>Bir</li>\n<!-- /wp:list-item -->\n<!-- wp:list-item -->\n<li>İki</li>\n<!-- /wp:list-item --></ul>\n<!-- /wp:list -->',
        '<!-- wp:list {"ordered":true} -->\n<ol class="wp-block-list"><!-- wp:list-item -->\n<li>Birinci</li>\n<!-- /wp:list-item -->\n<!-- wp:list-item -->\n<li>İkinci</li>\n<!-- /wp:list-item --></ol>\n<!-- /wp:list -->',
        '<!-- wp:quote -->\n<blockquote class="wp-block-quote"><!-- wp:paragraph -->\n<p>Alıntı metni</p>\n<!-- /wp:paragraph --></blockquote>\n<!-- /wp:quote -->',
        '<!-- wp:heading {"level":3} -->\n<h3 class="wp-block-heading">Daha alt</h3>\n<!-- /wp:heading -->',
      ].join("\n\n"),
    );
    expect(headings).toBe(2);
    expect(words).toBeGreaterThan(10);
  });

  it("drops the first H1 when it equals the title, ignoring case and spacing", () => {
    const { content } = markdownToBlocks("#  yerel  seo REHBERI \n\nMetin", {
      title: "Yerel SEO rehberi",
    });
    expect(content).not.toContain("<h1");
    expect(content).not.toContain("Yerel");
    expect(content).toContain("<p>Metin</p>");
  });

  it("turns an H1 that differs from the title into H2", () => {
    const { content, headings } = markdownToBlocks("# Başka başlık\n\nMetin", {
      title: "Yerel SEO rehberi",
    });
    expect(content).toContain('<h2 class="wp-block-heading">Başka başlık</h2>');
    expect(headings).toBe(1);
  });

  it("only drops the first H1; later H1s become H2", () => {
    const { content } = markdownToBlocks("# Başlık\n\nA\n\n# Başlık\n\nB", {
      title: "Başlık",
    });
    expect(content.match(/<h2 /g)).toHaveLength(1);
    expect(content).not.toContain("<h1");
  });

  it("maps H5/H6 to H4", () => {
    const { content } = markdownToBlocks("##### Derin\n\n###### Daha derin", {
      title: "x",
    });
    expect(content.match(/<h4 /g)).toHaveLength(2);
    expect(content).toContain('wp:heading {"level":4}');
  });

  it("writes unsafe links as plain text", () => {
    const { content } = markdownToBlocks("Bak [tıkla](javascript:alert(1)) şimdi", {
      title: "x",
    });
    expect(content).not.toContain("<a ");
    expect(content).not.toContain("javascript");
    expect(content).toContain("tıkla");
  });

  it("escapes markup typed in the article", () => {
    const { content } = markdownToBlocks('Merhaba <script>alert("x")</script> & dünya', {
      title: "x",
    });
    expect(content).not.toContain("<script>");
    expect(content).toContain("&lt;script&gt;");
    expect(content).toContain("&amp;");
  });

  it("is byte-stable", () => {
    const a = markdownToBlocks(SAMPLE, { title: "Yerel SEO rehberi" });
    const b = markdownToBlocks(SAMPLE, { title: "Yerel SEO rehberi" });
    expect(a).toEqual(b);
  });

  it("returns empty content for an empty article", () => {
    expect(markdownToBlocks("", { title: "x" })).toEqual({
      content: "",
      words: 0,
      headings: 0,
    });
  });
});
