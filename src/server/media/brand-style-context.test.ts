import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMocks = vi.hoisted(() => ({
  dossierFindUnique: vi.fn(),
  identityFindUnique: vi.fn(),
  factFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    brandDossier: { findUnique: prismaMocks.dossierFindUnique },
    brandVisualIdentity: { findUnique: prismaMocks.identityFindUnique },
    brandFact: { findMany: prismaMocks.factFindMany },
  },
}));

import { resolveBrandStyleContext } from "@/server/media/brand-style-context";

describe("resolveBrandStyleContext", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns null visualIdentity and legacy-only fields when neither row exists", async () => {
    prismaMocks.dossierFindUnique.mockResolvedValue(null);
    prismaMocks.identityFindUnique.mockResolvedValue(null);

    await expect(resolveBrandStyleContext("brand-1")).resolves.toEqual({
      logoAssetId: null,
      darkLogoAssetId: null,
      legacyApprovedColors: null,
      legacyVisualGuidelines: null,
      visualIdentity: null,
    });
  });

  it("passes through BrandDossier's legacy fields even when no BrandVisualIdentity exists", async () => {
    prismaMocks.dossierFindUnique.mockResolvedValue({
      logoAssetId: "asset-1",
      approvedColors: ["#112233"],
      visualGuidelines: "keep it minimal",
    });
    prismaMocks.identityFindUnique.mockResolvedValue(null);

    const result = await resolveBrandStyleContext("brand-1");
    expect(result.logoAssetId).toBe("asset-1");
    expect(result.legacyApprovedColors).toEqual(["#112233"]);
    expect(result.legacyVisualGuidelines).toBe("keep it minimal");
    expect(result.visualIdentity).toBeNull();
  });

  it("parses structured color roles and passes through the template config", async () => {
    prismaMocks.dossierFindUnique.mockResolvedValue({
      logoAssetId: "asset-1",
      approvedColors: null,
      visualGuidelines: null,
    });
    prismaMocks.identityFindUnique.mockResolvedValue({
      primaryColors: [{ hex: "#1B4F72", name: "Ocean Blue" }],
      secondaryColors: ["#ABCDEF"],
      accentColors: [],
      photographyStyle: "PHOTOGRAPHIC",
      styleRefinement: "soft natural light",
      moodTags: ["premium", "minimal"],
      compositionNotes: "rule of thirds",
      backgroundTone: "LIGHT",
      alwaysInclude: ["always show the product from a 3/4 angle"],
      alwaysAvoid: ["no stock-photo clichés"],
      referenceImageAssetId: "asset-2",
      templateEnabled: true,
      logoPosition: "TOP_RIGHT",
      logoSizePercent: 20,
      logoMarginPercent: 6,
      accentBarEnabled: false,
      accentBarColorHex: null,
      accentBarHeightPercent: 5,
      accentBarPosition: "BOTTOM",
    });

    const result = await resolveBrandStyleContext("brand-1");
    expect(result.visualIdentity).toEqual({
      primaryColors: [{ hex: "#1B4F72", name: "Ocean Blue" }],
      secondaryColors: [{ hex: "#ABCDEF" }],
      accentColors: [],
      photographyStyle: "PHOTOGRAPHIC",
      styleRefinement: "soft natural light",
      moodTags: ["premium", "minimal"],
      compositionNotes: "rule of thirds",
      backgroundTone: "LIGHT",
      alwaysInclude: ["always show the product from a 3/4 angle"],
      alwaysAvoid: ["no stock-photo clichés"],
      referenceImageAssetId: "asset-2",
      // A brand that never saved layouts reads as null (its template above
      // then applies, exactly as before layouts existed).
      layoutTemplates: null,
      template: {
        enabled: true,
        logoPosition: "TOP_RIGHT",
        logoSizePercent: 20,
        logoMarginPercent: 6,
        accentBarEnabled: false,
        accentBarColorHex: null,
        accentBarHeightPercent: 5,
        accentBarPosition: "BOTTOM",
      },
    });
  });

  it("reads saved layouts, tolerating a corrupt one, and treats junk as none", async () => {
    const { buildPresetLayouts } = await import("@/lib/layout-templates");
    const { DEFAULT_KIT_TEMPLATE } = await import("@/lib/brand-kit");
    const layouts = buildPresetLayouts(DEFAULT_KIT_TEMPLATE);
    const identity = {
      primaryColors: [],
      secondaryColors: [],
      accentColors: [],
      photographyStyle: null,
      styleRefinement: null,
      moodTags: [],
      compositionNotes: null,
      backgroundTone: null,
      alwaysInclude: [],
      alwaysAvoid: [],
      referenceImageAssetId: null,
      templateEnabled: true,
      logoPosition: "BOTTOM_RIGHT",
      logoSizePercent: 16,
      logoMarginPercent: 4,
      accentBarEnabled: true,
      accentBarColorHex: null,
      accentBarHeightPercent: 5,
      accentBarPosition: "BOTTOM",
    };
    prismaMocks.dossierFindUnique.mockResolvedValue(null);

    prismaMocks.identityFindUnique.mockResolvedValue({
      ...identity,
      layoutTemplates: { ...layouts, items: [{ id: "BAD" }, ...layouts.items] },
    });
    const parsed = (await resolveBrandStyleContext("b")).visualIdentity!;
    expect(parsed.layoutTemplates!.items.map((i) => i.id)).toEqual(
      layouts.items.map((i) => i.id),
    );

    prismaMocks.identityFindUnique.mockResolvedValue({
      ...identity,
      layoutTemplates: "not layouts",
    });
    expect((await resolveBrandStyleContext("b")).visualIdentity!.layoutTemplates).toBeNull();
  });

  it("queries both tables in parallel, keyed by the same brandId", async () => {
    prismaMocks.dossierFindUnique.mockResolvedValue(null);
    prismaMocks.identityFindUnique.mockResolvedValue(null);

    await resolveBrandStyleContext("brand-42");

    expect(prismaMocks.dossierFindUnique).toHaveBeenCalledWith({
      where: { brandId: "brand-42" },
      select: {
        logoAssetId: true,
        darkLogoAssetId: true,
        approvedColors: true,
        visualGuidelines: true,
      },
    });
    expect(prismaMocks.identityFindUnique).toHaveBeenCalledWith({
      where: { brandId: "brand-42" },
    });
  });

  describe("the Post Style Kit", () => {
    const identity = {
      primaryColors: [],
      secondaryColors: [],
      accentColors: [],
      photographyStyle: null,
      styleRefinement: null,
      moodTags: [],
      compositionNotes: null,
      backgroundTone: null,
      alwaysInclude: [],
      alwaysAvoid: [],
      referenceImageAssetId: null,
      layoutTemplates: null,
      templateEnabled: true,
      logoPosition: "BOTTOM_RIGHT",
      logoSizePercent: 16,
      logoMarginPercent: 4,
      accentBarEnabled: true,
      accentBarColorHex: null,
      accentBarHeightPercent: 5,
      accentBarPosition: "BOTTOM",
    };

    it("rides on the visual identity: the examples that are on, newest first, and the instructions", async () => {
      prismaMocks.dossierFindUnique.mockResolvedValue(null);
      prismaMocks.identityFindUnique.mockResolvedValue(identity);
      prismaMocks.factFindMany.mockResolvedValue([
        { key: "directives", value: { text: "Always dark.", fidelity: "match" } },
        {
          key: "example:old",
          value: { assetId: "old", enabled: true, addedAt: "2026-09-01T00:00:00.000Z" },
        },
        {
          key: "example:off",
          value: { assetId: "off", enabled: false, addedAt: "2026-09-15T00:00:00.000Z" },
        },
        {
          key: "example:new",
          value: { assetId: "new", enabled: true, addedAt: "2026-10-01T00:00:00.000Z" },
        },
      ]);
      const result = await resolveBrandStyleContext("brand-1");
      expect(result.visualIdentity?.postStyle).toEqual({
        fidelity: "match",
        directives: "Always dark.",
        examples: [
          { assetId: "new", label: "", analysis: null },
          { assetId: "old", label: "", analysis: null },
        ],
      });
      expect(prismaMocks.factFindMany.mock.calls[0]![0].where).toMatchObject({
        brandId: "brand-1",
        category: "post_style",
      });
    });

    it("a brand without a kit gets exactly the identity it always had", async () => {
      prismaMocks.dossierFindUnique.mockResolvedValue(null);
      prismaMocks.identityFindUnique.mockResolvedValue(identity);
      prismaMocks.factFindMany.mockResolvedValue([]);
      const result = await resolveBrandStyleContext("brand-1");
      expect(result.visualIdentity).not.toHaveProperty("postStyle");
    });

    it("a kit that cannot be read never costs the brand its look", async () => {
      prismaMocks.dossierFindUnique.mockResolvedValue(null);
      prismaMocks.identityFindUnique.mockResolvedValue(identity);
      prismaMocks.factFindMany.mockRejectedValue(new Error("db blip"));
      const result = await resolveBrandStyleContext("brand-1");
      expect(result.visualIdentity).not.toBeNull();
      expect(result.visualIdentity).not.toHaveProperty("postStyle");
    });
  });
});
