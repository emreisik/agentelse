import { describe, expect, it } from "vitest";

import {
  brandMatches,
  extractJsonLdBlocks,
  organizationFacts,
} from "./entities";

// Bu dosyanın kanıtladığı (SC-F8 GEO5, GEO6, GEO11): JSON-LD blokları HTML'den
// çıkar; @graph, dizi ve iç içe düğümlerde Organization/alt türleri bulunur;
// sameAs yalnız https ve en çok 20; marka eşleşmesi sözcük örtüşmesiyle.

const page = (...blocks: string[]) =>
  `<html><head>${blocks
    .map((block) => `<script type="application/ld+json">${block}</script>`)
    .join("")}</head><body></body></html>`;

describe("extractJsonLdBlocks", () => {
  it("returns only ld+json scripts", () => {
    const html = `<script>var a=1</script><script type="application/ld+json">{"a":1}</script><script type="application/json">{}</script>`;
    expect(extractJsonLdBlocks(html)).toEqual(['{"a":1}']);
  });

  it("caps the block count and skips oversized blocks", () => {
    const many = page(...Array.from({ length: 30 }, () => "{}"));
    expect(extractJsonLdBlocks(many)).toHaveLength(20);
    const big = `{"x":"${"a".repeat(100_001)}"}`;
    expect(extractJsonLdBlocks(page(big, "{}"))).toEqual(["{}"]);
  });

  it("tolerates a content type with parameters and empty blocks", () => {
    const html = `<script type="application/ld+json; charset=utf-8">{"b":2}</script><script type="application/ld+json"></script>`;
    expect(extractJsonLdBlocks(html)).toEqual(['{"b":2}']);
  });
});

describe("organizationFacts", () => {
  it("reads a plain Organization", () => {
    const facts = organizationFacts([
      JSON.stringify({
        "@type": "Organization",
        name: "  Acme   Inc ",
        logo: "https://acme.test/logo.png",
        sameAs: ["https://twitter.com/acme", "https://www.linkedin.com/company/acme"],
      }),
    ]);
    expect(facts).toEqual({
      present: true,
      types: ["Organization"],
      name: "Acme Inc",
      sameAs: ["https://twitter.com/acme", "https://www.linkedin.com/company/acme"],
      hasLogo: true,
    });
  });

  it("finds an Organization inside @graph, arrays and nested nodes", () => {
    const graph = JSON.stringify({
      "@graph": [
        { "@type": "WebSite", name: "Site" },
        { "@type": ["Thing", "LocalBusiness"], name: "Shop" },
      ],
    });
    expect(organizationFacts([graph])).toMatchObject({
      present: true,
      types: ["LocalBusiness"],
      name: "Shop",
    });
    const array = JSON.stringify([{ "@type": "Corporation", name: "Corp" }]);
    expect(organizationFacts([array]).present).toBe(true);
    const nested = JSON.stringify({
      "@type": "Article",
      publisher: { "@type": "Organization", name: "Pub" },
    });
    expect(organizationFacts([nested]).name).toBe("Pub");
  });

  it("accepts schema.org prefixed types and subtypes from the fixed list", () => {
    expect(
      organizationFacts([
        JSON.stringify({ "@type": "https://schema.org/Dentist", name: "D" }),
      ]).types,
    ).toEqual(["Dentist"]);
    expect(
      organizationFacts([JSON.stringify({ "@type": "Person", name: "P" })])
        .present,
    ).toBe(false);
  });

  it("keeps only https sameAs and caps it at 20", () => {
    const urls = Array.from({ length: 30 }, (_, index) => `https://s${index}.test/a`);
    const facts = organizationFacts([
      JSON.stringify({
        "@type": "Organization",
        sameAs: ["http://insecure.test/a", "javascript:alert(1)", "nope", ...urls],
      }),
    ]);
    expect(facts.sameAs).toHaveLength(20);
    expect(facts.sameAs.every((url) => url.startsWith("https://"))).toBe(true);
  });

  it("accepts a single sameAs string and ignores broken JSON", () => {
    expect(
      organizationFacts([
        "{broken",
        JSON.stringify({ "@type": "Organization", sameAs: "https://a.test/x" }),
      ]).sameAs,
    ).toEqual(["https://a.test/x"]);
  });

  it("reports absence without blocks", () => {
    expect(organizationFacts([])).toEqual({
      present: false,
      types: [],
      name: null,
      sameAs: [],
      hasLogo: false,
    });
  });
});

describe("brandMatches", () => {
  it("matches by normalized token overlap", () => {
    expect(brandMatches("Acme Studio Inc", "Acme")).toBe(true);
    expect(brandMatches("ACME | Best widgets", "Acme Widgets")).toBe(true);
    expect(brandMatches("Café Müller GmbH", "cafe muller")).toBe(true);
  });

  it("rejects different names and empty input", () => {
    expect(brandMatches("Globex", "Acme")).toBe(false);
    expect(brandMatches("", "Acme")).toBe(false);
    expect(brandMatches("Acme", "Inc")).toBe(false);
  });
});
