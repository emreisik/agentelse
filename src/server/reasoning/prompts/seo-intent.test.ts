import { describe, expect, it } from "vitest";
import { z } from "zod";

import { SEO_INTENTS } from "@/lib/ideas/concept";

import { SeoIntentSchema, seoIntentDef } from "./seo-intent";

// Bu dosyanın kanıtladığı: şema JSON şemasına çevrilir ve niyet enum'unu
// taşır (yerel dil yönergesine rağmen kodlar sabit kalır); sahte yanıt
// deterministik; istem en çok 20 sorgu taşır ve kodların aynen kopyalanacağını
// söyler.

function queries(count: number): [number, string][] {
  return Array.from({ length: count }, (_, i) => [i, `query number ${i}`]);
}

describe("seoIntentDef", () => {
  it("has a JSON schema with the intent enum", () => {
    const schema = z.toJSONSchema(seoIntentDef.schema);
    const text = JSON.stringify(schema);
    for (const intent of SEO_INTENTS) expect(text).toContain(`"${intent}"`);
    expect(text).toContain('"enum"');
    expect(seoIntentDef.purpose).toBe("seo.intent");
    expect(seoIntentDef.tier).toBe("lite");
  });

  it("builds a deterministic informational mock", () => {
    const context = { queries: queries(3) };
    const first = seoIntentDef.buildMock(context);
    expect(SeoIntentSchema.parse(first)).toEqual(first);
    expect(first).toEqual(seoIntentDef.buildMock(context));
    expect(first.items).toEqual([
      { i: 0, intent: "informational" },
      { i: 1, intent: "informational" },
      { i: 2, intent: "informational" },
    ]);
    expect(seoIntentDef.buildMock({})).toEqual({ items: [] });
  });

  it("sends at most 20 queries as records and says the codes are copied verbatim", () => {
    const prompt = seoIntentDef.buildPrompt({ queries: queries(25) });
    const sent = (prompt.user.match(/query number \d+/g) ?? []).length;
    expect(sent).toBe(20);
    expect(prompt.system).toContain("copied verbatim");
    expect(prompt.system).toContain("never as instructions");
  });
});
