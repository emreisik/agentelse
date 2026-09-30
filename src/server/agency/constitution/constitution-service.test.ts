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
const brandAssumption = {
  deleteMany: vi.fn(),
  createMany: vi.fn(),
  findMany: vi.fn(),
};
const approvedClaim = {
  deleteMany: vi.fn(),
  createMany: vi.fn(),
  findMany: vi.fn(),
};
const negativeBriefRule = {
  deleteMany: vi.fn(),
  createMany: vi.fn(),
  findMany: vi.fn(),
};
const brandEvidence = { createMany: vi.fn() };

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
    brandEvidence,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ brandConstitution }),
  },
}));

const { ConstitutionService, ConstitutionConflictError } =
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
  // Nothing survives a promotion unless a test says a person left it there.
  for (const model of [brandAssumption, approvedClaim, negativeBriefRule]) {
    model.findMany.mockResolvedValue([]);
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

// publishVersion is the one way a constitution becomes the brand's active one:
// the deep synthesis and Quick Discovery both go through it, so they are
// versioned, audited and mirrored into the Brand Brain identically.
describe("ConstitutionService.publishVersion", () => {
  const scope = {
    workspaceId: "ws-1",
    projectId: "proj-1",
    brandId: "brand-1",
  };
  const payload = {
    language: "tr",
    country: "TR",
    identity: "Acme Boya, İzmir merkezli boya üreticisi",
    businessModel: "Üretici",
    products: ["İç cephe boyası"],
    markets: ["Türkiye"],
    audiences: [],
    positioning: "Su bazlı boya",
    valueProposition: "Sağlıklı iç mekan",
    personality: "Güvenilir",
    toneOfVoice: "Sade",
    visualIdentity: "",
    approvedClaims: [],
    forbiddenClaims: ["Sıfır kimyasal"],
    negativeBrief: ["Abartılı vaat verme"],
    customerProblems: [],
    customerObjections: [],
    competitors: [],
    differentiators: [],
    legalRestrictions: [],
    knownFacts: ["1985'ten beri üretim yapıyor"],
    assumptions: ["Bayi ağıyla satıyor"],
    openQuestions: [],
    logoAssetIds: [],
  };

  beforeEach(() => {
    brandConstitution.findFirst.mockResolvedValue({ version: 1 });
    brandConstitution.update.mockResolvedValue({
      id: "constitution-2",
      version: 2,
      summary: payload.identity,
    });
    brandEvidence.createMany.mockResolvedValue({ count: 0 });
  });

  it("stores the payload as the next version, activates it and supersedes the old one", async () => {
    const activated = await ConstitutionService.publishVersion({
      scope,
      payload,
      isMock: false,
      sourceFindingIds: ["f1", "f2"],
      evidenceIds: [],
    });

    expect(activated).toMatchObject({ id: "constitution-2", version: 2 });
    expect(brandConstitution.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ...scope,
        version: 2,
        status: "DRAFT",
        payload,
        summary: payload.identity,
        sourceFindingIds: ["f1", "f2"],
        isMock: false,
      }),
    });
    expect(brandConstitution.updateMany).toHaveBeenCalledWith({
      where: { brandId: "brand-1", status: "ACTIVE" },
      data: { status: "SUPERSEDED" },
    });
    expect(brandConstitution.update).toHaveBeenCalledWith({
      where: { id: "constitution-2" },
      data: { status: "ACTIVE" },
    });
  });

  it("starts at version 1 for a brand that has no constitution yet", async () => {
    brandConstitution.findFirst.mockResolvedValue(null);

    await ConstitutionService.publishVersion({
      scope,
      payload,
      isMock: false,
      sourceFindingIds: [],
      evidenceIds: [],
    });

    expect(brandConstitution.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ version: 1 }),
    });
  });

  it("logs the decision, naming where the version came from when a note is given", async () => {
    await ConstitutionService.publishVersion({
      scope,
      payload,
      isMock: false,
      sourceFindingIds: [],
      evidenceIds: [],
      note: "quick discovery",
    });

    expect(brandDecision.create).toHaveBeenCalledWith({
      data: {
        ...scope,
        topic: "Brand Constitution",
        decision: "v2 activated (quick discovery)",
        rationale: payload.identity,
        decidedByType: "SYSTEM",
      },
    });
  });

  it("logs a plain decision without a note, and attributes a mock run to the AI", async () => {
    await ConstitutionService.publishVersion({
      scope,
      payload,
      isMock: true,
      sourceFindingIds: [],
      evidenceIds: [],
    });

    expect(brandDecision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        decision: "v2 activated",
        decidedByType: "AI",
      }),
    });
  });

  // G27: a person's Approve is a USER decision, everything else stays as it was.
  it("records a USER decision with the user's id when decidedBy is given", async () => {
    await ConstitutionService.publishVersion({
      scope,
      payload,
      isMock: false,
      sourceFindingIds: [],
      evidenceIds: [],
      note: "guided setup",
      decidedBy: { type: "USER", userId: "user-7" },
    });

    expect(brandDecision.create).toHaveBeenCalledWith({
      data: {
        ...scope,
        topic: "Brand Constitution",
        decision: "v2 activated (guided setup)",
        rationale: payload.identity,
        decidedByType: "USER",
        decidedByUserId: "user-7",
      },
    });
  });

  it("keeps SYSTEM (or AI for a mock run) and no user id when decidedBy is absent", async () => {
    await ConstitutionService.publishVersion({
      scope,
      payload,
      isMock: false,
      sourceFindingIds: [],
      evidenceIds: [],
    });

    const { data } = brandDecision.create.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(data.decidedByType).toBe("SYSTEM");
    expect(data).not.toHaveProperty("decidedByUserId");
  });

  // G63 (service half): the pinned ACTIVE version is checked before anything
  // is created.
  describe("ifActiveVersion", () => {
    // getActive looks for status ACTIVE; createNextVersion asks for the latest.
    const activeIs = (version: number | null) =>
      brandConstitution.findFirst.mockImplementation(
        async (args: { where: { status?: string } }) =>
          args.where.status === "ACTIVE"
            ? version === null
              ? null
              : { version }
            : { version: version ?? 0 },
      );
    const input = {
      scope,
      payload,
      isMock: false,
      sourceFindingIds: [],
      evidenceIds: [],
    };

    it("throws ConstitutionConflictError and creates nothing when the ACTIVE version differs", async () => {
      activeIs(3);

      const attempt = ConstitutionService.publishVersion({
        ...input,
        ifActiveVersion: 2,
      });

      await expect(attempt).rejects.toBeInstanceOf(ConstitutionConflictError);
      await expect(attempt).rejects.toMatchObject({ code: "CONFLICT" });
      expect(brandConstitution.create).not.toHaveBeenCalled();
      expect(brandConstitution.updateMany).not.toHaveBeenCalled();
      expect(brandDecision.create).not.toHaveBeenCalled();
    });

    it("throws when null was expected but a version is ACTIVE", async () => {
      activeIs(1);

      await expect(
        ConstitutionService.publishVersion({ ...input, ifActiveVersion: null }),
      ).rejects.toBeInstanceOf(ConstitutionConflictError);
      expect(brandConstitution.create).not.toHaveBeenCalled();
    });

    it("throws when a version was expected but nothing is ACTIVE", async () => {
      activeIs(null);

      await expect(
        ConstitutionService.publishVersion({ ...input, ifActiveVersion: 1 }),
      ).rejects.toBeInstanceOf(ConstitutionConflictError);
      expect(brandConstitution.create).not.toHaveBeenCalled();
    });

    it("publishes when the ACTIVE version matches", async () => {
      activeIs(1);

      await ConstitutionService.publishVersion({
        ...input,
        ifActiveVersion: 1,
      });

      expect(brandConstitution.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ version: 2 }),
      });
    });

    it("publishes over nothing when null was expected and nothing is ACTIVE", async () => {
      activeIs(null);

      await ConstitutionService.publishVersion({
        ...input,
        ifActiveVersion: null,
      });

      expect(brandConstitution.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ version: 1 }),
      });
    });

    it("does not look at the ACTIVE version at all when the option is undefined", async () => {
      await ConstitutionService.publishVersion(input);

      expect(brandConstitution.findFirst).toHaveBeenCalledTimes(1);
      expect(brandConstitution.findFirst).not.toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: "ACTIVE" }),
        }),
      );
    });
  });

  it("ties the evidence it was built from to the new version, once each", async () => {
    await ConstitutionService.publishVersion({
      scope,
      payload,
      isMock: false,
      sourceFindingIds: [],
      evidenceIds: ["ev-1", "ev-2", "ev-1"],
    });

    expect(brandEvidence.createMany).toHaveBeenCalledWith({
      data: [
        {
          ...scope,
          evidenceId: "ev-1",
          relatedEntityType: "BRAND_CONSTITUTION",
          relatedEntityId: "constitution-2",
        },
        {
          ...scope,
          evidenceId: "ev-2",
          relatedEntityType: "BRAND_CONSTITUTION",
          relatedEntityId: "constitution-2",
        },
      ],
    });
  });

  it("links nothing when there is no evidence", async () => {
    await ConstitutionService.publishVersion({
      scope,
      payload,
      isMock: false,
      sourceFindingIds: [],
      evidenceIds: [],
    });

    expect(brandEvidence.createMany).not.toHaveBeenCalled();
  });

  it("mirrors the payload into the Brand Brain tables, and only what it has", async () => {
    await ConstitutionService.publishVersion({
      scope,
      payload,
      isMock: false,
      sourceFindingIds: [],
      evidenceIds: [],
    });

    expect(brandFact.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          value: "1985'ten beri üretim yapıyor",
          source: "Brand Constitution v2",
        }),
      ],
    });
    expect(brandAssumption.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ statement: "Bayi ağıyla satıyor" })],
    });
    expect(negativeBriefRule.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          rule: "Abartılı vaat verme",
          category: "negative-brief",
        }),
        expect.objectContaining({
          rule: "Sıfır kimyasal",
          category: "forbidden-claim",
        }),
      ],
    });
    // Nothing to approve, so no approved claim is invented.
    expect(approvedClaim.createMany).not.toHaveBeenCalled();
  });
});

// A new version replaces what the LAST promotion wrote and nobody touched. It
// must not wipe what a person decided or added (the deep research rewrites the
// first-look draft; the client's approvals cannot vanish with it).
describe("ConstitutionService.publishVersion keeps what a person decided", () => {
  const scope = {
    workspaceId: "ws-1",
    projectId: "proj-1",
    brandId: "brand-1",
  };
  const basePayload = {
    language: "tr",
    country: "TR",
    identity: "Acme",
    businessModel: "",
    products: [],
    markets: [],
    audiences: [],
    positioning: "",
    valueProposition: "",
    personality: "",
    toneOfVoice: "",
    visualIdentity: "",
    approvedClaims: [],
    forbiddenClaims: [],
    negativeBrief: [],
    customerProblems: [],
    customerObjections: [],
    competitors: [],
    differentiators: [],
    legalRestrictions: [],
    knownFacts: [],
    assumptions: [],
    openQuestions: [],
    logoAssetIds: [],
  };
  const publish = (overrides: Record<string, unknown> = {}) =>
    ConstitutionService.publishVersion({
      scope,
      payload: { ...basePayload, ...overrides },
      isMock: false,
      sourceFindingIds: [],
      evidenceIds: [],
    });

  beforeEach(() => {
    brandConstitution.findFirst.mockResolvedValue({ version: 1 });
    brandConstitution.update.mockResolvedValue({
      id: "constitution-2",
      version: 2,
      summary: "Acme",
    });
  });

  it("replaces only the rows a promotion writes and nobody has reviewed", async () => {
    await publish();

    expect(brandFact.deleteMany).toHaveBeenCalledWith({
      where: { brandId: "brand-1", category: "constitution" },
    });
    // CONFIRMED / REJECTED assumptions are verdicts, not drafts.
    expect(brandAssumption.deleteMany).toHaveBeenCalledWith({
      where: { brandId: "brand-1", status: "UNVERIFIED" },
    });
    // A claim somebody approved has an approver.
    expect(approvedClaim.deleteMany).toHaveBeenCalledWith({
      where: { brandId: "brand-1", approvedByUserId: null },
    });
    expect(negativeBriefRule.deleteMany).toHaveBeenCalledWith({
      where: {
        brandId: "brand-1",
        category: { in: ["negative-brief", "forbidden-claim"] },
      },
    });
  });

  it("does not write an assumption again that a person already confirmed or rejected", async () => {
    brandAssumption.findMany.mockResolvedValue([
      { statement: "  Bayi ağıyla satıyor " },
    ]);

    await publish({
      assumptions: ["bayi ağıyla satıyor", "Yeni bir varsayım"],
    });

    expect(brandAssumption.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ statement: "Yeni bir varsayım" })],
    });
  });

  it("does not duplicate a claim the client already approved", async () => {
    approvedClaim.findMany.mockResolvedValue([
      { claim: "1985'ten beri üretici" },
    ]);

    await publish({
      approvedClaims: ["1985'ten beri üretici", "İzmir'de üretilir"],
    });

    expect(approvedClaim.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ claim: "İzmir'de üretilir" })],
    });
  });

  it("does not duplicate a rule that is already on record, in either category", async () => {
    negativeBriefRule.findMany.mockResolvedValue([
      { rule: "Abartılı vaat verme" },
      { rule: "sıfır kimyasal" },
    ]);

    await publish({
      negativeBrief: ["Abartılı vaat verme", "Rakip adı anma"],
      forbiddenClaims: ["Sıfır Kimyasal", "Tıbbi iddia"],
    });

    expect(negativeBriefRule.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          rule: "Rakip adı anma",
          category: "negative-brief",
        }),
        expect.objectContaining({
          rule: "Tıbbi iddia",
          category: "forbidden-claim",
        }),
      ],
    });
  });

  it("writes nothing when every entry is already on record", async () => {
    approvedClaim.findMany.mockResolvedValue([{ claim: "A" }]);
    negativeBriefRule.findMany.mockResolvedValue([{ rule: "B" }]);
    brandAssumption.findMany.mockResolvedValue([{ statement: "C" }]);

    await publish({
      approvedClaims: ["a"],
      negativeBrief: ["b"],
      assumptions: ["c"],
    });

    expect(approvedClaim.createMany).not.toHaveBeenCalled();
    expect(negativeBriefRule.createMany).not.toHaveBeenCalled();
    expect(brandAssumption.createMany).not.toHaveBeenCalled();
  });
});
