import { describe, expect, it } from "vitest";

import sample from "./__fixtures__/brand-sample.json";
import {
  brandClassifierAccuracy,
  damerauLevenshtein,
  isFuzzyBrandQuery,
} from "./brand-fuzzy";

// Bu dosyanın kanıtladığı: OSA uzaklığı (takas = 1) ve erken çıkış; kısa
// terim yalnız birebir; bitişik sözcükler birleşerek eşleşir; elle
// etiketlenmiş örneklemde doğruluk ≥ %90.

describe("damerauLevenshtein", () => {
  it("counts edits with a transposition as one", () => {
    expect(damerauLevenshtein("agentelse", "agentelse", 2)).toBe(0);
    expect(damerauLevenshtein("agnetelse", "agentelse", 2)).toBe(1);
    expect(damerauLevenshtein("agentels", "agentelse", 2)).toBe(1);
    expect(damerauLevenshtein("agentelce", "agentelse", 2)).toBe(1);
    expect(damerauLevenshtein("ca", "abc", 5)).toBe(3);
    expect(damerauLevenshtein("", "abc", 5)).toBe(3);
    expect(damerauLevenshtein("kitten", "sitting", 5)).toBe(3);
  });

  it("exits early past the limit", () => {
    expect(damerauLevenshtein("kitten", "sitting", 1)).toBe(2);
    expect(damerauLevenshtein("a", "abcdef", 2)).toBe(3);
    expect(damerauLevenshtein("abcdef", "uvwxyz", 2)).toBe(3);
  });
});

describe("isFuzzyBrandQuery", () => {
  it("keeps W1's exact match", () => {
    expect(isFuzzyBrandQuery("agentelse login", ["agentelse"])).toBe(true);
    expect(isFuzzyBrandQuery("anything", [])).toBe(false);
  });

  it("allows one edit for 5-8 letters and two for 9+", () => {
    expect(isFuzzyBrandQuery("nikee shoes", ["nikey"])).toBe(true);
    expect(isFuzzyBrandQuery("nkiey shoes", ["nikey"])).toBe(true);
    expect(isFuzzyBrandQuery("naiky shoes", ["nikey"])).toBe(false);
    expect(isFuzzyBrandQuery("agnetlese", ["agentelse"])).toBe(true);
    expect(isFuzzyBrandQuery("agntlse", ["agentelse"])).toBe(true);
    expect(isFuzzyBrandQuery("agtlse", ["agentelse"])).toBe(false);
  });

  it("matches short terms exactly only", () => {
    expect(isFuzzyBrandQuery("acme tools", ["acme"])).toBe(true);
    expect(isFuzzyBrandQuery("acne tools", ["acme"])).toBe(false);
    expect(isFuzzyBrandQuery("ibm cloud", ["ibm"])).toBe(true);
    expect(isFuzzyBrandQuery("ibn cloud", ["ibm"])).toBe(false);
  });

  it("joins adjacent tokens", () => {
    expect(isFuzzyBrandQuery("agent elss pricing", ["agentelse"])).toBe(true);
    expect(isFuzzyBrandQuery("web helth", ["webhealth"])).toBe(true);
    expect(isFuzzyBrandQuery("helth web", ["webhealth"])).toBe(false);
  });

  it("reaches 90% on the hand-labelled sample", () => {
    expect(sample.length).toBeGreaterThanOrEqual(50);
    expect(
      brandClassifierAccuracy(sample, ["agentelse"]),
    ).toBeGreaterThanOrEqual(0.9);
    expect(brandClassifierAccuracy([], ["agentelse"])).toBe(0);
  });
});
