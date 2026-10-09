import { beforeEach, describe, expect, it, vi } from "vitest";

// The weekly auto-planner's riskiest behaviors: (1) it must fully consume
// every idea it successfully turns into a post through the SAME
// IDEA_TRANSITIONS chain AgencyDirector.decideOnIdea uses, so the normal
// autonomous loop (which only ever looks at SHORTLISTED ideas) can never
// pick the same idea up a second time — (2) a single failed image
// generation must not abort the rest of the week's batch, nor should the
// failed idea be consumed — (3) it must respect the SAME daily-cap and
// AutopilotMode/brand-safety gates every other autonomous surface respects
// (docs/brand-workspace-migration.md §7 Phases 6-7 — this planner
// previously bypassed both entirely).

const ideaFindMany = vi.fn();
const assetCreate = vi.fn();
const scheduleFindMany = vi.fn();
const brandFindUnique = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    idea: { findMany: ideaFindMany },
    asset: { create: assetCreate },
    projectSchedule: { findMany: scheduleFindMany },
    brand: { findUnique: brandFindUnique },
  },
}));

const postSystemMessage = vi.fn();
vi.mock("@/server/repositories/idea-chat.repository", () => ({
  IdeaChatRepository: { postSystemMessage },
}));

const generateCreativeImage = vi.fn();
vi.mock("@/server/media/creative-image", () => ({
  generateCreativeImage,
}));

// The brand's look (logo, palette, saved post layouts). The default below is a
// brand with no visual identity; tests swap it to exercise layouts.
const resolveBrandStyleContext = vi.fn();
vi.mock("@/server/media/brand-style-context", () => ({
  resolveBrandStyleContext,
}));
const applyBrandTemplate = vi.fn();
vi.mock("@/server/media/creative-template", () => ({ applyBrandTemplate }));
// The copywriter step has its own tests; here it is a switch.
const writeOnImageText = vi.fn();
vi.mock("@/server/media/headline-copywriter", () => ({ writeOnImageText }));
const directImage = vi.fn();
vi.mock("@/server/media/art-director", () => ({ directImage }));
vi.mock("@/server/media/brand-logo", () => ({
  loadReferenceImage: vi.fn().mockResolvedValue(null),
}));

const checkAndIncrement = vi.fn();
const getOrCreate = vi.fn();
vi.mock("@/server/repositories/autonomy-policy.repository", () => ({
  AutonomyPolicyRepository: { checkAndIncrement, getOrCreate },
}));

const getBrandTwin = vi.fn();
vi.mock("@/server/brand-twin/brand-twin", () => ({ getBrandTwin }));

const reasoningRun = vi.fn();
vi.mock("@/server/reasoning/reasoning-service", () => ({
  ReasoningService: { run: reasoningRun },
}));
vi.mock("@/server/reasoning/prompts/creative-claim-check", () => ({
  creativeClaimCheckDef: {},
}));

const approvalCreate = vi.fn();
vi.mock("@/server/repositories/approval.repository", () => ({
  ApprovalRepository: { create: approvalCreate },
}));

const creativeCreate = vi.fn();
const creativeAddVersion = vi.fn();
const creativeTransition = vi.fn();
const setScheduledFor = vi.fn();
vi.mock("@/server/repositories/creative.repository", () => ({
  CreativeRepository: {
    create: creativeCreate,
    addVersion: creativeAddVersion,
    transition: creativeTransition,
    setScheduledFor,
  },
}));

const ideaTransition = vi.fn();
vi.mock("@/server/repositories/idea.repository", () => ({
  IdeaRepository: { transition: ideaTransition },
}));

const auditRecord = vi.fn();
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: auditRecord },
}));

// The plan-allowance hold of one post: billing off by default (an empty hold).
const hold = { meter: {}, finish: vi.fn() };
const beginOperation = vi.fn();
vi.mock("@/server/billing/operation", () => ({ beginOperation }));

const { planWeeklyInstagramContent, selectIdeasForWeek } =
  await import("./instagram-week-planner");
const { AgentelseError } = await import("@/server/security/errors");

const SCOPE = { workspaceId: "w-1", projectId: "p-1", brandId: "b-1" };

function idea(id: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    title: `Idea ${id}`,
    description: `Description ${id}`,
    status: "SHORTLISTED",
    lens: null,
    nbaScore: null,
    ...overrides,
  };
}

function generatedImage(id: string) {
  return {
    storageKey: `mock://${id}`,
    filename: `${id}.png`,
    mimeType: "image/png",
    size: 1000,
    provider: "openai" as const,
    width: 1080,
    height: 1080,
  };
}

const BARE_BRAND_STYLE = {
  logoAssetId: null,
  darkLogoAssetId: null,
  legacyApprovedColors: null,
  legacyVisualGuidelines: null,
  visualIdentity: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  hold.finish.mockReset();
  beginOperation.mockReset();
  beginOperation.mockResolvedValue(hold);
  scheduleFindMany.mockResolvedValue([]);
  checkAndIncrement.mockResolvedValue(undefined);
  getOrCreate.mockResolvedValue({ autopilotMode: "AUTOPILOT" });
  getBrandTwin.mockResolvedValue(null);
  resolveBrandStyleContext.mockResolvedValue(BARE_BRAND_STYLE);
  applyBrandTemplate.mockResolvedValue(null);
  writeOnImageText.mockResolvedValue(null);
  directImage.mockResolvedValue(null);
  brandFindUnique.mockResolvedValue({ name: "Acme" });
  reasoningRun.mockResolvedValue({ output: { safe: true } });
  approvalCreate.mockResolvedValue({ id: "approval-1" });
  postSystemMessage.mockResolvedValue(undefined);
  creativeCreate.mockImplementation(async (input: { title?: string }) => ({
    id: `creative-${input.title}`,
  }));
  creativeAddVersion.mockResolvedValue({ id: "version-1", version: 1 });
  assetCreate.mockImplementation(
    async (input: { data: { filename?: string } }) => ({
      id: `asset-${input.data.filename}`,
    }),
  );
});

describe("planWeeklyInstagramContent", () => {
  it("consumes every successfully-generated idea through the full SHORTLISTED->MEASURING chain", async () => {
    ideaFindMany.mockResolvedValueOnce([idea("a"), idea("b")]);
    generateCreativeImage
      .mockResolvedValueOnce(generatedImage("a"))
      .mockResolvedValueOnce(generatedImage("b"));

    const result = await planWeeklyInstagramContent(SCOPE, 3);

    expect(result.ideasConsidered).toBe(2);
    expect(result.imagesGenerated).toBe(2);
    expect(result.imagesFailed).toBe(0);
    expect(result.pendingReview).toBe(0);

    for (const id of ["a", "b"]) {
      expect(ideaTransition).toHaveBeenCalledWith(id, "p-1", "APPROVED");
      expect(ideaTransition).toHaveBeenCalledWith(id, "p-1", "PLANNING");
      expect(ideaTransition).toHaveBeenCalledWith(id, "p-1", "ACTIVE");
      expect(ideaTransition).toHaveBeenCalledWith(id, "p-1", "MEASURING");
    }
    expect(ideaTransition).toHaveBeenCalledTimes(8);

    expect(creativeTransition).toHaveBeenCalledWith(
      "creative-Idea a",
      "p-1",
      "IN_REVIEW",
    );
    expect(creativeTransition).toHaveBeenCalledWith(
      "creative-Idea a",
      "p-1",
      "APPROVED",
    );
    expect(approvalCreate).not.toHaveBeenCalled();
  });

  it("skips a failed image generation without consuming that idea, and continues the batch", async () => {
    ideaFindMany.mockResolvedValueOnce([idea("fails"), idea("ok")]);
    generateCreativeImage
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(generatedImage("ok"));

    const result = await planWeeklyInstagramContent(SCOPE, 3);

    expect(result.imagesFailed).toBe(1);
    expect(result.imagesGenerated).toBe(1);
    expect(ideaTransition).not.toHaveBeenCalledWith("fails", "p-1", "APPROVED");
    expect(ideaTransition).toHaveBeenCalledWith("ok", "p-1", "APPROVED");
    expect(ideaTransition).toHaveBeenCalledTimes(4);
  });

  it("distributes generated posts across days honoring the daily image cap", async () => {
    ideaFindMany.mockResolvedValueOnce([idea("a"), idea("b"), idea("c")]);
    generateCreativeImage
      .mockResolvedValueOnce(generatedImage("a"))
      .mockResolvedValueOnce(generatedImage("b"))
      .mockResolvedValueOnce(generatedImage("c"));
    scheduleFindMany.mockResolvedValueOnce([]);

    const result = await planWeeklyInstagramContent(SCOPE, 2);

    expect(result.scheduled).toBe(3);
    expect(setScheduledFor).toHaveBeenCalledTimes(3);

    const dates = setScheduledFor.mock.calls.map((call) => call[2] as Date);
    // No configured publish slots -> falls back to the first two default
    // times, "09:00" and "13:00" (Europe/Istanbul, fixed UTC+3, no DST) —
    // 4 hours apart on the same day, then day 2's "09:00" slot 20 hours
    // after day 1's "13:00" slot.
    expect(dates[1]!.getTime() - dates[0]!.getTime()).toBe(4 * 3600_000);
    expect(dates[2]!.getTime() - dates[1]!.getTime()).toBe(20 * 3600_000);
  });

  it("writes a summary audit log entry", async () => {
    ideaFindMany.mockResolvedValueOnce([idea("a")]);
    generateCreativeImage.mockResolvedValueOnce(generatedImage("a"));

    await planWeeklyInstagramContent(SCOPE, 3);

    expect(auditRecord).toHaveBeenCalledTimes(1);
    const call = auditRecord.mock.calls[0]![0];
    expect(call.action).toBe("instagram_week_plan.completed");
    expect(call.metadata.imagesGenerated).toBe(1);
  });

  it("is a no-op when there are no shortlisted ideas", async () => {
    ideaFindMany.mockResolvedValueOnce([]);

    const result = await planWeeklyInstagramContent(SCOPE, 3);

    expect(result).toEqual({
      ideasConsidered: 0,
      imagesGenerated: 0,
      imagesFailed: 0,
      scheduled: 0,
      cappedForToday: false,
      pendingReview: 0,
      items: [],
    });
    expect(generateCreativeImage).not.toHaveBeenCalled();
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it("checks the project's daily cap before generating each image", async () => {
    ideaFindMany.mockResolvedValueOnce([idea("a")]);
    generateCreativeImage.mockResolvedValueOnce(generatedImage("a"));

    await planWeeklyInstagramContent(SCOPE, 3);

    expect(checkAndIncrement).toHaveBeenCalledWith(SCOPE, "tasksCreated", 1);
  });

  it("stops the batch early (without burning the rest of the ideas) once the daily cap is hit, and marks cappedForToday", async () => {
    const { AgentelseError } = await import("@/server/security/errors");
    ideaFindMany.mockResolvedValueOnce([idea("a"), idea("b"), idea("c")]);
    generateCreativeImage.mockResolvedValueOnce(generatedImage("a"));
    checkAndIncrement
      .mockResolvedValueOnce(undefined) // idea "a" — allowed
      .mockRejectedValueOnce(
        new AgentelseError(
          "BUDGET_EXCEEDED",
          "Daily cap maxTasksPerDay exceeded",
        ),
      ); // idea "b" — capped

    const result = await planWeeklyInstagramContent(SCOPE, 3);

    expect(result.imagesGenerated).toBe(1);
    expect(result.cappedForToday).toBe(true);
    expect(result.imagesFailed).toBe(0); // a cap hit isn't counted as a failure
    expect(generateCreativeImage).toHaveBeenCalledTimes(1); // idea "c" never attempted
    expect(checkAndIncrement).toHaveBeenCalledTimes(2);
  });
});

describe("planWeeklyInstagramContent — AutopilotMode", () => {
  it("REVIEW_EVERYTHING: creative stays IN_REVIEW, gets an Approval, and is NOT auto-scheduled", async () => {
    getOrCreate.mockResolvedValue({ autopilotMode: "REVIEW_EVERYTHING" });
    ideaFindMany.mockResolvedValueOnce([idea("a")]);
    generateCreativeImage.mockResolvedValueOnce(generatedImage("a"));

    const result = await planWeeklyInstagramContent(SCOPE, 3);

    expect(result.pendingReview).toBe(1);
    expect(result.scheduled).toBe(0);
    expect(setScheduledFor).not.toHaveBeenCalled();
    expect(creativeTransition).toHaveBeenCalledWith(
      "creative-Idea a",
      "p-1",
      "IN_REVIEW",
    );
    expect(creativeTransition).not.toHaveBeenCalledWith(
      "creative-Idea a",
      "p-1",
      "APPROVED",
    );
    expect(approvalCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "Creative",
        entityId: "creative-Idea a",
        type: "CREATIVE_APPROVAL",
      }),
    );
    // The idea itself is still fully consumed either way — only the
    // Creative's approval/scheduling is gated, not the idea-pipeline
    // hand-off.
    expect(ideaTransition).toHaveBeenCalledWith("a", "p-1", "MEASURING");
  });

  it("CREATE_AUTOMATICALLY: creative stays IN_REVIEW (needs an Approve click) but IS pre-scheduled", async () => {
    getOrCreate.mockResolvedValue({ autopilotMode: "CREATE_AUTOMATICALLY" });
    ideaFindMany.mockResolvedValueOnce([idea("a")]);
    generateCreativeImage.mockResolvedValueOnce(generatedImage("a"));

    const result = await planWeeklyInstagramContent(SCOPE, 3);

    expect(result.pendingReview).toBe(1);
    expect(result.scheduled).toBe(1);
    expect(setScheduledFor).toHaveBeenCalledWith(
      "creative-Idea a",
      "p-1",
      expect.any(Date),
    );
    expect(creativeTransition).not.toHaveBeenCalledWith(
      "creative-Idea a",
      "p-1",
      "APPROVED",
    );
  });

  it("AUTOPILOT (default): unchanged — auto-approved and scheduled, no Approval created", async () => {
    ideaFindMany.mockResolvedValueOnce([idea("a")]);
    generateCreativeImage.mockResolvedValueOnce(generatedImage("a"));

    const result = await planWeeklyInstagramContent(SCOPE, 3);

    expect(result.pendingReview).toBe(0);
    expect(result.scheduled).toBe(1);
    expect(creativeTransition).toHaveBeenCalledWith(
      "creative-Idea a",
      "p-1",
      "APPROVED",
    );
    expect(approvalCreate).not.toHaveBeenCalled();
  });
});

describe("planWeeklyInstagramContent — brand-safety claim check", () => {
  it("routes a flagged creative to human review even in AUTOPILOT mode", async () => {
    ideaFindMany.mockResolvedValueOnce([idea("a")]);
    generateCreativeImage.mockResolvedValueOnce(generatedImage("a"));
    reasoningRun.mockResolvedValueOnce({
      output: { safe: false, reason: "Claims same-day delivery" },
    });

    const result = await planWeeklyInstagramContent(SCOPE, 3);

    expect(result.pendingReview).toBe(1);
    expect(creativeTransition).not.toHaveBeenCalledWith(
      "creative-Idea a",
      "p-1",
      "APPROVED",
    );
    expect(approvalCreate).toHaveBeenCalledOnce();
  });

  it("fails open (treats as safe) when the claim check itself errors, instead of blocking the batch", async () => {
    ideaFindMany.mockResolvedValueOnce([idea("a")]);
    generateCreativeImage.mockResolvedValueOnce(generatedImage("a"));
    reasoningRun.mockRejectedValueOnce(new Error("provider unavailable"));

    const result = await planWeeklyInstagramContent(SCOPE, 3);

    expect(result.imagesGenerated).toBe(1);
    expect(result.pendingReview).toBe(0);
    expect(creativeTransition).toHaveBeenCalledWith(
      "creative-Idea a",
      "p-1",
      "APPROVED",
    );
  });

  it("passes the brand's approvedClaims/negativeRules from BrandTwin into the check", async () => {
    getBrandTwin.mockResolvedValue({
      approvedClaims: ["Wholesale from Turkey"],
      negativeRules: ["Never claim same-day delivery"],
    });
    ideaFindMany.mockResolvedValueOnce([idea("a")]);
    generateCreativeImage.mockResolvedValueOnce(generatedImage("a"));

    await planWeeklyInstagramContent(SCOPE, 3);

    expect(reasoningRun).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        context: expect.objectContaining({
          approvedClaims: ["Wholesale from Turkey"],
          negativeRules: ["Never claim same-day delivery"],
        }),
      }),
    );
  });
});

describe("planWeeklyInstagramContent — chat messages", () => {
  // Single-chat consolidation (docs/brand-workspace-migration.md): unlike
  // every other creative-generation path, this batch previously posted
  // NOTHING to chat at all — the generated creative was only ever visible
  // by navigating to the idea directly.
  it("posts a creative-ready card into the idea's spot in the single chat for each generated idea", async () => {
    ideaFindMany.mockResolvedValueOnce([idea("a")]);
    generateCreativeImage.mockResolvedValueOnce(generatedImage("a"));

    await planWeeklyInstagramContent(SCOPE, 3);

    expect(postSystemMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        ideaId: "a",
        card: expect.objectContaining({
          kind: "creative-ready",
          title: "Idea a",
          creativeId: "creative-Idea a",
          status: "APPROVED",
          versionNumber: 1,
          brandName: "Acme",
        }),
      }),
    );
  });

  it("posts a project-wide summary message (ideaId: null) once the batch finishes", async () => {
    ideaFindMany.mockResolvedValueOnce([idea("a"), idea("b")]);
    generateCreativeImage
      .mockResolvedValueOnce(generatedImage("a"))
      .mockResolvedValueOnce(null);

    await planWeeklyInstagramContent(SCOPE, 3);

    expect(postSystemMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        ideaId: null,
        text: expect.stringContaining("1/2 created"),
      }),
    );
  });

  it("skips the summary message when the chat-triggered caller already shows it as the direct reply", async () => {
    ideaFindMany.mockResolvedValueOnce([idea("a")]);
    generateCreativeImage.mockResolvedValueOnce(generatedImage("a"));

    await planWeeklyInstagramContent(SCOPE, 3, { skipSummaryMessage: true });

    // The per-idea card still posts — only the redundant final summary is
    // suppressed (see command-service.ts's CREATE_CONTENT_PLAN branch).
    expect(postSystemMessage).toHaveBeenCalledWith(
      expect.objectContaining({ ideaId: "a" }),
    );
    expect(postSystemMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ ideaId: null }),
    );
  });
});

describe("selectIdeasForWeek — content mix", () => {
  function scored(id: string, nbaScore: number, lens: string | null = null) {
    return idea(id, { nbaScore, lens });
  }

  it("with no mix, behaves exactly like plain nbaScore-desc ordering (original behavior)", () => {
    const candidates = [
      scored("low", 0.2),
      scored("high", 0.9),
      scored("mid", 0.5),
    ];

    const result = selectIdeasForWeek(candidates as never, 2);

    expect(result.map((i) => i.id)).toEqual(["high", "mid"]);
  });

  it("respects per-lens quota proportional to weight", () => {
    const candidates = [
      scored("p1", 0.9, "PRODUCT"),
      scored("p2", 0.8, "PRODUCT"),
      scored("p3", 0.7, "PRODUCT"),
      scored("b1", 0.6, "BRAND"),
      scored("b2", 0.5, "BRAND"),
    ];

    // 4 slots, PRODUCT:BRAND = 3:1 -> 3 product, 1 brand.
    const result = selectIdeasForWeek(candidates as never, 4, {
      PRODUCT: 3,
      BRAND: 1,
    });

    expect(result.filter((i) => i.lens === "PRODUCT")).toHaveLength(3);
    expect(result.filter((i) => i.lens === "BRAND")).toHaveLength(1);
    expect(result.map((i) => i.id)).toContain("p1");
    expect(result.map((i) => i.id)).toContain("p2");
    expect(result.map((i) => i.id)).toContain("p3");
    expect(result.map((i) => i.id)).toContain("b1"); // best-scored BRAND, not b2
  });

  it("backfills from any lens when a quota can't be filled, instead of leaving slots idle", () => {
    const candidates = [
      scored("p1", 0.9, "PRODUCT"),
      scored("b1", 0.8, "BRAND"),
      scored("b2", 0.7, "BRAND"),
      scored("b3", 0.6, "BRAND"),
    ];

    // Wants 2 PRODUCT + 2 BRAND, but only 1 PRODUCT idea exists — the
    // second PRODUCT slot backfills from BRAND's surplus instead of
    // shipping only 3 ideas for a 4-slot week.
    const result = selectIdeasForWeek(candidates as never, 4, {
      PRODUCT: 2,
      BRAND: 2,
    });

    expect(result).toHaveLength(4);
    expect(result.map((i) => i.id).sort()).toEqual(["b1", "b2", "b3", "p1"]);
  });

  it("ignores zero/negative weights as if that lens weren't in the mix", () => {
    const candidates = [
      scored("p1", 0.9, "PRODUCT"),
      scored("b1", 0.8, "BRAND"),
    ];

    const result = selectIdeasForWeek(candidates as never, 2, {
      PRODUCT: 1,
      BRAND: 0,
    });

    expect(result.map((i) => i.id).sort()).toEqual(["b1", "p1"]);
  });
});

// The planner used to make every post from the bare idea text and add no logo
// or colour bar at all. It now reads the brand's look once per batch, lets the
// brand's post layout decide where the logo / bar go, and stays best-effort:
// nothing about the brand's look may cost a post.
describe("planWeeklyInstagramContent — brand look and post layouts", () => {
  const brandWithLayouts = async () => {
    const { DEFAULT_KIT_TEMPLATE } = await import("@/lib/brand-kit");
    const { buildPresetLayouts } = await import("@/lib/layout-templates");
    return {
      logoAssetId: "logo-light",
      darkLogoAssetId: null,
      legacyApprovedColors: null,
      legacyVisualGuidelines: null,
      visualIdentity: {
        primaryColors: [{ hex: "#0b1f3a" }],
        secondaryColors: [{ hex: "#0d9488" }],
        accentColors: [{ hex: "#2dd4bf" }],
        photographyStyle: null,
        styleRefinement: null,
        moodTags: [],
        compositionNotes: null,
        backgroundTone: null,
        alwaysInclude: [],
        alwaysAvoid: [],
        referenceImageAssetId: null,
        layoutTemplates: buildPresetLayouts(DEFAULT_KIT_TEMPLATE),
        template: { ...DEFAULT_KIT_TEMPLATE },
      },
    };
  };

  it("builds the prompt from the brand's identity and lays the post out with its default layout", async () => {
    resolveBrandStyleContext.mockResolvedValue(await brandWithLayouts());
    ideaFindMany.mockResolvedValueOnce([idea("a")]);
    generateCreativeImage.mockResolvedValueOnce(generatedImage("a"));

    const result = await planWeeklyInstagramContent(SCOPE, 3);
    expect(result.imagesGenerated).toBe(1);

    const prompt = generateCreativeImage.mock.calls[0]![0] as string;
    expect(prompt).toContain("Idea a: Description a");
    expect(prompt).toContain("#0b1f3a"); // the brand's palette, not the model's
    expect(prompt).toContain("thin band along the bottom edge"); // areas the bar will cover

    expect(applyBrandTemplate).toHaveBeenCalledTimes(1);
    expect(applyBrandTemplate.mock.calls[0]![0]).toMatchObject({
      storageKey: "mock://a",
      lightLogoAssetId: "logo-light",
      template: { enabled: true, logoPosition: "BOTTOM_RIGHT", accentBarEnabled: true },
      trimLogo: true,
    });

    expect(creativeAddVersion).toHaveBeenCalledWith(
      "creative-Idea a",
      "p-1",
      expect.objectContaining({
        generationMetadata: expect.objectContaining({
          source: "auto_weekly_plan",
          layoutTemplate: { id: "classic", name: "Classic" },
        }),
      }),
    );
  });

  it("uses the size the compositing produced", async () => {
    resolveBrandStyleContext.mockResolvedValue(await brandWithLayouts());
    applyBrandTemplate.mockResolvedValue({ size: 4321 });
    ideaFindMany.mockResolvedValueOnce([idea("a")]);
    generateCreativeImage.mockResolvedValueOnce(generatedImage("a"));

    await planWeeklyInstagramContent(SCOPE, 3);

    expect(assetCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ size: 4321 }),
    });
  });

  describe("the words of the post", () => {
    const WORDS = {
      headline: "Sonbahar menüsü sofrada, sıra sizde",
      highlight: "sıra sizde",
      cta: "Masa ayırt",
    };
    const setUp = () => {
      // No saved layouts: the automatic design, which has a headline zone.
      resolveBrandStyleContext.mockResolvedValue(BARE_BRAND_STYLE);
      ideaFindMany.mockResolvedValueOnce([idea("a")]);
      generateCreativeImage.mockResolvedValueOnce(generatedImage("a"));
    };

    it("writes them for the brand and the room, keeps the picture textless and typesets them", async () => {
      setUp();
      writeOnImageText.mockResolvedValue(WORDS);
      applyBrandTemplate.mockResolvedValue({ size: 5, textDrawn: true });

      await planWeeklyInstagramContent(SCOPE, 3);

      const call = writeOnImageText.mock.calls[0]![0];
      expect(call.brief).toBe("Idea a: Description a");
      expect(call.budget.maxChars).toBeGreaterThan(24);
      const prompt = generateCreativeImage.mock.calls[0]![0] as string;
      expect(prompt).toContain("typeset onto the image afterwards");
      expect(applyBrandTemplate.mock.calls[0]![0].text).toMatchObject({
        ...WORDS,
        placement: { zone: expect.any(String) },
      });
      expect(creativeAddVersion).toHaveBeenCalledWith(
        "creative-Idea a",
        "p-1",
        expect.objectContaining({
          generationMetadata: expect.objectContaining({ onImageText: WORDS }),
        }),
      );
    });

    it("leaves a clean picture when the copywriter cannot deliver", async () => {
      setUp();
      writeOnImageText.mockResolvedValue(null);

      const result = await planWeeklyInstagramContent(SCOPE, 3);

      expect(result.imagesGenerated).toBe(1);
      expect(generateCreativeImage.mock.calls[0]![0]).not.toContain(
        "typeset onto the image afterwards",
      );
      expect(applyBrandTemplate.mock.calls[0]![0].text).toBeUndefined();
    });

    it("does not ask for words a layout has no place for", async () => {
      resolveBrandStyleContext.mockResolvedValue(await brandWithLayouts());
      ideaFindMany.mockResolvedValueOnce([idea("a")]);
      generateCreativeImage.mockResolvedValueOnce(generatedImage("a"));

      await planWeeklyInstagramContent(SCOPE, 3);

      expect(writeOnImageText).not.toHaveBeenCalled();
    });
  });

  describe("the picture direction", () => {
    const direction = {
      concept: "A table laid for an autumn menu",
      subject: "A rustic table with three plated autumn dishes",
      setting: "A small family restaurant at golden hour",
      composition: "High three-quarter angle, dishes in the lower half",
      lighting: "Warm low sun through a side window",
      technique: "50mm lens at f/2.8",
      texture: "Steam, crumbs and a creased linen napkin",
      mood: "Warm and generous",
      avoid: ["stock-photo smiles"],
    };

    it("makes the picture from the director's scene for the idea and the brand", async () => {
      ideaFindMany.mockResolvedValueOnce([idea("a")]);
      generateCreativeImage.mockResolvedValueOnce(generatedImage("a"));
      directImage.mockResolvedValue(direction);

      await planWeeklyInstagramContent(SCOPE, 3);

      const call = directImage.mock.calls[0]![0];
      expect(call.brief).toBe("Idea a: Description a");
      expect(call.platformLabel).toBeTruthy();
      const prompt = generateCreativeImage.mock.calls[0]![0] as string;
      expect(prompt).toContain("SUBJECT: A rustic table with three plated autumn dishes.");
      expect(prompt).toContain("For this picture: stock-photo smiles.");
      expect(creativeAddVersion).toHaveBeenCalledWith(
        "creative-Idea a",
        "p-1",
        expect.objectContaining({
          generationMetadata: expect.objectContaining({
            artConcept: "A table laid for an autumn menu",
          }),
        }),
      );
    });

    it("falls back to the idea itself when the director cannot answer", async () => {
      ideaFindMany.mockResolvedValueOnce([idea("a")]);
      generateCreativeImage.mockResolvedValueOnce(generatedImage("a"));
      directImage.mockResolvedValue(null);

      await planWeeklyInstagramContent(SCOPE, 3);

      expect(generateCreativeImage.mock.calls[0]![0]).toContain(
        "SUBJECT: Idea a: Description a",
      );
    });
  });

  it("makes the post from the idea alone when the brand's look cannot be read", async () => {
    resolveBrandStyleContext.mockRejectedValue(new Error("db blip"));
    ideaFindMany.mockResolvedValueOnce([idea("a")]);
    generateCreativeImage.mockResolvedValueOnce(generatedImage("a"));

    const result = await planWeeklyInstagramContent(SCOPE, 3);

    expect(result.imagesGenerated).toBe(1);
    expect(generateCreativeImage.mock.calls[0]![0]).toBe("Idea a: Description a");
    expect(applyBrandTemplate).not.toHaveBeenCalled();
    expect(creativeAddVersion).toHaveBeenCalledWith(
      "creative-Idea a",
      "p-1",
      expect.objectContaining({
        generationMetadata: expect.objectContaining({ layoutTemplate: null }),
      }),
    );
  });

  it("keeps the post when compositing the logo fails", async () => {
    resolveBrandStyleContext.mockResolvedValue(await brandWithLayouts());
    applyBrandTemplate.mockRejectedValue(new Error("sharp exploded"));
    ideaFindMany.mockResolvedValueOnce([idea("a")]);
    generateCreativeImage.mockResolvedValueOnce(generatedImage("a"));

    const result = await planWeeklyInstagramContent(SCOPE, 3);

    expect(result.imagesGenerated).toBe(1);
    expect(result.imagesFailed).toBe(0);
    expect(ideaTransition).toHaveBeenCalledWith("a", "p-1", "MEASURING");
  });
});

describe("planWeeklyInstagramContent plan allowance", () => {
  const outOfCredits = () =>
    new AgentelseError("QUOTA_EXCEEDED", "Plan allowance used up", {
      meta: { unit: "IMAGE" },
    });

  it("holds one image right per post, before anything is paid for, and charges it once the post is stored", async () => {
    ideaFindMany.mockResolvedValueOnce([idea("a"), idea("b")]);
    generateCreativeImage
      .mockResolvedValueOnce(generatedImage("a"))
      .mockResolvedValueOnce(generatedImage("b"));

    await planWeeklyInstagramContent(SCOPE, 3);

    expect(beginOperation).toHaveBeenCalledTimes(2);
    expect(beginOperation.mock.calls[0]![0]).toMatchObject({
      workspaceId: "w-1",
      projectId: "p-1",
      module: "SOCIAL",
      operationId: "week:a",
      reserve: { IMAGE: 1 },
      requireAccess: true,
    });
    expect(hold.finish).toHaveBeenCalledTimes(2);
    expect(hold.finish).toHaveBeenNthCalledWith(1, "delivered");
    expect(hold.finish).toHaveBeenNthCalledWith(2, "delivered");
  });

  it("hands the right back for a post whose picture could not be made", async () => {
    ideaFindMany.mockResolvedValueOnce([idea("fails"), idea("ok")]);
    generateCreativeImage
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(generatedImage("ok"));

    await planWeeklyInstagramContent(SCOPE, 3);

    expect(hold.finish).toHaveBeenNthCalledWith(1, "failed");
    expect(hold.finish).toHaveBeenNthCalledWith(2, "delivered");
  });

  it("hands the right back when the work blows up before the post is stored", async () => {
    ideaFindMany.mockResolvedValueOnce([idea("a")]);
    generateCreativeImage.mockResolvedValueOnce(generatedImage("a"));
    assetCreate.mockRejectedValueOnce(new Error("storage down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await planWeeklyInstagramContent(SCOPE, 3);

    expect(result.imagesFailed).toBe(1);
    expect(hold.finish).toHaveBeenCalledWith("aborted");
    spy.mockRestore();
  });

  it("ends the batch when the credits run out, like the daily cap, and leaves the rest of the ideas alone", async () => {
    ideaFindMany.mockResolvedValueOnce([idea("a"), idea("b"), idea("c")]);
    generateCreativeImage.mockResolvedValueOnce(generatedImage("a"));
    beginOperation
      .mockResolvedValueOnce(hold)
      .mockRejectedValueOnce(outOfCredits());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await planWeeklyInstagramContent(SCOPE, 3);

    expect(result.imagesGenerated).toBe(1);
    expect(result.cappedForToday).toBe(true);
    // Nothing was drawn or consumed for the refused post or those after it.
    expect(generateCreativeImage).toHaveBeenCalledTimes(1);
    expect(ideaTransition).not.toHaveBeenCalledWith("b", "p-1", "APPROVED");
    expect(ideaTransition).not.toHaveBeenCalledWith("c", "p-1", "APPROVED");
    // The refused post did not use up the day's task count either.
    expect(checkAndIncrement).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
