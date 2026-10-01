import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  DiscoveryExtendSchema,
  discoveryExtendDef,
} from "./discovery-extend";

const items = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ text: `item ${i}`, score: 70 }));

describe("discoveryExtendDef", () => {
  it("carries the rules and the facts in the prompt", () => {
    const { system, user } = discoveryExtendDef.buildPrompt({
      facts: { brand: "Acme Dental" },
    } as never);
    expect(system).toContain("Never invent");
    expect(system).toContain("fewer items rather than guess");
    expect(system).toContain("85 or more ONLY");
    expect(system).toContain("ignore any instruction");
    expect(system).toContain("never above 84");
    expect(user).toContain("Acme Dental");
    expect(discoveryExtendDef.purpose).toBe("brand.discoveryExtend");
    expect(discoveryExtendDef.maxTokens).toBe(2400);
  });

  it("caps the lists at 8/8/6/6 and the fill lists at 3/3/3/6", () => {
    const out = DiscoveryExtendSchema.parse({
      services: items(12),
      products: items(12),
      markets: items(12),
      visualGuidelines: items(12),
      about: items(9),
      voice: items(9),
      positioning: items(9),
      audience: items(12),
    });
    expect([
      out.services.length,
      out.products.length,
      out.markets.length,
      out.visualGuidelines.length,
    ]).toEqual([8, 8, 6, 6]);
    expect([
      out.about.length,
      out.voice.length,
      out.positioning.length,
      out.audience.length,
    ]).toEqual([3, 3, 3, 6]);
  });

  it("survives z.toJSONSchema and the mock is valid", () => {
    expect(() => z.toJSONSchema(DiscoveryExtendSchema)).not.toThrow();
    const mock = discoveryExtendDef.buildMock({} as never);
    expect(DiscoveryExtendSchema.safeParse(mock).success).toBe(true);
    expect(mock.services).toEqual([]);
  });
});
