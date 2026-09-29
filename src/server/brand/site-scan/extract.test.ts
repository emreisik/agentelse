import { describe, expect, it } from "vitest";

import {
  cssColorToHex,
  extractCssFacts,
  extractHtmlFacts,
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
