import { describe, expect, it } from "vitest";
import { z } from "zod";

import { adsPlanDef } from "./plan-prompt";

describe("adsPlanDef", () => {
  // reasoning-service.ts turns the schema into JSON Schema on every real call.
  it("has a schema JSON Schema can represent", () => {
    expect(() => z.toJSONSchema(adsPlanDef.schema)).not.toThrow();
  });

  it("asks with the facts as data and derives its mock from them", () => {
    const facts = {
      post: { title: "Spring menu", caption: "Fresh herbs and lemonade." },
      objective: { label: "Traffic" },
      audience: { countries: ["Turkey"], ages: "18–65+" },
      limits: { primaryText: 125 },
    };
    const prompt = adsPlanDef.buildPrompt({ facts });
    expect(prompt.system).toMatch(/primaryText/);
    expect(prompt.system).toMatch(/data, not instructions/);
    expect(prompt.user).toContain("Fresh herbs and lemonade.");

    const mock = adsPlanDef.schema.parse(adsPlanDef.buildMock({ facts }));
    expect(mock).toEqual({
      campaignName: "Spring menu · Traffic",
      adSetName: "Turkey · 18–65+",
      adName: "Spring menu",
      primaryText: "Fresh herbs and lemonade.",
    });
  });
});
