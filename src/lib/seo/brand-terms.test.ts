import { describe, expect, it } from "vitest";

import {
  BRAND_TERMS_MAX,
  EMPTY_BRAND_TERMS,
  autoBrandTerms,
  brandTermsHash,
  brandTermsOverflow,
  brandTermsRegex,
  effectiveBrandTerms,
  fitBrandTermsToRegex,
  isBrandQuery,
  parseBrandTermsConfig,
  parseBrandTermsInput,
} from "./brand-terms";

// Google'ın RE2'sinin yerine JS: "(?i)" atılır, bayraklar "iu".
function jsRegex(terms: string[]): RegExp {
  const regex = brandTermsRegex(terms);
  if (!regex) throw new Error("no regex");
  expect(regex.startsWith("(?i)")).toBe(true);
  return new RegExp(regex.slice(4), "iu");
}

describe("autoBrandTerms", () => {
  it("takes the brand and project names and the domain root", () => {
    expect(
      autoBrandTerms({
        brandName: "  WebHealth  Clinic ",
        projectName: "Webhealth",
        domain: "webhealth.com.tr",
        siteUrl: "sc-domain:webhealth.com.tr",
      }),
    ).toEqual(["webhealth clinic", "webhealth"]);
    expect(
      autoBrandTerms({
        brandName: null,
        projectName: null,
        domain: null,
        siteUrl: "sc-domain:blog.example.co.uk",
      }),
    ).toEqual(["example"]);
    expect(
      autoBrandTerms({
        brandName: null,
        projectName: null,
        domain: null,
        siteUrl: "https://www.acme-shop.com/",
      }),
    ).toEqual(["acme-shop"]);
  });

  it("drops generic and too short names", () => {
    expect(
      autoBrandTerms({
        brandName: "Default",
        projectName: "My  Project",
        domain: "ab.com",
        siteUrl: null,
      }),
    ).toEqual([]);
    expect(
      autoBrandTerms({
        brandName: "Untitled",
        projectName: "New project",
        domain: null,
        siteUrl: null,
      }),
    ).toEqual([]);
  });
});

describe("effectiveBrandTerms and parsing", () => {
  it("keeps auto terms except removed ones, then the user's", () => {
    expect(
      effectiveBrandTerms({
        v: 1,
        auto: ["acme", "acme shop"],
        user: ["Acme-Pro", "acme"],
        removed: ["ACME SHOP"],
        updatedAt: null,
      }),
    ).toEqual(["acme", "Acme-Pro"]);
    expect(effectiveBrandTerms(EMPTY_BRAND_TERMS)).toEqual([]);
  });

  it("parses stored config defensively", () => {
    expect(parseBrandTermsConfig(null)).toEqual(EMPTY_BRAND_TERMS);
    expect(parseBrandTermsConfig("x")).toEqual(EMPTY_BRAND_TERMS);
    expect(
      parseBrandTermsConfig({
        v: 1,
        auto: ["Acme", 3, ""],
        user: ["İstanbul Shop"],
        removed: [],
        updatedAt: "2026-10-06T00:00:00.000Z",
      }),
    ).toEqual({
      v: 1,
      auto: ["acme"],
      user: ["istanbul shop"],
      removed: [],
      updatedAt: "2026-10-06T00:00:00.000Z",
    });
  });

  it("splits form input on lines and commas, folds and dedupes", () => {
    expect(
      parseBrandTermsInput(
        "Acme, ACME\nacme-shop;Acme Shop\n\n x \n" + "a".repeat(61),
      ),
    ).toEqual(["acme", "acme-shop"]);
    const many = Array.from({ length: 30 }, (_, i) => `brand${i}`).join(",");
    expect(parseBrandTermsInput(many)).toHaveLength(BRAND_TERMS_MAX);
  });
});

const SAMPLES: { terms: string[]; query: string; brand: boolean }[] = [
  { terms: ["acme"], query: "acme pricing", brand: true },
  { terms: ["acme shop"], query: "acmeshop coupon", brand: true },
  { terms: ["acme shop"], query: "acme-shop coupon", brand: true },
  { terms: ["acme-shop"], query: "acme shop", brand: true },
  { terms: ["istanbul"], query: "İSTANBUL kebap", brand: true },
  { terms: ["istanbul"], query: "ıstanbul kebap", brand: true },
  { terms: ["cafe"], query: "café near me", brand: true },
  { terms: ["ai"], query: "paint shop", brand: false },
  { terms: ["ai"], query: "ai tools", brand: true },
  { terms: ["çay"], query: "çay bahçesi", brand: true },
  { terms: ["çay"], query: "çaylak", brand: false },
  { terms: ["çay"], query: "Bahçe ÇAY", brand: true },
  { terms: ["дом"], query: "дом мебель", brand: true },
  { terms: ["дом"], query: "домашний", brand: false },
  { terms: ["acme"], query: "best running shoes", brand: false },
];

describe("isBrandQuery", () => {
  it.each(SAMPLES)("$terms in '$query' → $brand", ({ terms, query, brand }) => {
    expect(isBrandQuery(query, terms)).toBe(brand);
  });

  it("is false without terms", () => {
    expect(isBrandQuery("acme", [])).toBe(false);
  });
});

describe("brandTermsRegex", () => {
  it.each(SAMPLES)(
    "matches like isBrandQuery: $terms in '$query'",
    ({ terms, query, brand }) => {
      expect(jsRegex(terms).test(query)).toBe(brand);
    },
  );

  it("has no ASCII word boundary, lookaround or backreference", () => {
    const regex = brandTermsRegex(["acme", "çay", "дом", "a.b"]) ?? "";
    expect(regex).not.toContain("\\b");
    expect(regex).not.toMatch(/\(\?[=!<]/);
    expect(regex).not.toMatch(/\\[1-9]/);
    expect(() => new RegExp(regex.slice(4), "iu")).not.toThrow();
  });

  it("escapes regex syntax in terms", () => {
    expect(jsRegex(["c++"]).test("c++ tutorial")).toBe(true);
    expect(jsRegex(["c++"]).test("ccc tutorial")).toBe(false);
  });

  it("is null without terms and stays under 4000 characters", () => {
    expect(brandTermsRegex([])).toBeNull();
    const long = Array.from(
      { length: 20 },
      (_, i) => `${"brandname".repeat(6)}${i}`,
    );
    const regex = brandTermsRegex(long) ?? "";
    expect(regex.length).toBeLessThanOrEqual(4000);
    expect(regex.length).toBeGreaterThan(0);
    // Sondan atılır: ilk terim kalır.
    expect(new RegExp(regex.slice(4), "iu").test(long[0]!)).toBe(true);
  });

  it("matches every accented letter that isBrandQuery folds", () => {
    for (const [term, query] of [
      ["costa", "coșta"],
      ["tara", "țara"],
      ["marta", "mărta"],
      ["yalo", "ýalo"],
      ["dvorak", "dvořák"],
      ["mesto", "městó"],
      ["kruh", "kůh kruh"],
      ["luka", "łuka luka"],
    ]) {
      expect(isBrandQuery(query!, [term!])).toBe(true);
      expect(jsRegex([term!]).test(query!)).toBe(true);
    }
    for (const query of ["coșta", "țara", "mărta", "ýalo", "dvořák"]) {
      const folded = query.normalize("NFD").replace(/\p{M}/gu, "");
      expect(jsRegex([folded]).test(query)).toBe(true);
    }
  });
});

describe("fitBrandTermsToRegex", () => {
  // Hiçbiri ötekinin alt dizesi değil ("…1" ile "…19" gibi değil).
  const long = Array.from(
    { length: 20 },
    (_, i) => `${"brandname".repeat(6)}${String.fromCharCode(97 + i)}`,
  );

  it("keeps the leading terms whose regex fits, in order", () => {
    const kept = fitBrandTermsToRegex(long);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(long.length);
    expect(kept).toEqual(long.slice(0, kept.length));
    expect(brandTermsRegex(kept)).toBe(brandTermsRegex(long));
    expect(fitBrandTermsToRegex(["acme", "widget"])).toEqual([
      "acme",
      "widget",
    ]);
  });

  it("makes classification, hash and regex use the same terms", () => {
    const config = { ...EMPTY_BRAND_TERMS, user: long };
    const effective = effectiveBrandTerms(config);
    expect(effective).toEqual(fitBrandTermsToRegex(long));
    expect(brandTermsOverflow(config)).toBe(long.length - effective.length);
    const dropped = long[long.length - 1]!;
    expect(isBrandQuery(dropped, effective)).toBe(false);
    expect(jsRegex(effective).test(dropped)).toBe(false);
    expect(
      brandTermsOverflow({ ...EMPTY_BRAND_TERMS, user: ["acme", "widget"] }),
    ).toBe(0);
  });
});

describe("brandTermsHash", () => {
  it("is stable regardless of order and case, 'none' when empty", () => {
    expect(brandTermsHash(["acme", "Acme Shop"])).toBe(
      brandTermsHash(["acme shop", "ACME"]),
    );
    expect(brandTermsHash(["acme"])).toMatch(/^[0-9a-f]{8}$/);
    expect(brandTermsHash(["acme"])).not.toBe(brandTermsHash(["acme", "pro"]));
    expect(brandTermsHash([])).toBe("none");
  });
});
