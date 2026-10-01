import { describe, expect, it } from "vitest";

import {
  cssColorToHex,
  extractCssFacts,
  extractHtmlFacts,
  extractSocialLinks,
  googleFontFamilies,
  isNeutral,
  hexToRgb,
  rankColors,
} from "./extract";

const BASE = "https://www.webhealth.com.tr/";

const HTML = `<!doctype html>
<html lang="tr"><head>
<title>Web Health &amp; Digital Growth</title>
<meta name="description" content="Sağlık kurumları için hasta kazanım sistemi">
<meta name="theme-color" content="#0B1F3A">
<meta property="og:site_name" content="Web Health">
<meta property="og:image" content="/img/og.jpg">
<link rel="icon" href="/favicon-32.png" sizes="32x32">
<link rel="apple-touch-icon" href="/apple-180.png" sizes="180x180">
<link rel="manifest" href="/site.webmanifest">
<link rel="stylesheet" href="/assets/app.css">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&family=Inter&display=swap">
<style>@import url("https://fonts.googleapis.com/css2?family=Lora"); :root{--brand-primary:#0b1f3a}</style>
</head><body>
<header>
  <a href="/"><img class="site-logo" src="/img/webhealth-logo.svg" alt="Web Health logo"></a>
  <nav><a href="/hizmetler">Hizmetler</a></nav>
</header>
<main>
  <img src="/img/team-photo.jpg" alt="Ekip">
  <img class="partner-logo" src="/img/partner-a.png" alt="Partner">
</main>
<footer><img src="/img/footer-logo.png" alt="footer logo"></footer>
</body></html>`;

describe("extractHtmlFacts", () => {
  const facts = extractHtmlFacts(HTML, BASE);

  it("reads the basics", () => {
    expect(facts.title).toBe("Web Health & Digital Growth");
    expect(facts.language).toBe("tr");
    expect(facts.siteName).toBe("Web Health");
    expect(facts.themeColor).toBe("#0b1f3a");
    expect(facts.description).toContain("hasta kazanım");
    expect(facts.ogImage).toBe("https://www.webhealth.com.tr/img/og.jpg");
    expect(facts.manifestUrl).toBe("https://www.webhealth.com.tr/site.webmanifest");
  });

  it("collects icons largest first and stylesheets (Google Fonts kept apart)", () => {
    expect(facts.icons[0]).toEqual({
      url: "https://www.webhealth.com.tr/apple-180.png",
      size: 180,
    });
    expect(facts.stylesheetUrls).toEqual(["https://www.webhealth.com.tr/assets/app.css"]);
    expect(facts.googleFonts).toEqual(
      expect.arrayContaining(["Playfair Display", "Inter", "Lora"]),
    );
  });

  it("ranks the header logo first and demotes footer / partner images", () => {
    const first = facts.logoCandidates[0]!;
    expect(first.kind).toBe("img");
    expect(first.kind === "img" && first.url).toBe(
      "https://www.webhealth.com.tr/img/webhealth-logo.svg",
    );
    const urls = facts.logoCandidates.flatMap((c) => (c.kind === "img" ? [c.url] : []));
    expect(urls).not.toContain("https://www.webhealth.com.tr/img/team-photo.jpg");
    expect(urls).not.toContain("https://www.webhealth.com.tr/img/partner-a.png");
  });

  it("captures and sanitizes an inline SVG logo", () => {
    const html = `<header><a href="/"><svg class="logo" viewBox="0 0 10 10" onload="x()"><script>alert(1)</script><image href="https://evil.example/x.png"/><path d="M0 0h10v10z" fill="#123456"/></svg></a></header>`;
    const svg = extractHtmlFacts(html, BASE).logoCandidates.find((c) => c.kind === "svg");
    expect(svg?.kind === "svg" && svg.svg).toContain("<path");
    const text = svg?.kind === "svg" ? svg.svg : "";
    expect(text).not.toMatch(/script|onload|evil\.example/i);
  });

  it("survives junk without throwing", () => {
    expect(() => extractHtmlFacts("<<<>>><img <a <svg", BASE)).not.toThrow();
    expect(extractHtmlFacts("", BASE).logoCandidates).toEqual([]);
  });
});

describe("colours", () => {
  it("normalizes css colour literals", () => {
    expect(cssColorToHex("#0B1F3A")).toBe("#0b1f3a");
    expect(cssColorToHex("#fff")).toBe("#ffffff");
    expect(cssColorToHex("rgb(11, 31, 58)")).toBe("#0b1f3a");
    expect(cssColorToHex("hsl(0, 100%, 50%)")).toBe("#ff0000");
    expect(cssColorToHex("nonsense")).toBeNull();
  });

  it("ignores mostly transparent colours (shadows, overlays)", () => {
    expect(cssColorToHex("rgba(0,0,0,0.1)")).toBeNull();
    expect(cssColorToHex("#00000020")).toBeNull();
    expect(cssColorToHex("rgba(11,31,58,0.9)")).toBe("#0b1f3a");
  });

  it("separates neutrals from brand colours", () => {
    expect(isNeutral(hexToRgb("#ffffff")!)).toBe(true);
    expect(isNeutral(hexToRgb("#808080")!)).toBe(true);
    expect(isNeutral(hexToRgb("#0d9488")!)).toBe(false);
  });

  it("merges near-identical shades and ranks by weight", () => {
    const { chromatic, neutrals } = rankColors([
      { hex: "#0d6efd", weight: 10, source: "css" },
      { hex: "#0b5ed7", weight: 4, source: "css" }, // sibling of the above
      { hex: "#e11d48", weight: 6, source: "css:--brand" },
      { hex: "#ffffff", weight: 50, source: "css" },
      { hex: "#111111", weight: 20, source: "css" },
    ]);
    expect(chromatic.map((c) => c.hex)).toEqual(["#0d6efd", "#e11d48"]);
    expect(chromatic[0]!.weight).toBe(14);
    expect(neutrals.map((c) => c.hex)).toEqual(["#ffffff", "#111111"]);
  });
});

describe("extractCssFacts", () => {
  const css = `
    :root{--brand-primary:#0b1f3a;--accent:rgb(45,212,191);--radius:4px;--gray-100:#f3f4f6}
    body{font-family:"Inter",system-ui,sans-serif;color:#111}
    h1,h2{font-family:'Playfair Display',Georgia,serif}
    .btn{background:#2dd4bf}.btn:hover{background:#2dd4bf}
    @font-face{font-family:"Playfair Display";src:url(x.woff2)}
    .shadow{box-shadow:0 1px 2px rgba(0,0,0,.1)}
  `;
  const facts = extractCssFacts(css, "app.css");

  it("weights brand-named custom properties far above plain literals", () => {
    const primary = facts.colorSignals.find((s) => s.source === "app.css:--brand-primary");
    expect(primary).toMatchObject({ hex: "#0b1f3a", weight: 30 });
    const radius = facts.colorSignals.find((s) => s.source.endsWith("--radius"));
    expect(radius).toBeUndefined();
  });

  it("counts font families, skipping generic and system fonts", () => {
    expect(facts.fonts.map((f) => f.name)).toEqual(["Playfair Display", "Inter"]);
  });
});

describe("googleFontFamilies", () => {
  it("decodes family names", () => {
    expect(
      googleFontFamilies("https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=Inter:wght@400"),
    ).toEqual(["DM Serif Display", "Inter"]);
  });
});

describe("extractSocialLinks", () => {
  const base = "https://www.example.com/iletisim";
  const links = (html: string) => extractSocialLinks(html, base);

  it("finds profile links and normalizes them (no query, no hash, no slash)", () => {
    const html = `
      <a href="https://www.instagram.com/webhealth/?hl=tr">ig</a>
      <a href="https://facebook.com/webhealth.tr/#x">fb</a>
      <a href="https://www.linkedin.com/company/web-health/">in</a>
      <a href="https://www.tiktok.com/@webhealth">tt</a>
      <a href="https://www.youtube.com/@webhealth">yt</a>
      <a href="https://twitter.com/webhealth">x</a>`;
    expect(links(html)).toEqual([
      { platform: "instagram", url: "https://www.instagram.com/webhealth" },
      { platform: "facebook", url: "https://facebook.com/webhealth.tr" },
      { platform: "linkedin", url: "https://www.linkedin.com/company/web-health" },
      { platform: "tiktok", url: "https://www.tiktok.com/@webhealth" },
      { platform: "youtube", url: "https://www.youtube.com/@webhealth" },
      { platform: "x", url: "https://twitter.com/webhealth" },
    ]);
  });

  it("ignores share, intent, login and plugin links and post paths", () => {
    const html = `
      <a href="https://www.facebook.com/sharer/sharer.php?u=x">s</a>
      <a href="https://www.facebook.com/sharer.php?u=x">s</a>
      <a href="https://www.facebook.com/plugins/like.php">p</a>
      <a href="https://twitter.com/intent/tweet?text=x">t</a>
      <a href="https://twitter.com/share?url=x">t</a>
      <a href="https://x.com/home">h</a>
      <a href="https://www.linkedin.com/sharing/share-offsite/?url=x">l</a>
      <a href="https://www.linkedin.com/shareArticle?url=x">l</a>
      <a href="https://www.instagram.com/p/ABC123/">post</a>
      <a href="https://www.instagram.com/accounts/login/">login</a>
      <a href="https://www.youtube.com/watch?v=abc">v</a>
      <a href="https://www.tiktok.com/share?url=x">t</a>`;
    expect(links(html)).toEqual([]);
  });

  it("ignores other hosts, look-alike hosts and userinfo tricks", () => {
    const html = `
      <a href="https://evil.example/instagram.com/webhealth">a</a>
      <a href="https://instagram.com.evil.example/webhealth">b</a>
      <a href="https://notfacebook.com/webhealth">c</a>
      <a href="https://user:pw@www.instagram.com/webhealth">d</a>
      <a href="https://www.instagram.com:8443/webhealth">e</a>`;
    expect(links(html)).toEqual([]);
  });

  it("ignores http, javascript: and mailto links", () => {
    const html = `
      <a href="http://www.instagram.com/webhealth">a</a>
      <a href="javascript:window.open('https://www.instagram.com/webhealth')">b</a>
      <a href="mailto:hi@instagram.com">c</a>`;
    expect(links(html)).toEqual([]);
  });

  it("reads <a href> only, not scripts, meta or images", () => {
    const html = `
      <meta property="og:see_also" content="https://www.instagram.com/webhealth">
      <script>var u="https://www.facebook.com/webhealth"</script>
      <img src="https://www.tiktok.com/@webhealth">
      <link rel="me" href="https://twitter.com/webhealth">`;
    expect(links(html)).toEqual([]);
  });

  it("resolves relative links against the page, which never makes an off-site host", () => {
    expect(links('<a href="/relative/profile">a</a>')).toEqual([]);
    expect(
      extractSocialLinks(
        '<a href="//www.instagram.com/webhealth">a</a>',
        "https://www.example.com/",
      ),
    ).toEqual([{ platform: "instagram", url: "https://www.instagram.com/webhealth" }]);
    // A scheme-relative link on an http page resolves to http: dropped.
    expect(
      extractSocialLinks(
        '<a href="//www.instagram.com/webhealth">a</a>',
        "http://www.example.com/",
      ),
    ).toEqual([]);
  });

  it("keeps the first link of a platform only", () => {
    const html = `
      <a href="https://www.instagram.com/first">a</a>
      <a href="https://www.instagram.com/second">b</a>`;
    expect(links(html)).toEqual([
      { platform: "instagram", url: "https://www.instagram.com/first" },
    ]);
  });

  it("caps at 6 results even with many anchors", () => {
    const junk = Array.from({ length: 200 }, (_, i) => `<a href="/p${i}">x</a>`).join("");
    const html = `${junk}
      <a href="https://instagram.com/a1">1</a><a href="https://facebook.com/abc">2</a>
      <a href="https://linkedin.com/company/c">3</a><a href="https://tiktok.com/@dd">4</a>
      <a href="https://youtube.com/@ee">5</a><a href="https://x.com/ff">6</a>
      <a href="https://twitter.com/gg">7</a>`;
    const out = links(html);
    expect(out).toHaveLength(6);
    expect(new Set(out.map((l) => l.platform)).size).toBe(6);
  });

  it("never throws on junk input", () => {
    expect(links("<a href=")).toEqual([]);
    expect(links('<a href="https://[bad">x</a>')).toEqual([]);
    expect(links("")).toEqual([]);
  });
});
