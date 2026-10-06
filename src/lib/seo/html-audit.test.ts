import { describe, expect, it } from "vitest";

import {
  decodeHtmlEntities,
  extractPageFacts,
  parseXRobotsTag,
  simhash64,
  simhashDistance,
  tokenizeHtml,
  visibleWords,
} from "./html-audit";

// Bu dosyanın kanıtladığı: elle yazılmış belirteçleyici bozuk HTML'de hata
// fırlatmaz ve doğrusal çalışır; sayfa olguları (başlık, meta robots,
// canonical, base href, hreflang, başlıklar, kelime sayısı, linkler, görseller,
// karma içerik, JSON-LD, doğrulama etiketi, render riski) doğru çıkarılır.

const PAGE = "https://www.x.com/blog/post";

function page(head: string, body: string): string {
  return `<!doctype html><html lang="en"><head>${head}</head><body>${body}</body></html>`;
}

describe("tokenizeHtml", () => {
  it("emits open/raw/close for raw-text elements and lowercases names", () => {
    const tokens = tokenizeHtml(
      `<SCRIPT type="x">if (a < b) { "</div>" }</SCRIPT ><P Class=Big>Hi &amp; bye</p>`,
    );
    expect(tokens).toEqual([
      {
        type: "open",
        name: "script",
        attrs: { type: "x" },
        selfClosing: false,
      },
      { type: "raw", name: "script", text: 'if (a < b) { "</div>" }' },
      { type: "close", name: "script" },
      { type: "open", name: "p", attrs: { class: "Big" }, selfClosing: false },
      { type: "text", text: "Hi & bye" },
      { type: "close", name: "p" },
    ]);
  });

  it("parses quoted, unquoted and boolean attributes; first one wins", () => {
    const [token] = tokenizeHtml(
      `<input type=checkbox checked value='a > b' data-x="1" data-x="2" />`,
    );
    expect(token).toEqual({
      type: "open",
      name: "input",
      attrs: { type: "checkbox", checked: "", value: "a > b", "data-x": "1" },
      selfClosing: true,
    });
  });

  it("skips comments, doctype and CDATA", () => {
    const tokens = tokenizeHtml(
      `<!DOCTYPE html><!-- <a href="/x"> --><![CDATA[ x ]]><?php ?>text`,
    );
    expect(tokens).toEqual([{ type: "text", text: "text" }]);
  });

  it("never throws on malformed HTML", () => {
    const inputs = [
      "<div><p>unclosed <b>bold",
      '<a href="/x>broken',
      "<a href=/x title=unquoted>ok</a>",
      "&#xZZ; &unknown; &#99999999; &lt",
      "<",
      "</",
      "<script>never closed",
      "a < b > c",
    ];
    for (const input of inputs) {
      expect(() => tokenizeHtml(input)).not.toThrow();
      expect(() => extractPageFacts(input, PAGE)).not.toThrow();
    }
    expect(tokenizeHtml("a < b > c")).toEqual([
      { type: "text", text: "a < b > c" },
    ]);
  });

  it("caps the number of tokens", () => {
    expect(
      tokenizeHtml("<b>x</b>".repeat(1000), { maxTokens: 50 }),
    ).toHaveLength(50);
  });

  it("is linear on 2 MB of '<' and on many unterminated close candidates", () => {
    let started = performance.now();
    tokenizeHtml("<".repeat(2_000_000));
    tokenizeHtml(`<script>${"</".repeat(500_000)}`);
    tokenizeHtml(`<a ${'b="'.repeat(300_000)}`);
    expect(performance.now() - started).toBeLessThan(3_000);
    started = performance.now();
    extractPageFacts("<<<<".repeat(500_000), PAGE);
    expect(performance.now() - started).toBeLessThan(3_000);
  });
});

describe("decodeHtmlEntities", () => {
  it("decodes named and numeric entities", () => {
    expect(
      decodeHtmlEntities(
        "&amp;&lt;&gt;&quot;&apos;&nbsp;&#65;&#x42;&#x1F680;&copy",
      ),
    ).toBe("&<>\"' AB🚀&copy");
    expect(decodeHtmlEntities("Tom &amp Jerry")).toBe("Tom & Jerry");
    expect(decodeHtmlEntities("&#0; &#xD800;")).toBe("� �");
  });
});

describe("extractPageFacts", () => {
  it("reads title, description and meta robots (robots, googlebot, none)", () => {
    const facts = extractPageFacts(
      page(
        `<title>  My   Page &amp; Co </title><title>Second</title><meta name="Description" content="About us"><meta name="description" content="dup"><meta name="googlebot" content="noindex">`,
        "<p>Hello</p>",
      ),
      PAGE,
    );
    expect(facts.title).toBe("My Page & Co");
    expect(facts.titleCount).toBe(2);
    expect(facts.metaDescription).toBe("About us");
    expect(facts.metaDescriptionCount).toBe(2);
    expect(facts.noindex).toBe(true);
    expect(facts.nofollow).toBe(false);
    expect(facts.robotsMeta).toBe("noindex");
    const none = extractPageFacts(
      page(`<meta name="robots" content="NONE">`, ""),
      PAGE,
    );
    expect(none.noindex).toBe(true);
    expect(none.nofollow).toBe(true);
    const other = extractPageFacts(
      page(`<meta name="bingbot" content="noindex">`, ""),
      PAGE,
    );
    expect(other.noindex).toBe(false);
    const own = extractPageFacts(
      page(`<meta name="AgentelseSiteAudit" content="nofollow">`, ""),
      PAGE,
    );
    expect(own.nofollow).toBe(true);
  });

  it("ignores an svg <title>", () => {
    const facts = extractPageFacts(
      page("", "<svg><title>Icon</title></svg>"),
      PAGE,
    );
    expect(facts.title).toBeNull();
    expect(facts.titleCount).toBe(0);
  });

  it("resolves canonical: absolute, relative and multiple", () => {
    const absolute = extractPageFacts(
      page(
        `<link rel="canonical" href="https://www.x.com/blog/post?utm_source=a">`,
        "",
      ),
      PAGE,
    );
    expect(absolute.canonical).toBe("https://www.x.com/blog/post?utm_source=a");
    expect(absolute.canonicalResolved).toBe("https://www.x.com/blog/post");
    expect(absolute.canonicalRelative).toBe(false);
    expect(absolute.canonicalCount).toBe(1);
    const relative = extractPageFacts(
      page(
        `<link rel=canonical href="../other"><link rel="CANONICAL" href="/x">`,
        "",
      ),
      PAGE,
    );
    expect(relative.canonicalRelative).toBe(true);
    expect(relative.canonicalResolved).toBe("https://www.x.com/other");
    expect(relative.canonicalCount).toBe(2);
  });

  it("uses <base href> for relative links", () => {
    const facts = extractPageFacts(
      page(
        `<base href="https://cdn.x.com/root/">`,
        `<a href="page">Go</a><a href="/abs">Abs</a>`,
      ),
      PAGE,
    );
    expect(facts.baseHref).toBe("https://cdn.x.com/root/");
    expect(facts.links.map((link) => link.href)).toEqual([
      "https://cdn.x.com/root/page",
      "https://cdn.x.com/abs",
    ]);
  });

  it("collects hreflang, lang, h1 and h2", () => {
    const facts = extractPageFacts(
      page(
        `<link rel="alternate" hreflang="tr-TR" href="/tr/post"><link rel="alternate" hreflang="x-default" href="https://www.x.com/">`,
        `<h1>Main <span>title</span></h1><h2>One</h2><h2>Two</h2>`,
      ),
      PAGE,
    );
    expect(facts.lang).toBe("en");
    expect(facts.hreflang).toEqual([
      { lang: "tr-TR", href: "https://www.x.com/tr/post" },
      { lang: "x-default", href: "https://www.x.com/" },
    ]);
    expect(facts.h1).toEqual(["Main title"]);
    expect(facts.h2).toEqual(["One", "Two"]);
  });

  it("counts visible words only", () => {
    const facts = extractPageFacts(
      `<html><head><title>Title words here</title><style>p{color:red}</style></head><body>` +
        `<script>var hidden = "a b c d";</script><noscript>no script text</noscript><template>tpl text</template>` +
        `<svg><text>svg text</text></svg>` +
        `<p>One two — three 4 Şirket</p><p>güzel</p></body></html>`,
      PAGE,
    );
    expect(facts.wordCount).toBe(6);
    expect(visibleWords("a — b ... 3")).toEqual(["a", "b", "3"]);
  });

  it("keeps inline elements inside one word", () => {
    expect(
      extractPageFacts(page("", "<p>foo<b>bar</b> baz</p>"), PAGE).wordCount,
    ).toBe(2);
  });

  it("collects links with nofollow/ugc and img alt anchors", () => {
    const facts = extractPageFacts(
      page(
        "",
        `<a href="/a#frag">Alpha</a>` +
          `<a href="https://other.com/" rel="UGC noopener">Ext</a>` +
          `<a href="/s" rel="sponsored">S</a>` +
          `<a href="/img"><img src="/i.png" alt="Logo alt"></a>` +
          `<a href="mailto:x@y.com">Mail</a><a href="javascript:void(0)">JS</a><a>No href</a>`,
      ),
      PAGE,
    );
    expect(facts.links).toEqual([
      { href: "https://www.x.com/a", anchor: "Alpha", nofollow: false },
      { href: "https://other.com/", anchor: "Ext", nofollow: true },
      { href: "https://www.x.com/s", anchor: "S", nofollow: true },
      { href: "https://www.x.com/img", anchor: "Logo alt", nofollow: false },
    ]);
  });

  it("counts images without alt (empty alt is fine)", () => {
    const facts = extractPageFacts(
      page(
        "",
        `<img src="a.png"><img src="b.png" alt=""><img src="c.png" alt="C">`,
      ),
      PAGE,
    );
    expect(facts.imagesTotal).toBe(3);
    expect(facts.imagesNoAlt).toBe(1);
  });

  it("reports mixed content only on https pages", () => {
    const html = page(
      `<link rel="stylesheet" href="http://cdn.x.com/a.css"><script src="http://cdn.x.com/a.js"></script>`,
      `<img src="http://img.x.com/a.png"><iframe src="https://ok.com/"></iframe><a href="http://x.com/">link</a>`,
    );
    expect(extractPageFacts(html, PAGE).mixedContent).toEqual([
      "http://cdn.x.com/a.css",
      "http://cdn.x.com/a.js",
      "http://img.x.com/a.png",
    ]);
    expect(extractPageFacts(html, "http://www.x.com/").mixedContent).toEqual(
      [],
    );
  });

  it("collects JSON-LD blocks (case-insensitive type, optional charset)", () => {
    const facts = extractPageFacts(
      page(
        `<script type="Application/LD+JSON; charset=utf-8">{"@context":"https://schema.org","@type":"Product"}</script>` +
          `<script type="application/ld+json">{broken</script>`,
        "",
      ),
      PAGE,
    );
    expect(facts.jsonLd.types).toEqual(["Product"]);
    expect(facts.jsonLd.errors).toEqual([
      "Product is missing name",
      "Structured data block 2 is not valid JSON",
    ]);
    expect(facts.scripts.inlineBytes).toBe(0);
  });

  it("reads verification meta, Open Graph and meta refresh", () => {
    const facts = extractPageFacts(
      page(
        `<meta name="agentelse-site-verification" content=" tok123 "><meta property="og:title" content="OG T"><meta property="og:image" content="https://x.com/i.png"><meta http-equiv="Refresh" content="0; url=/new">`,
        "",
      ),
      PAGE,
    );
    expect(facts.verificationTokens).toEqual(["tok123"]);
    expect(facts.openGraph).toEqual({
      title: "OG T",
      description: null,
      image: "https://x.com/i.png",
      type: null,
    });
    expect(facts.metaRefresh).toBe("0; url=/new");
  });

  it("flags render risk for an SPA shell", () => {
    const shell = extractPageFacts(
      page(
        `<script src="/main.js"></script>`,
        `<div id="root"></div><noscript>You need to enable JavaScript</noscript>`,
      ),
      PAGE,
    );
    expect(shell.renderRisk).toBe(true);
    const scripts = extractPageFacts(
      page(
        `<script src="/a.js"></script><script src="/b.js"></script><script src="/c.js"></script>`,
        "<p>short</p>",
      ),
      PAGE,
    );
    expect(scripts.scripts.external).toBe(3);
    expect(scripts.renderRisk).toBe(true);
    const ssr = extractPageFacts(
      page("", `<div id="__next"><p>${"word ".repeat(40)}</p></div>`),
      PAGE,
    );
    expect(ssr.renderRisk).toBe(false);
    const content = extractPageFacts(
      page(
        `<script src="/a.js"></script>`,
        `<div id="root"></div><p>${"word ".repeat(200)}</p>`,
      ),
      PAGE,
    );
    expect(content.renderRisk).toBe(false);
  });

  it("reports bytes and truncation", () => {
    const facts = extractPageFacts("ş", PAGE, { truncated: true });
    expect(facts.bytes).toBe(2);
    expect(facts.truncated).toBe(true);
    expect(extractPageFacts("x", PAGE).truncated).toBe(false);
  });

  it("text hash ignores case and whitespace but not words", () => {
    const a = extractPageFacts(page("", "<p>Hello   World</p>"), PAGE);
    const b = extractPageFacts(page("", "<div>hello world</div>"), PAGE);
    const c = extractPageFacts(page("", "<div>hello there</div>"), PAGE);
    expect(a.textHash).toBe(b.textHash);
    expect(a.textHash).not.toBe(c.textHash);
    expect(a.textHash).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("parseXRobotsTag", () => {
  it("applies unprefixed, googlebot and own-token directives only", () => {
    expect(parseXRobotsTag(["googlebot: noindex"])).toEqual({
      noindex: true,
      nofollow: false,
      raw: "googlebot: noindex",
    });
    expect(parseXRobotsTag(["otherbot: noindex"]).noindex).toBe(false);
    expect(parseXRobotsTag(["otherbot: noindex, nofollow"]).nofollow).toBe(
      false,
    );
    expect(parseXRobotsTag(["noindex, nofollow"])).toMatchObject({
      noindex: true,
      nofollow: true,
    });
    expect(parseXRobotsTag(["none"])).toMatchObject({
      noindex: true,
      nofollow: true,
    });
    expect(parseXRobotsTag(["AgentelseSiteAudit: nofollow"]).nofollow).toBe(
      true,
    );
    expect(parseXRobotsTag(["otherbot: noindex", "nofollow"])).toMatchObject({
      noindex: false,
      nofollow: true,
    });
    expect(
      parseXRobotsTag(["unavailable_after: 2026-01-01, noindex"]).noindex,
    ).toBe(true);
    expect(parseXRobotsTag(["max-snippet: 10"]).noindex).toBe(false);
    expect(parseXRobotsTag([])).toEqual({
      noindex: false,
      nofollow: false,
      raw: null,
    });
  });
});

describe("simhash", () => {
  const words =
    "the quick brown fox jumps over the lazy dog while the cat sleeps in the warm sun all day long".split(
      " ",
    );

  it("is stable and 16 hex characters", () => {
    expect(simhash64(words)).toBe(simhash64([...words]));
    expect(simhash64(words)).toMatch(/^[0-9a-f]{16}$/);
    expect(simhash64([])).toBe("0000000000000000");
  });

  it("near-identical texts are closer than different ones", () => {
    // Gerçekçi uzunlukta metin: 3.000 farklı kelime, biri değişiyor.
    const long = Array.from(
      { length: 3_000 },
      (_, index) => `${words[index % words.length]}${index}`,
    );
    const tweaked = [...long];
    tweaked[1_500] = "zebra";
    const other = Array.from({ length: 3_000 }, (_, index) => `other${index}`);
    const near = simhashDistance(simhash64(long), simhash64(tweaked));
    const far = simhashDistance(simhash64(long), simhash64(other));
    expect(near).toBeLessThanOrEqual(3);
    expect(far).toBeGreaterThan(near);
  });

  it("distance counts differing bits", () => {
    expect(simhashDistance("0000000000000000", "0000000000000000")).toBe(0);
    expect(simhashDistance("0000000000000000", "000000000000000f")).toBe(4);
    expect(simhashDistance("ffffffffffffffff", "0000000000000000")).toBe(64);
    expect(simhashDistance("bad", "0000000000000000")).toBe(64);
  });
});
