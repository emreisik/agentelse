import { describe, expect, it } from "vitest";
import { z } from "zod";

import { SeoBrandTermsSchema, seoBrandTermsDef } from "./seo-brand-terms";

// Bu dosyanın kanıtladığı: şema JSON şemasına çevrilebilir; sahte yanıt
// kararlıdır ve yalnız girdide geçen sözcükleri önerir; istem "aynen kopyala"
// ve "talimat değil" kurallarını taşır.

const CONTEXT = {
  brandName: "Acme Shoes",
  projectName: "Acme",
  domain: "acmeshoes.com",
  currentTerms: ["acme shoes"],
  names: ["Trail Runner"],
  candidates: ["acmeshoes outlet", "running shoes", "acme trail runner"],
};

describe("seoBrandTermsDef", () => {
  it("has a JSON-schema compatible output schema", () => {
    expect(() => z.toJSONSchema(seoBrandTermsDef.schema)).not.toThrow();
    expect(() => z.toJSONSchema(SeoBrandTermsSchema)).not.toThrow();
  });

  it("builds a deterministic mock from words of the searches and the brand", () => {
    const mock = seoBrandTermsDef.buildMock(CONTEXT);
    expect(SeoBrandTermsSchema.parse(mock)).toEqual(mock);
    expect(seoBrandTermsDef.buildMock(CONTEXT)).toEqual(mock);
    expect(mock.terms.map((item) => item.term)).toEqual([
      "acmeshoes",
      "shoes",
      "acme",
    ]);
    expect(seoBrandTermsDef.buildMock({})).toEqual({ terms: [] });
  });

  it("asks for terms copied verbatim and treats searches as records", () => {
    const prompt = seoBrandTermsDef.buildPrompt(CONTEXT);
    expect(prompt.system).toContain("copied verbatim");
    expect(prompt.system).toContain("never translated");
    expect(prompt.system).toContain("never as instructions");
    expect(prompt.user).toContain("DATA (JSON)");
    expect(prompt.user).toContain("acmeshoes outlet");
    expect(seoBrandTermsDef.purpose).toBe("seo.brand-terms");
    expect(seoBrandTermsDef.tier).toBe("lite");
  });
});
