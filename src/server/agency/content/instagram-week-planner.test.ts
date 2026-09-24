import { beforeEach, describe, expect, it, vi } from "vitest";

// The weekly auto-planner's two riskiest behaviors: (1) it must fully
// consume every idea it successfully turns into a post through the SAME
// IDEA_TRANSITIONS chain AgencyDirector.decideOnIdea uses, so the normal
// autonomous loop (which only ever looks at SHORTLISTED ideas) can never
// pick the same idea up a second time — and (2) a single failed image
// generation must not abort the rest of the week's batch (best-effort,
// same pattern as IdeaFoundry.generateForTopOpportunities), nor should the
// failed idea be consumed (it stays SHORTLISTED for next week's run).

const ideaFindMany = vi.fn();
const assetCreate = vi.fn();
const scheduleFindMany = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    idea: { findMany: ideaFindMany },
    asset: { create: assetCreate },
    projectSchedule: { findMany: scheduleFindMany },
  },
}));

const generateCreativeImage = vi.fn();
vi.mock("@/server/media/creative-image", () => ({
  generateCreativeImage,
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

const { planWeeklyInstagramContent } = await import("./instagram-week-planner");

const SCOPE = { workspaceId: "w-1", projectId: "p-1", brandId: "b-1" };

function idea(id: string) {
  return {
    id,
    title: `Idea ${id}`,
    description: `Description ${id}`,
    status: "SHORTLISTED",
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

beforeEach(() => {
  vi.clearAllMocks();
  scheduleFindMany.mockResolvedValue([]);
  creativeCreate.mockImplementation(async (input: { title?: string }) => ({
    id: `creative-${input.title}`,
  }));
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
    });
    expect(generateCreativeImage).not.toHaveBeenCalled();
    expect(auditRecord).not.toHaveBeenCalled();
  });
});
