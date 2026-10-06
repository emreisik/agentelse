import { describe, expect, it } from "vitest";

import { isGzipBytes, parseLastmod, parseSitemap } from "./sitemap-parser";

// Bu dosyanın kanıtladığı: urlset, sitemapindex ve düz metin sitemap'ler
// okunur; CDATA, varlıklar ve ad alanı önekleri tanınır; bozuk dosya hata
// fırlatmadan "invalid" döner; üst sınır aşılınca truncated işaretlenir.

describe("parseSitemap", () => {
  it("reads a urlset with lastmod", () => {
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<!-- generated -->
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://x.com/</loc><lastmod>2026-10-01</lastmod></url>
  <url>
    <loc> https://x.com/a </loc>
    <lastmod>2026-10-02T08:30:00+03:00</lastmod>
    <priority>0.5</priority>
  </url>
</urlset>`;
    const parsed = parseSitemap(body);
    expect(parsed.kind).toBe("urlset");
    expect(parsed.errors).toEqual([]);
    expect(parsed.truncated).toBe(false);
    expect(parsed.urls).toEqual([
      { loc: "https://x.com/", lastmod: "2026-10-01T00:00:00.000Z" },
      { loc: "https://x.com/a", lastmod: "2026-10-02T05:30:00.000Z" },
    ]);
  });

  it("reads a sitemapindex", () => {
    const parsed = parseSitemap(
      `<sitemapindex><sitemap><loc>https://x.com/s1.xml</loc></sitemap><sitemap><loc>https://x.com/s2.xml.gz</loc><lastmod>2026-09</lastmod></sitemap></sitemapindex>`,
    );
    expect(parsed.kind).toBe("sitemapindex");
    expect(parsed.urls).toEqual([]);
    expect(parsed.sitemaps).toEqual([
      { loc: "https://x.com/s1.xml", lastmod: null },
      { loc: "https://x.com/s2.xml.gz", lastmod: "2026-09-01T00:00:00.000Z" },
    ]);
  });

  it("decodes CDATA and entities", () => {
    const parsed = parseSitemap(
      `<urlset><url><loc><![CDATA[https://x.com/a?b=1&c=2]]></loc></url><url><loc>https://x.com/p?x=1&amp;y=&#50;&#x33;&apos;</loc></url></urlset>`,
    );
    expect(parsed.urls.map((url) => url.loc)).toEqual([
      "https://x.com/a?b=1&c=2",
      "https://x.com/p?x=1&y=23'",
    ]);
  });

  it("tolerates namespace prefixes", () => {
    const parsed = parseSitemap(
      `<sm:urlset xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9"><sm:url><sm:loc>https://x.com/n</sm:loc></sm:url></sm:urlset>`,
    );
    expect(parsed.kind).toBe("urlset");
    expect(parsed.urls).toEqual([{ loc: "https://x.com/n", lastmod: null }]);
  });

  it("reads a text sitemap", () => {
    const parsed = parseSitemap("https://x.com/a\r\n\r\nhttps://x.com/b\n");
    expect(parsed.kind).toBe("text");
    expect(parsed.urls.map((url) => url.loc)).toEqual([
      "https://x.com/a",
      "https://x.com/b",
    ]);
  });

  it("flags invalid bodies without throwing", () => {
    const html = parseSitemap("<html><body>Not found</body></html>");
    expect(html.kind).toBe("invalid");
    expect(html.errors[0]).toContain("expected <urlset>");
    const junk = parseSitemap("hello world\nnot urls");
    expect(junk.kind).toBe("invalid");
    expect(junk.errors).toHaveLength(1);
    expect(parseSitemap("").kind).toBe("invalid");
    expect(parseSitemap("<urlset").kind).toBe("invalid");
  });

  it("reports an unterminated root", () => {
    const parsed = parseSitemap(
      "<urlset><url><loc>https://x.com/a</loc></url>",
    );
    expect(parsed.kind).toBe("urlset");
    expect(parsed.urls).toHaveLength(1);
    expect(parsed.errors).toEqual(["The sitemap ends before </urlset>"]);
  });

  it("counts entries without <loc> once", () => {
    const one = parseSitemap(
      "<urlset><url><lastmod>2026-01-01</lastmod></url></urlset>",
    );
    expect(one.errors).toEqual(["An entry has no <loc>"]);
    const many = parseSitemap(
      "<urlset><url></url><url/><url><loc>https://x.com/</loc></url><url><loc></loc></url></urlset>",
    );
    expect(many.errors).toEqual(["3 entries have no <loc>"]);
    expect(many.urls).toHaveLength(1);
    const relative = parseSitemap(
      "<urlset><url><loc>/relative</loc></url></urlset>",
    );
    expect(relative.errors).toEqual(["An entry has an invalid <loc> URL"]);
  });

  it("caps at maxUrls and sets truncated", () => {
    const entries = Array.from(
      { length: 10 },
      (_, index) => `<url><loc>https://x.com/${index}</loc></url>`,
    ).join("");
    const parsed = parseSitemap(`<urlset>${entries}</urlset>`, { maxUrls: 3 });
    expect(parsed.urls).toHaveLength(3);
    expect(parsed.truncated).toBe(true);
    const text = parseSitemap(
      "https://x.com/a\nhttps://x.com/b\nhttps://x.com/c",
      { maxUrls: 2 },
    );
    expect(text.urls).toHaveLength(2);
    expect(text.truncated).toBe(true);
  });

  it("is linear on large input", () => {
    const entries = Array.from(
      { length: 50_000 },
      (_, index) => `<url><loc>https://x.com/p/${index}</loc></url>`,
    ).join("\n");
    const started = performance.now();
    const parsed = parseSitemap(`<urlset>${entries}</urlset>`);
    expect(parsed.urls).toHaveLength(50_000);
    expect(performance.now() - started).toBeLessThan(3_000);
  });
});

describe("parseLastmod", () => {
  it.each([
    ["2026-10-01", "2026-10-01T00:00:00.000Z"],
    ["2026-10", "2026-10-01T00:00:00.000Z"],
    ["2026-10-01T10:00Z", "2026-10-01T10:00:00.000Z"],
    ["2026-10-01T10:00:30.123-05:00", "2026-10-01T15:00:30.123Z"],
    ["2026-02-30", null],
    ["2026-13", null],
    ["2026-10-01T10:00:00", null],
    ["yesterday", null],
    ["", null],
  ] as const)("%s → %s", (input, expected) => {
    expect(parseLastmod(input)).toBe(expected);
  });
});

describe("isGzipBytes", () => {
  it("checks the magic bytes", () => {
    expect(isGzipBytes(new Uint8Array([0x1f, 0x8b, 0x08]))).toBe(true);
    expect(isGzipBytes(new Uint8Array([0x3c, 0x3f]))).toBe(false);
    expect(isGzipBytes(new Uint8Array([0x1f]))).toBe(false);
  });
});
