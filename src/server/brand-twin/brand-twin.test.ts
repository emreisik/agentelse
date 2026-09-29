import { beforeEach, describe, expect, it, vi } from "vitest";

// BrandTwin (docs/brand-workspace-migration.md §7 Phase 3) composes an
// existing brand's scattered Brand Brain rows into one typed object — same
// mocking pattern as creative.repository.test.ts: mock the prisma client,
// assert on the composed shape.

const brandFindFirst = vi.fn();
const brandConstitutionFindFirst = vi.fn();
const brandDossierFindUnique = vi.fn();
const brandVisualIdentityFindUnique = vi.fn();
const projectGoalFindFirst = vi.fn();
const userDecisionFindMany = vi.fn();
const brandLearningFindMany = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    brand: { findFirst: brandFindFirst },
    brandConstitution: { findFirst: brandConstitutionFindFirst },
    brandDossier: { findUnique: brandDossierFindUnique },
    brandVisualIdentity: { findUnique: brandVisualIdentityFindUnique },
    projectGoal: { findFirst: projectGoalFindFirst },
    userDecision: { findMany: userDecisionFindMany },
    brandLearning: { findMany: brandLearningFindMany },
  },
}));

const { brandCoreOf, getBrandTwin } = await import("./brand-twin");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getBrandTwin", () => {
  it("returns null when the project has no default brand yet", async () => {
    brandFindFirst.mockResolvedValueOnce(null);

    const twin = await getBrandTwin("proj-1");

    expect(twin).toBeNull();
    expect(brandConstitutionFindFirst).not.toHaveBeenCalled();
  });

  it("composes a full BrandTwin from the underlying Brand Brain rows", async () => {
    brandFindFirst.mockResolvedValueOnce({
      id: "brand-1",
      name: "BAGNA XCLUSIVE",
    });
    brandConstitutionFindFirst.mockResolvedValueOnce({
      version: 3,
      status: "ACTIVE",
      isMock: false,
      sourceFindingIds: ["finding-1"],
      updatedAt: new Date("2026-09-20T00:00:00Z"),
      payload: {
        language: "en",
        country: "TR",
        identity: "Premium womenswear wholesaler",
        businessModel: "B2B wholesale + retail",
        products: ["Blazers", "Dresses"],
        markets: ["Türkiye", "Russia"],
        audiences: ["Boutique buyers"],
        positioning: "Premium contemporary fashion",
        valueProposition: "Editorial quality at wholesale scale",
        personality: "Confident",
        toneOfVoice: "Professional",
        visualIdentity: "Editorial, clean, sophisticated",
        approvedClaims: ["Wholesale from Turkey"],
        forbiddenClaims: ["Same-day delivery"],
        negativeBrief: ["Neon colors"],
        customerProblems: [],
        customerObjections: [],
        competitors: [],
        differentiators: [],
        legalRestrictions: [],
        knownFacts: [],
        assumptions: ["Same-day dispatch"],
        openQuestions: ["Return policy for wholesale?"],
      },
    });
    brandDossierFindUnique.mockResolvedValueOnce({
      approvedColors: ["#111111"],
      approvedFonts: ["Inter"],
      logoAssetId: "asset-logo",
    });
    projectGoalFindFirst.mockResolvedValueOnce({
      id: "goal-1",
      title: "Grow wholesale buyers",
      description: "Focus acquisition on boutique buyers",
    });
    userDecisionFindMany.mockResolvedValueOnce([
      {
        id: "dec-1",
        type: "CREATIVE_PREFERENCE",
        scope: "BRAND",
        value: { preference: "premium_editorial" },
        rawMessage: "More premium.",
        createdAt: new Date("2026-09-21T00:00:00Z"),
      },
    ]);
    brandLearningFindMany.mockResolvedValueOnce([
      {
        insight: "Editorial photography performs well",
        polarity: "WORKS",
        evidenceCount: 4,
      },
      {
        insight: "Heavy text overlays underperform",
        polarity: "AVOID",
        evidenceCount: 2,
      },
    ]);

    const twin = await getBrandTwin("proj-1");

    expect(twin).not.toBeNull();
    expect(twin!.brandId).toBe("brand-1");
    expect(twin!.name).toBe("BAGNA XCLUSIVE");
    expect(twin!.version).toBe(3);
    expect(twin!.confidence).toBe("high");
    expect(twin!.identity).toBe("Premium womenswear wholesaler");
    expect(twin!.markets).toEqual(["Türkiye", "Russia"]);
    expect(twin!.unverifiedClaims).toEqual([
      "Same-day dispatch",
      "Return policy for wholesale?",
    ]);
    expect(twin!.negativeRules).toEqual(["Same-day delivery", "Neon colors"]);
    expect(twin!.visualDNA.colors).toEqual([{ hex: "#111111" }]);
    expect(twin!.visualDNA.logoAssetId).toBe("asset-logo");
    expect(twin!.currentFocus).toEqual({
      goalId: "goal-1",
      title: "Grow wholesale buyers",
      description: "Focus acquisition on boutique buyers",
    });
    expect(twin!.creativePreferences).toHaveLength(1);
    expect(twin!.creativePreferences[0]!.value).toEqual({
      preference: "premium_editorial",
    });
    expect(twin!.creativeMemory.works).toEqual([
      { insight: "Editorial photography performs well", evidenceCount: 4 },
    ]);
    expect(twin!.creativeMemory.avoid).toEqual([
      { insight: "Heavy text overlays underperform", evidenceCount: 2 },
    ]);
    expect(twin!.sources).toEqual(["finding-1"]);
  });

  it("degrades gracefully with low confidence when there is no constitution yet", async () => {
    brandFindFirst.mockResolvedValueOnce({ id: "brand-1", name: "New Brand" });
    brandConstitutionFindFirst.mockResolvedValueOnce(null);
    brandDossierFindUnique.mockResolvedValueOnce(null);
    projectGoalFindFirst.mockResolvedValueOnce(null);
    userDecisionFindMany.mockResolvedValueOnce([]);
    brandLearningFindMany.mockResolvedValueOnce([]);

    const twin = await getBrandTwin("proj-1");

    expect(twin!.confidence).toBe("low");
    expect(twin!.version).toBeNull();
    expect(twin!.identity).toBeNull();
    expect(twin!.currentFocus).toBeNull();
  });

  it("marks mock constitutions as low confidence even when ACTIVE", async () => {
    brandFindFirst.mockResolvedValueOnce({ id: "brand-1", name: "Mock Brand" });
    brandConstitutionFindFirst.mockResolvedValueOnce({
      version: 1,
      status: "ACTIVE",
      isMock: true,
      sourceFindingIds: [],
      updatedAt: new Date("2026-09-20T00:00:00Z"),
      payload: { identity: "Mock identity" },
    });
    brandDossierFindUnique.mockResolvedValueOnce(null);
    projectGoalFindFirst.mockResolvedValueOnce(null);
    userDecisionFindMany.mockResolvedValueOnce([]);
    brandLearningFindMany.mockResolvedValueOnce([]);

    const twin = await getBrandTwin("proj-1");

    expect(twin!.confidence).toBe("low");
  });

  it("prefers BrandVisualIdentity's role-split colors over BrandDossier.approvedColors when both exist", async () => {
    brandFindFirst.mockResolvedValueOnce({ id: "brand-1", name: "Brand" });
    brandConstitutionFindFirst.mockResolvedValueOnce(null);
    brandDossierFindUnique.mockResolvedValueOnce({
      approvedColors: ["#dead00"],
      approvedFonts: ["Inter"],
      logoAssetId: null,
    });
    brandVisualIdentityFindUnique.mockResolvedValueOnce({
      primaryColors: [{ hex: "#111111", name: "Ink" }],
      secondaryColors: [{ hex: "#eeeeee" }],
      accentColors: [{ hex: "#111111" }], // duplicate of primary — should dedupe
    });
    projectGoalFindFirst.mockResolvedValueOnce(null);
    userDecisionFindMany.mockResolvedValueOnce([]);
    brandLearningFindMany.mockResolvedValueOnce([]);

    const twin = await getBrandTwin("proj-1");

    expect(twin!.visualDNA.colors).toEqual([
      { hex: "#111111", name: "Ink" },
      { hex: "#eeeeee" },
    ]);
  });

  it("falls back to BrandDossier.approvedColors when there's no BrandVisualIdentity row", async () => {
    brandFindFirst.mockResolvedValueOnce({ id: "brand-1", name: "Brand" });
    brandConstitutionFindFirst.mockResolvedValueOnce(null);
    brandDossierFindUnique.mockResolvedValueOnce({
      approvedColors: ["#dead00"],
      approvedFonts: [],
      logoAssetId: null,
    });
    brandVisualIdentityFindUnique.mockResolvedValueOnce(null);
    projectGoalFindFirst.mockResolvedValueOnce(null);
    userDecisionFindMany.mockResolvedValueOnce([]);
    brandLearningFindMany.mockResolvedValueOnce([]);

    const twin = await getBrandTwin("proj-1");

    expect(twin!.visualDNA.colors).toEqual([{ hex: "#dead00" }]);
  });
});

describe("getBrandTwin: which constitution version it describes", () => {
  const constitution = (status: string, version: number) => ({
    version,
    status,
    isMock: false,
    sourceFindingIds: [],
    updatedAt: new Date("2026-09-20T00:00:00Z"),
    payload: { identity: `identity v${version}` },
  });

  beforeEach(() => {
    brandFindFirst.mockResolvedValue({ id: "brand-1", name: "Brand" });
    brandDossierFindUnique.mockResolvedValue(null);
    brandVisualIdentityFindUnique.mockResolvedValue(null);
    projectGoalFindFirst.mockResolvedValue(null);
    userDecisionFindMany.mockResolvedValue([]);
    brandLearningFindMany.mockResolvedValue([]);
  });

  it("asks for the ACTIVE version first, the one idea generation and the council read", async () => {
    brandConstitutionFindFirst.mockResolvedValueOnce(constitution("ACTIVE", 2));

    const twin = await getBrandTwin("proj-1");

    expect(brandConstitutionFindFirst).toHaveBeenCalledTimes(1);
    expect(brandConstitutionFindFirst).toHaveBeenCalledWith({
      where: { brandId: "brand-1", status: "ACTIVE" },
      orderBy: { version: "desc" },
    });
    expect(twin!.version).toBe(2);
    expect(twin!.confidence).toBe("high");
  });

  it("does not describe a newer draft while an older version is the active one", async () => {
    // Only the ACTIVE lookup is made when there is an active version, so a
    // half-written newer DRAFT can never win over it.
    brandConstitutionFindFirst.mockResolvedValueOnce(constitution("ACTIVE", 1));

    const twin = await getBrandTwin("proj-1");

    expect(twin!.version).toBe(1);
    expect(brandConstitutionFindFirst).toHaveBeenCalledTimes(1);
  });

  it("falls back to the newest version when none is active yet, at medium confidence", async () => {
    brandConstitutionFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(constitution("DRAFT", 3));

    const twin = await getBrandTwin("proj-1");

    expect(brandConstitutionFindFirst).toHaveBeenCalledTimes(2);
    expect(brandConstitutionFindFirst).toHaveBeenLastCalledWith({
      where: { brandId: "brand-1" },
      orderBy: { version: "desc" },
    });
    expect(twin!.version).toBe(3);
    expect(twin!.confidence).toBe("medium");
  });
});

describe("getBrandTwin: memory on demand", () => {
  beforeEach(() => {
    brandFindFirst.mockResolvedValue({ id: "brand-1", name: "Brand" });
    brandConstitutionFindFirst.mockResolvedValue(null);
    brandDossierFindUnique.mockResolvedValue(null);
    brandVisualIdentityFindUnique.mockResolvedValue(null);
    projectGoalFindFirst.mockResolvedValue(null);
    userDecisionFindMany.mockResolvedValue([
      {
        id: "d1",
        type: "CREATIVE_PREFERENCE",
        scope: "BRAND",
        value: "premium",
        rawMessage: null,
        createdAt: new Date(),
      },
    ]);
    brandLearningFindMany.mockResolvedValue([
      { insight: "Editorial works", polarity: "WORKS", evidenceCount: 2 },
    ]);
  });

  it("reads the stored preferences and learnings by default", async () => {
    const twin = await getBrandTwin("proj-1");

    expect(userDecisionFindMany).toHaveBeenCalledTimes(1);
    expect(brandLearningFindMany).toHaveBeenCalledTimes(1);
    expect(twin!.creativePreferences).toHaveLength(1);
    expect(twin!.creativeMemory.works).toHaveLength(1);
  });

  it("skips both memory queries when the caller recalls memory itself", async () => {
    const twin = await getBrandTwin("proj-1", { memory: false });

    expect(userDecisionFindMany).not.toHaveBeenCalled();
    expect(brandLearningFindMany).not.toHaveBeenCalled();
    expect(twin!.creativePreferences).toEqual([]);
    expect(twin!.creativeMemory).toEqual({ works: [], avoid: [] });
  });
});

describe("brandCoreOf", () => {
  it("drops the memory and keeps who the brand is", async () => {
    brandFindFirst.mockResolvedValue({ id: "brand-1", name: "Brand" });
    brandConstitutionFindFirst.mockResolvedValue(null);
    brandDossierFindUnique.mockResolvedValue(null);
    brandVisualIdentityFindUnique.mockResolvedValue(null);
    projectGoalFindFirst.mockResolvedValue(null);
    userDecisionFindMany.mockResolvedValue([]);
    brandLearningFindMany.mockResolvedValue([]);

    const core = brandCoreOf((await getBrandTwin("proj-1"))!);

    expect(core).not.toHaveProperty("creativePreferences");
    expect(core).not.toHaveProperty("creativeMemory");
    expect(core).toMatchObject({ brandId: "brand-1", name: "Brand" });
    expect(core).toHaveProperty("negativeRules");
    expect(core).toHaveProperty("currentFocus");
  });
});
