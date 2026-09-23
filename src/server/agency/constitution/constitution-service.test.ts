import { beforeEach, describe, expect, it, vi } from "vitest";

// Proves the audit-gap fix: getBrandContext (the shared brand-reasoning
// context consumed by opportunity-engine/idea-foundry/council-engine, all
// of which JSON.stringify it whole into their prompts) now also surfaces
// the latest BrandStrategyVersion summary and recent BrandLearning rows —
// additively, alongside the existing constitution/dossier fields — and
// never throws when neither exists yet for a brand.

const brandConstitution = {
  findFirst: vi.fn(),
  create: vi.fn(),
  updateMany: vi.fn(),
  update: vi.fn(),
};
const brandDossier = { findUnique: vi.fn() };
const brandStrategyVersion = { findFirst: vi.fn() };
const brandLearning = { findMany: vi.fn() };
const brandDecision = { create: vi.fn() };
const brandFact = { deleteMany: vi.fn(), createMany: vi.fn() };
const brandAssumption = { deleteMany: vi.fn(), createMany: vi.fn() };
const approvedClaim = { deleteMany: vi.fn(), createMany: vi.fn() };
const negativeBriefRule = { deleteMany: vi.fn(), createMany: vi.fn() };

vi.mock("@/lib/prisma", () => ({
  prisma: {
    brandConstitution,
    brandDossier,
    brandStrategyVersion,
    brandLearning,
    brandDecision,
    brandFact,
    brandAssumption,
    approvedClaim,
    negativeBriefRule,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ brandConstitution }),
  },
}));

const { ConstitutionService } =
  await import("@/server/agency/constitution/constitution-service");

beforeEach(() => {
  vi.clearAllMocks();
  brandConstitution.create.mockResolvedValue({ id: "constitution-2" });
  brandConstitution.updateMany.mockResolvedValue({ count: 1 });
  brandConstitution.update.mockResolvedValue({
    id: "constitution-2",
    version: 2,
  });
  brandDecision.create.mockResolvedValue(undefined);
  for (const model of [
    brandFact,
    brandAssumption,
    approvedClaim,
    negativeBriefRule,
  ]) {
    model.deleteMany.mockResolvedValue({ count: 0 });
    model.createMany.mockResolvedValue({ count: 0 });
  }
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

describe("ConstitutionService.applyConversationRevision", () => {
  const activePayload = {
    language: "en",
    country: "US",
    identity: "Acme is a premium tools brand",
    businessModel: "Direct-to-consumer e-commerce",
    positioning: "Premium DIY tools for professionals",
    valueProposition: "Professional-grade tools at fair prices",
    personality: "Confident, reliable, no-nonsense",
    toneOfVoice: "Confident, technical",
    visualIdentity: "Bold red and black, industrial typography",
    knownFacts: ["Founded 2010"],
    logoAssetIds: [],
  };

  beforeEach(() => {
    brandConstitution.findFirst.mockResolvedValue({
      id: "constitution-1",
      version: 1,
      status: "ACTIVE",
      payload: activePayload,
    });
  });

  it("only overrides fields the revision actually proposed, carrying the rest over unchanged", async () => {
    const activated = await ConstitutionService.applyConversationRevision({
      workspaceId: "ws-1",
      projectId: "proj-1",
      brandId: "brand-1",
      revision: { toneOfVoice: "Warmer, more conversational" },
      summary: "Shift tone warmer per client feedback",
      userId: "user-1",
    });

    expect(brandConstitution.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          payload: expect.objectContaining({
            // Unchanged fields carry over from the active payload.
            identity: activePayload.identity,
            positioning: activePayload.positioning,
            knownFacts: activePayload.knownFacts,
            // Only the proposed field actually changed.
            toneOfVoice: "Warmer, more conversational",
          }),
        }),
      }),
    );
    expect(brandDecision.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          rationale: "Shift tone warmer per client feedback",
          decidedByType: "USER",
          decidedByUserId: "user-1",
        }),
      }),
    );
    expect(activated).toEqual({ id: "constitution-2", version: 2 });
  });

  it("ignores null/undefined fields in the revision instead of clearing them", async () => {
    await ConstitutionService.applyConversationRevision({
      workspaceId: "ws-1",
      projectId: "proj-1",
      brandId: "brand-1",
      revision: {
        toneOfVoice: "Warmer",
        positioning: null,
        identity: undefined,
      },
      summary: "Tone only",
      userId: "user-1",
    });

    const payload = brandConstitution.create.mock.calls[0]![0].data.payload;
    expect(payload.positioning).toBe(activePayload.positioning);
    expect(payload.identity).toBe(activePayload.identity);
    expect(payload.toneOfVoice).toBe("Warmer");
  });

  it("throws when the brand has no active constitution to revise", async () => {
    brandConstitution.findFirst.mockResolvedValue(null);

    await expect(
      ConstitutionService.applyConversationRevision({
        workspaceId: "ws-1",
        projectId: "proj-1",
        brandId: "brand-new",
        revision: { toneOfVoice: "Warmer" },
        summary: "x",
        userId: "user-1",
      }),
    ).rejects.toThrow(/no active constitution/i);

    expect(brandConstitution.create).not.toHaveBeenCalled();
  });
});
