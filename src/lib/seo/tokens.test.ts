import { describe, expect, it } from "vitest";

import { hasPhrase, meaningfulTokens } from "./tokens";

describe("meaningfulTokens", () => {
  it("drops stopwords and short tokens, keeps order, folds", () => {
    expect(meaningfulTokens("The best running shoes for women")).toEqual([
      "running",
      "shoes",
      "women",
    ]);
    expect(
      meaningfulTokens("İstanbul için en iyi kuaför nasıl seçilir"),
    ).toEqual(["istanbul", "iyi", "kuafor", "secilir"]);
    expect(meaningfulTokens("go to a UX bar")).toEqual(["bar"]);
  });

  it("keeps each token once", () => {
    expect(meaningfulTokens("shoes Shoes SHOES running")).toEqual([
      "shoes",
      "running",
    ]);
  });

  it("excludes brand tokens", () => {
    expect(
      meaningfulTokens("Acme Shop running shoes acmeshop", ["acme shop"]),
    ).toEqual(["running", "shoes"]);
    expect(meaningfulTokens("agentelse pricing", ["Agentelse"])).toEqual([
      "pricing",
    ]);
  });
});

describe("hasPhrase", () => {
  it("matches folded token sequences on word boundaries", () => {
    expect(hasPhrase(["dentist", "near", "me"], "near me")).toBe(true);
    expect(hasPhrase(["near", "dentist", "me"], "near me")).toBe(false);
    expect(hasPhrase(["nearme"], "near me")).toBe(false);
    expect(hasPhrase([], "near")).toBe(false);
  });
});
