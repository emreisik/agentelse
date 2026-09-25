import { beforeEach, describe, expect, it, vi } from "vitest";

const brandLearningFindFirst = vi.fn();
const brandLearningUpdate = vi.fn();
const brandLearningCreate = vi.fn();
const userDecisionCreate = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    brandLearning: {
      findFirst: brandLearningFindFirst,
      update: brandLearningUpdate,
      create: brandLearningCreate,
    },
    userDecision: { create: userDecisionCreate },
  },
}));

const { recordCreativeMemory, recordUserDecision } =
  await import("./brand-twin-writes");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("recordCreativeMemory", () => {
  it("creates a new learning row when no matching insight exists", async () => {
    brandLearningFindFirst.mockResolvedValueOnce(null);
    brandLearningCreate.mockResolvedValueOnce({ id: "learning-1" });

    await recordCreativeMemory({
      workspaceId: "ws-1",
      projectId: "proj-1",
      brandId: "brand-1",
      insight: "Editorial photography performs well",
      polarity: "WORKS",
      confidence: 0.6,
    });

    expect(brandLearningCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        insight: "Editorial photography performs well",
        polarity: "WORKS",
        confidence: 0.6,
      }),
    });
    expect(brandLearningUpdate).not.toHaveBeenCalled();
  });

  it("reinforces (increments evidenceCount) an exact-match existing insight instead of duplicating it", async () => {
    brandLearningFindFirst.mockResolvedValueOnce({
      id: "learning-1",
      confidence: 0.5,
    });
    brandLearningUpdate.mockResolvedValueOnce({ id: "learning-1" });

    await recordCreativeMemory({
      workspaceId: "ws-1",
      projectId: "proj-1",
      brandId: "brand-1",
      insight: "  Editorial photography performs well  ",
      polarity: "WORKS",
      confidence: 0.8,
    });

    expect(brandLearningCreate).not.toHaveBeenCalled();
    expect(brandLearningUpdate).toHaveBeenCalledWith({
      where: { id: "learning-1" },
      data: expect.objectContaining({
        evidenceCount: { increment: 1 },
        confidence: 0.8,
      }),
    });
  });

  it("never lowers an existing higher confidence on reinforcement", async () => {
    brandLearningFindFirst.mockResolvedValueOnce({
      id: "learning-1",
      confidence: 0.9,
    });
    brandLearningUpdate.mockResolvedValueOnce({ id: "learning-1" });

    await recordCreativeMemory({
      workspaceId: "ws-1",
      projectId: "proj-1",
      brandId: "brand-1",
      insight: "Editorial photography performs well",
      polarity: "WORKS",
      confidence: 0.3,
    });

    const call = brandLearningUpdate.mock.calls[0]![0];
    expect(call.data.confidence).toBeUndefined();
  });
});

describe("recordUserDecision", () => {
  it("stores the structured value alongside the raw message", async () => {
    userDecisionCreate.mockResolvedValueOnce({ id: "dec-1" });

    await recordUserDecision({
      workspaceId: "ws-1",
      projectId: "proj-1",
      brandId: "brand-1",
      type: "CREATIVE_PREFERENCE",
      scope: "BRAND",
      value: { preference: "premium_editorial" },
      rawMessage: "More premium.",
    });

    expect(userDecisionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "CREATIVE_PREFERENCE",
        scope: "BRAND",
        value: { preference: "premium_editorial" },
        rawMessage: "More premium.",
      }),
    });
  });
});
