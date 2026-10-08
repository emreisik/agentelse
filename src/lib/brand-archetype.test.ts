import { describe, expect, it } from "vitest";

import { archetypeOfBrandContext } from "./brand-archetype";

describe("archetypeOfBrandContext", () => {
  it("reads the constitution in the execution snapshot", () => {
    expect(
      archetypeOfBrandContext({
        positioning: "Güvenilir ortak",
        brandConstitution: {
          summary: "Kurumsal firmalara yazılım ve danışmanlık",
          payload: { businessModel: "B2B SaaS aboneliği" },
        },
      }),
    ).toBe("info");
  });

  it("reads products given as objects or strings", () => {
    expect(
      archetypeOfBrandContext({
        products: [{ name: "Cilt bakım serumu" }, "Güneş kremi"],
      }),
    ).toBe("product");
  });

  it("uses the mood tags of the visual identity", () => {
    expect(
      archetypeOfBrandContext({
        positioning: "Premium tasarım",
        visualIdentity: { moodTags: ["luxury", "minimal"] },
      }),
    ).toBe("minimal-luxe");
  });

  it("is editorial for an empty or unreadable context", () => {
    expect(archetypeOfBrandContext(null)).toBe("editorial");
    expect(archetypeOfBrandContext("nonsense")).toBe("editorial");
    expect(archetypeOfBrandContext({})).toBe("editorial");
  });
});

describe("a design a person picked", () => {
  it("does not change what the brand's own words point to (the pick is applied per format elsewhere)", () => {
    expect(
      archetypeOfBrandContext({
        positioning: "B2B yazılım ve danışmanlık",
        visualIdentity: {
          moodTags: ["professional"],
          designProfile: { formats: { feed: "promo" }, source: "user" },
        },
      }),
    ).toBe("info");
  });
});
