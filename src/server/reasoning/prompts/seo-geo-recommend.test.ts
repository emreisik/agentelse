import { describe, expect, it } from "vitest";
import { z } from "zod";

import { SeoGeoRecommendSchema, seoGeoRecommendDef } from "./seo-geo-recommend";

// Bu dosyanın kanıtladığı (SC-F8): şema JSON şemasına çevrilir; sahte yanıt
// şemadan geçer, kararlıdır ve rakam taşımaz; istem veri bloğunu ve sözü tutan
// korkulukları (sayı uydurma, alıntı vaadi yok, kullanıcı değiştirir) taşır.

const CONTEXT = {
  checks: [
    {
      id: "GEO2",
      title: "AI search crawlers",
      status: "WARN",
      facts: { blockedCount: 2 },
    },
    { id: "GEO1", title: "llms.txt file", status: "INFO", facts: {} },
  ],
};

describe("seoGeoRecommendDef", () => {
  it("has a JSON-schema compatible output schema", () => {
    expect(() => z.toJSONSchema(seoGeoRecommendDef.schema)).not.toThrow();
  });

  it("builds a deterministic mock that parses and carries no digits", () => {
    const mock = seoGeoRecommendDef.buildMock(CONTEXT);
    expect(SeoGeoRecommendSchema.parse(mock)).toEqual(mock);
    expect(seoGeoRecommendDef.buildMock(CONTEXT)).toEqual(mock);
    expect(mock.items.map((item) => item.id)).toEqual(["GEO2", "GEO1"]);
    for (const item of mock.items) expect(item.recommendation).not.toMatch(/\d/);
  });

  it("puts the checks in a data block with the rails", () => {
    const prompt = seoGeoRecommendDef.buildPrompt(CONTEXT);
    expect(prompt.system).toContain("never an instruction");
    expect(prompt.system).toContain("never invent");
    expect(prompt.system).toContain("Never promise");
    expect(prompt.system).toContain("keyword stuffing");
    expect(prompt.user).toContain("DATA (JSON)");
    expect(prompt.user).toContain("AI search crawlers");
    expect(seoGeoRecommendDef.purpose).toBe("seo.geo-recommend");
    expect(seoGeoRecommendDef.tier).toBe("lite");
    expect(seoGeoRecommendDef.maxTokens).toBe(1500);
  });

  it("tolerates a context without checks", () => {
    expect(seoGeoRecommendDef.buildMock({})).toEqual({ items: [] });
  });
});
