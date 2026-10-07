import { describe, expect, it } from "vitest";
import { z } from "zod";

import { SeoContentPlanSchema, seoContentPlanDef } from "./seo-content-plan";

// Bu dosyanın kanıtladığı: şema JSON şemasına çevrilebilir ve .max()/
// .transform() taşımaz; sahte yanıt şemadan geçer, kararlıdır ve rakam
// uydurmaz; istem "uydurma" kuralını, kapı sayfası korkuluklarını, veri
// bloğunu ve marka kurallarını taşır.

const CONTEXT = {
  brand: { name: "Acme" },
  rules: ["Never mention competitors by name"],
  candidates: [
    {
      id: "SUPPORT:c1:cactus repot",
      keyword: "how to repot a cactus",
      kind: "SUPPORT",
      intent: "informational",
      queries: ["repot cactus", "cactus soil"],
    },
    {
      id: "PILLAR:c2:houseplants",
      keyword: "indoor plants",
      kind: "PILLAR",
      intent: "commercial",
      queries: [],
    },
    { bad: true },
  ],
};

describe("seoContentPlanDef", () => {
  it("has a JSON-schema compatible schema without max or transform", () => {
    expect(() => z.toJSONSchema(seoContentPlanDef.schema)).not.toThrow();
    const json = JSON.stringify(z.toJSONSchema(SeoContentPlanSchema));
    expect(json).not.toContain("maxLength");
    expect(json).not.toContain("maxItems");
    expect(seoContentPlanDef.purpose).toBe("seo.content-plan");
    expect(seoContentPlanDef.tier).toBe("lite");
    expect(seoContentPlanDef.maxTokens).toBe(3000);
  });

  it("builds a deterministic mock that parses and invents no digits", () => {
    const mock = seoContentPlanDef.buildMock(CONTEXT);
    expect(SeoContentPlanSchema.parse(mock)).toEqual(mock);
    expect(seoContentPlanDef.buildMock(CONTEXT)).toEqual(mock);
    expect(mock.items.map((item) => item.id)).toEqual([
      "SUPPORT:c1:cactus repot",
      "PILLAR:c2:houseplants",
    ]);
    expect(mock.items[0]!.title).toContain("How to repot a cactus");
    for (const item of mock.items) {
      expect(item.title).not.toMatch(/\d/);
      expect(item.title.length).toBeLessThanOrEqual(60);
    }
  });

  it("states the no-invented-facts rule and the doorway rails", () => {
    const prompt = seoContentPlanDef.buildPrompt(CONTEXT);
    expect(prompt.system).toContain("NEVER invent facts, numbers, prices");
    expect(prompt.system).toContain("never as instructions");
    expect(prompt.system).toContain("doorway pages");
    expect(prompt.system).toContain("swap only a place name");
    expect(prompt.system).toContain("Never mention competitors by name");
  });

  it("puts the candidates in a data block and skips malformed ones", () => {
    const prompt = seoContentPlanDef.buildPrompt(CONTEXT);
    expect(prompt.user).toContain("CANDIDATES (JSON)");
    expect(prompt.user).toContain("how to repot a cactus");
    expect(prompt.user).not.toContain('"bad"');
  });

  it("works without rules or brand", () => {
    const prompt = seoContentPlanDef.buildPrompt({ candidates: [] });
    expect(prompt.system).not.toContain("Brand rules");
    expect(prompt.user).toContain("[]");
  });
});
