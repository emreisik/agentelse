import { beforeEach, describe, expect, it, vi } from "vitest";

// Proves the audit-gap fix: getBrandContext (the shared brand-reasoning
// context consumed by opportunity-engine/idea-foundry/council-engine, all
// of which JSON.stringify it whole into their prompts) now also surfaces
// the latest BrandStrategyVersion summary and recent BrandLearning rows —
// additively, alongside the existing constitution/dossier fields — and
// never throws when neither exists yet for a brand.

const brandConstitution = { findFirst: vi.fn() };
const brandDossier = { findUnique: vi.fn() };
const brandStrategyVersion = { findFirst: vi.fn() };
const brandLearning = { findMany: vi.fn() };

vi.mock("@/lib/prisma", () => ({
  prisma: {
    brandConstitution,
    brandDossier,
    brandStrategyVersion,
    brandLearning,
  },
}));

const { ConstitutionService } =
  await import("@/server/agency/constitution/constitution-service");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ConstitutionService.getBrandContext", () => {
  it("adds strategySummary and brandLearnings alongside existing constitution fields", async () => {
    brandConstitution.findFirst.mockResolvedValue({
      payload: { identity: "Acme", positioning: "Premium DIY tools" },
    });
    brandStrategyVersion.findFirst.mockResolvedValue({
      summary: "Focus Q4 on retention over acquisition.",
    });
    brandLearning.findMany.mockResolvedValue([
      {
        insight: "Video ads outperform static 3:1",
        confidence: 0.8,
        sourceType: "MEASUREMENT",
      },
      {
        insight: "Weekend posts underperform",
        confidence: 0.6,
        sourceType: "MEASUREMENT",
      },
    ]);

    const context = await ConstitutionService.getBrandContext("brand-1");

    // Existing fields must survive unchanged.
    expect(context.identity).toBe("Acme");
    expect(context.positioning).toBe("Premium DIY tools");

    // New fields are populated.
    expect(context.strategySummary).toBe(
      "Focus Q4 on retention over acquisition.",
    );
    expect(context.brandLearnings).toEqual([
      {
        insight: "Video ads outperform static 3:1",
        confidence: 0.8,
        sourceType: "MEASUREMENT",
      },
      {
        insight: "Weekend posts underperform",
        confidence: 0.6,
        sourceType: "MEASUREMENT",
      },
    ]);

    // Same query shape/limit as context-builder.ts's established convention.
    expect(brandStrategyVersion.findFirst).toHaveBeenCalledWith({
      where: { brandId: "brand-1" },
      orderBy: { version: "desc" },
    });
    expect(brandLearning.findMany).toHaveBeenCalledWith({
      where: { brandId: "brand-1" },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { insight: true, confidence: true, sourceType: true },
    });
  });

  it("falls back to the dossier when there is no active constitution, still adding strategy/learnings", async () => {
    brandConstitution.findFirst.mockResolvedValue(null);
    brandDossier.findUnique.mockResolvedValue({
      summary: "Dossier identity",
      positioning: "Dossier positioning",
      toneOfVoice: "Playful",
      language: "en",
      country: "US",
    });
    brandStrategyVersion.findFirst.mockResolvedValue({
      summary: "Early strategy draft",
    });
    brandLearning.findMany.mockResolvedValue([]);

    const context = await ConstitutionService.getBrandContext("brand-2");

    expect(context.identity).toBe("Dossier identity");
    expect(context.strategySummary).toBe("Early strategy draft");
    expect(context.brandLearnings).toEqual([]);
  });

  it("returns empty strategy/learnings gracefully when neither exists yet, without throwing", async () => {
    brandConstitution.findFirst.mockResolvedValue(null);
    brandDossier.findUnique.mockResolvedValue(null);
    brandStrategyVersion.findFirst.mockResolvedValue(null);
    brandLearning.findMany.mockResolvedValue([]);

    await expect(
      ConstitutionService.getBrandContext("brand-new"),
    ).resolves.toEqual({
      strategySummary: null,
      brandLearnings: [],
    });
  });
});
