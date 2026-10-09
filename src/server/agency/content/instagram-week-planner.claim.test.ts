import { beforeEach, describe, expect, it, vi } from "vitest";

// Weekly planner, claim check and the plan allowance: when the plan's AI
// allowance is spent the brand-safety check cannot run, and that is not a blip.
// Failing open (the old rule for a provider error) would auto-approve and
// schedule the whole week unchecked, so the post waits for a person instead.

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

const { planWeeklyInstagramContent } =
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

describe("planWeeklyInstagramContent — claim check when the plan allowance is spent", () => {
  const allowanceStop = () =>
    new AgentelseError("BUDGET_EXCEEDED", "Plan allowance used up", {
      meta: { limit: "planAllowance" },
    });

  async function planOne() {
    ideaFindMany.mockResolvedValueOnce([idea("a")]);
    generateCreativeImage.mockResolvedValueOnce(generatedImage("a"));
    return planWeeklyInstagramContent(SCOPE, 3);
  }

  it("sends the post to a person when the AI allowance stopped the check (AUTOPILOT)", async () => {
    reasoningRun.mockRejectedValueOnce(allowanceStop());

    const result = await planOne();

    // The picture was made and paid for; the post waits for review, not approval.
    expect(result.imagesGenerated).toBe(1);
    expect(result.pendingReview).toBe(1);
    expect(approvalCreate).toHaveBeenCalledOnce();
    expect(creativeTransition).not.toHaveBeenCalledWith(
      "creative-Idea a",
      "p-1",
      "APPROVED",
    );
  });

  it("does the same when the workspace has no plan at all", async () => {
    reasoningRun.mockRejectedValueOnce(
      new AgentelseError("BUDGET_EXCEEDED", "No plan", {
        meta: { limit: "noPlan" },
      }),
    );

    const result = await planOne();

    expect(result.pendingReview).toBe(1);
    expect(creativeTransition).not.toHaveBeenCalledWith(
      "creative-Idea a",
      "p-1",
      "APPROVED",
    );
  });

  it("still fails open for the project's DAILY call cap (it reopens tomorrow)", async () => {
    reasoningRun.mockRejectedValueOnce(
      new AgentelseError("BUDGET_EXCEEDED", "Daily cap", {
        meta: { limit: "reasoningCalls" },
      }),
    );

    const result = await planOne();

    expect(result.pendingReview).toBe(0);
    expect(creativeTransition).toHaveBeenCalledWith(
      "creative-Idea a",
      "p-1",
      "APPROVED",
    );
  });

  it("still fails open for an ordinary provider error", async () => {
    reasoningRun.mockRejectedValueOnce(new Error("provider unavailable"));

    const result = await planOne();

    expect(result.pendingReview).toBe(0);
    expect(creativeTransition).toHaveBeenCalledWith(
      "creative-Idea a",
      "p-1",
      "APPROVED",
    );
  });

  it("does not stop the rest of the batch: every post of the week waits for review", async () => {
    ideaFindMany.mockResolvedValueOnce([idea("a"), idea("b")]);
    generateCreativeImage
      .mockResolvedValueOnce(generatedImage("a"))
      .mockResolvedValueOnce(generatedImage("b"));
    reasoningRun.mockRejectedValue(allowanceStop());

    const result = await planWeeklyInstagramContent(SCOPE, 3);

    expect(result.imagesGenerated).toBe(2);
    expect(result.pendingReview).toBe(2);
    expect(approvalCreate).toHaveBeenCalledTimes(2);
  });
});
