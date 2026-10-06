import { describe, expect, it } from "vitest";

import {
  buildRedirectMap,
  isUnrelatedRedirect,
  redirectMapText,
  textTokens,
  tokenSimilarity,
  type LostUrl,
} from "./redirect-map";

// Bu dosyanın kanıtladığı: kelimeler Türkçe/İngilizce dolgu kelimeleri ve
// aksanlar olmadan çıkarılır; ana sayfaya ve ilgisiz sayfaya yönlenme ayırt
// edilir; harita en yakın sayfayı seçer, eşik altında null bırakır; metin
// biçimi sunucuya yapıştırılabilir.

describe("textTokens", () => {
  it("drops English and Turkish stopwords and short tokens", () => {
    expect(textTokens("The best running shoes for you")).toEqual([
      "best",
      "running",
      "shoes",
    ]);
    expect(textTokens("Kampanya ve indirim için bir rehber")).toEqual([
      "kampanya",
      "indirim",
      "rehber",
    ]);
  });

  it("folds Unicode case and accents, splits on - _ /", () => {
    expect(textTokens("/blog/Şirket_Ürünleri-2026")).toEqual([
      "blog",
      "sirket",
      "urunleri",
      "2026",
    ]);
    expect(textTokens("KAMPANYA ŞARTLARI")).toEqual(
      textTokens("kampanya-sartlari"),
    );
    expect(textTokens("ISTANBUL İstanbul ıstanbul")).toEqual(["istanbul"]);
    expect(textTokens("Café")).toEqual(["cafe"]);
    expect(textTokens("a b c")).toEqual([]);
  });
});

describe("tokenSimilarity", () => {
  it("is Jaccard over sets", () => {
    expect(tokenSimilarity(["a", "b"], ["a", "b"])).toBe(1);
    expect(tokenSimilarity(["a", "b"], ["b", "c"])).toBeCloseTo(1 / 3);
    expect(tokenSimilarity([], [])).toBe(0);
    expect(tokenSimilarity(["a"], [])).toBe(0);
  });
});

describe("isUnrelatedRedirect", () => {
  it("flags a redirect to the homepage", () => {
    expect(
      isUnrelatedRedirect({
        fromUrl: "https://x.com/old-product",
        fromTitle: null,
        toUrl: "https://x.com/",
        toTitle: "Home",
      }),
    ).toBe("TO_HOMEPAGE");
    expect(
      isUnrelatedRedirect({
        fromUrl: "http://x.com/",
        fromTitle: null,
        toUrl: "https://x.com/",
        toTitle: null,
      }),
    ).toBeNull();
  });

  it("flags a redirect to an unrelated page", () => {
    expect(
      isUnrelatedRedirect({
        fromUrl: "https://x.com/blog/running-shoes-guide",
        fromTitle: "Running shoes guide",
        toUrl: "https://x.com/contact",
        toTitle: "Contact us",
      }),
    ).toBe("TO_UNRELATED");
    expect(
      isUnrelatedRedirect({
        fromUrl: "https://x.com/blog/running-shoes-guide",
        fromTitle: "Running shoes guide",
        toUrl: "https://x.com/guides/running-shoes",
        toTitle: "The running shoes guide",
      }),
    ).toBeNull();
  });
});

describe("buildRedirectMap", () => {
  const lost: LostUrl[] = [
    {
      url: "https://x.com/old/blue-widgets",
      title: "Blue widgets",
      clicks: 10,
      reason: "NOT_FOUND",
    },
    {
      url: "https://x.com/old/red-gadgets",
      title: "Red gadgets",
      clicks: 50,
      reason: "GONE",
    },
    {
      url: "https://x.com/old/zzz",
      title: null,
      clicks: 5,
      reason: "NOT_FOUND",
    },
  ];
  const targets = [
    {
      url: "https://x.com/shop/widgets/blue",
      title: "Blue widgets",
      h1: "Blue widgets",
    },
    { url: "https://x.com/shop/gadgets/red", title: "Red gadgets", h1: null },
    { url: "https://x.com/about", title: "About us", h1: "About" },
  ];

  it("picks the closest page, orders by clicks and leaves null under minScore", () => {
    const map = buildRedirectMap(lost, targets);
    expect(map.map((row) => [row.from, row.to])).toEqual([
      ["https://x.com/old/red-gadgets", "https://x.com/shop/gadgets/red"],
      ["https://x.com/old/blue-widgets", "https://x.com/shop/widgets/blue"],
      ["https://x.com/old/zzz", null],
    ]);
    expect(map[0]?.score).toBeGreaterThanOrEqual(0.3);
    expect(map[2]?.score).toBeLessThan(0.3);
  });

  it("reuses targets and honours a custom minScore", () => {
    const twins: LostUrl[] = [
      {
        url: "https://x.com/a/blue-widgets",
        title: "Blue widgets",
        clicks: 2,
        reason: "NOT_FOUND",
      },
      {
        url: "https://x.com/b/blue-widgets",
        title: "Blue widgets",
        clicks: 1,
        reason: "NOT_FOUND",
      },
    ];
    const map = buildRedirectMap(twins, targets);
    expect(
      map.every((row) => row.to === "https://x.com/shop/widgets/blue"),
    ).toBe(true);
    expect(
      buildRedirectMap(twins, targets, { minScore: 0.99 }).every(
        (row) => row.to === null,
      ),
    ).toBe(true);
    expect(buildRedirectMap(twins, [])).toEqual([
      { from: "https://x.com/a/blue-widgets", to: null, score: 0 },
      { from: "https://x.com/b/blue-widgets", to: null, score: 0 },
    ]);
  });
});

describe("redirectMapText", () => {
  it("writes '<old path> <new url>' lines and comments for no match", () => {
    expect(
      redirectMapText([
        { from: "https://x.com/old/a?x=1", to: "https://x.com/new/a" },
        { from: "https://x.com/old/b", to: null },
      ]),
    ).toBe("/old/a?x=1 https://x.com/new/a\n# /old/b: no close match");
  });
});
