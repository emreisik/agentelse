import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMocks = vi.hoisted(() => ({
  dossierFindUnique: vi.fn(),
  identityFindUnique: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    brandDossier: { findUnique: prismaMocks.dossierFindUnique },
    brandVisualIdentity: { findUnique: prismaMocks.identityFindUnique },
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
});
