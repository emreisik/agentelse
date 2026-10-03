import { beforeEach, describe, expect, it, vi } from "vitest";

// Brand Memory is where a stray sentence could turn into a lasting rule, so
// this suite is about what is allowed in and how it is labelled: every memory
// has a source and a confidence, the same memory is stored once, the client's
// own words override reactions and never the other way round, an AI guess is
// never strengthened by repeating itself, and recall returns what matters for
// the message at hand.

const learning = {
  findFirst: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  deleteMany: vi.fn(),
};
const userDecision = { findMany: vi.fn() };
const creative = { findFirst: vi.fn() };
vi.mock("@/lib/prisma", () => ({
  prisma: { brandLearning: learning, userDecision, creative },
}));

const { MemoryService, cleanInsight } = await import("./memory-service");

const scope = { workspaceId: "ws-1", projectId: "proj-1", brandId: "brand-1" };

const row = (overrides: Record<string, unknown> = {}) => ({
  id: "l1",
  insight: "Never use neon colours",
  polarity: "AVOID",
  sourceType: "USER_EXPLICIT",
  sourceRef: null,
  confidence: 0.95,
  evidenceCount: 1,
  lastReinforcedAt: new Date("2026-09-30T10:00:00Z"),
  createdAt: new Date("2026-09-01T10:00:00Z"),
  ...overrides,
});

beforeEach(() => {
  vi.resetAllMocks();
  learning.findFirst.mockResolvedValue(null);
  learning.findMany.mockResolvedValue([]);
  learning.create.mockResolvedValue({ id: "new-1" });
  learning.update.mockResolvedValue({});
  learning.deleteMany.mockResolvedValue({ count: 0 });
  userDecision.findMany.mockResolvedValue([]);
  creative.findFirst.mockResolvedValue(null);
});

describe("cleanInsight", () => {
  it("flattens whitespace and strips control characters", () => {
    expect(cleanInsight("  Never\tuse \n neon\u0000\u0007 colours  ")).toBe(
      "Never use neon colours",
    );
  });

  it("cuts a very long text and marks the cut", () => {
    const out = cleanInsight("x".repeat(1_000));
    expect(out).toHaveLength(301);
    expect(out.endsWith("…")).toBe(true);
  });

  it("returns an empty string for nothing", () => {
    expect(cleanInsight("  \n\t ")).toBe("");
  });
});

describe("MemoryService.remember", () => {
  it("stores a new memory with its source, a confidence that matches the source, and one observation", async () => {
    const result = await MemoryService.remember({
      scope,
      insight: "  Never use neon colours ",
      polarity: "AVOID",
      source: "USER_EXPLICIT",
      sourceRef: "decision-1",
    });

    expect(result).toEqual({ status: "CREATED", id: "new-1", superseded: 0 });
    expect(learning.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ...scope,
        insight: "Never use neon colours",
        polarity: "AVOID",
        sourceType: "USER_EXPLICIT",
        sourceRef: "decision-1",
        confidence: 0.95,
        evidenceCount: 1,
        lastReinforcedAt: expect.any(Date),
      }),
    });
  });

  it.each([
    ["USER_EXPLICIT", 0.95],
    ["USER_CORRECTION", 0.6],
    ["OUTPUT_ACCEPTED", 0.5],
    ["OUTPUT_REJECTED", 0.5],
    ["AI_INFERRED", 0.3],
  ] as const)("starts a %s memory at confidence %s", async (source, confidence) => {
    await MemoryService.remember({
      scope,
      insight: "Some observation",
      polarity: "WORKS",
      source,
    });

    expect(learning.create.mock.calls[0]![0].data.confidence).toBe(confidence);
  });

  it("takes a confidence the caller gives over the default", async () => {
    await MemoryService.remember({
      scope,
      insight: "Some observation",
      polarity: "WORKS",
      source: "OUTPUT_ACCEPTED",
      confidence: 0.8,
    });

    expect(learning.create.mock.calls[0]![0].data.confidence).toBe(0.8);
  });

  it("refuses an empty memory", async () => {
    await expect(
      MemoryService.remember({
        scope,
        insight: " \n ",
        polarity: "WORKS",
        source: "USER_EXPLICIT",
      }),
    ).resolves.toEqual({ status: "REJECTED", superseded: 0 });
    expect(learning.create).not.toHaveBeenCalled();
    expect(learning.deleteMany).not.toHaveBeenCalled();
  });

  it("stores the same memory once: seeing it again reinforces it", async () => {
    learning.findFirst.mockResolvedValue(row({ sourceType: "OUTPUT_ACCEPTED", confidence: 0.5 }));

    const result = await MemoryService.remember({
      scope,
      insight: "never use NEON colours",
      polarity: "AVOID",
      source: "OUTPUT_ACCEPTED",
    });

    expect(result).toEqual({ status: "REINFORCED", id: "l1", superseded: 0 });
    expect(learning.create).not.toHaveBeenCalled();
    expect(learning.update).toHaveBeenCalledWith({
      where: { id: "l1" },
      data: {
        evidenceCount: { increment: 1 },
        lastReinforcedAt: expect.any(Date),
        confidence: 0.5,
      },
    });
    // Matched case-insensitively, on this brand and polarity.
    expect(learning.findFirst.mock.calls[0]![0].where).toEqual({
      brandId: "brand-1",
      polarity: "AVOID",
      insight: { equals: "never use NEON colours", mode: "insensitive" },
    });
  });

  it("relabels a memory with the stronger source when the client later says it themselves", async () => {
    learning.findFirst.mockResolvedValue(
      row({ sourceType: "OUTPUT_REJECTED", confidence: 0.5 }),
    );

    await MemoryService.remember({
      scope,
      insight: "Never use neon colours",
      polarity: "AVOID",
      source: "USER_EXPLICIT",
    });

    expect(learning.update.mock.calls[0]![0].data).toMatchObject({
      sourceType: "USER_EXPLICIT",
      confidence: 0.95,
    });
  });

  it("never downgrades the source or the confidence of a memory the client stated", async () => {
    learning.findFirst.mockResolvedValue(
      row({ sourceType: "USER_EXPLICIT", confidence: 0.95 }),
    );

    await MemoryService.remember({
      scope,
      insight: "Never use neon colours",
      polarity: "AVOID",
      source: "OUTPUT_REJECTED",
    });

    const data = learning.update.mock.calls[0]![0].data;
    expect(data).not.toHaveProperty("sourceType");
    expect(data.confidence).toBe(0.95);
    expect(data.evidenceCount).toEqual({ increment: 1 });
  });

  it("does not let an AI guess strengthen anything by repeating itself", async () => {
    learning.findFirst.mockResolvedValue(row({ sourceType: "AI_INFERRED", confidence: 0.3 }));

    const result = await MemoryService.remember({
      scope,
      insight: "Never use neon colours",
      polarity: "AVOID",
      source: "AI_INFERRED",
    });

    expect(result).toEqual({ status: "UNCHANGED", id: "l1", superseded: 0 });
    expect(learning.update).not.toHaveBeenCalled();
    expect(learning.create).not.toHaveBeenCalled();
  });

  it("does not let an AI guess add to a memory the client stated either", async () => {
    learning.findFirst.mockResolvedValue(row({ sourceType: "USER_EXPLICIT" }));

    const result = await MemoryService.remember({
      scope,
      insight: "Never use neon colours",
      polarity: "AVOID",
      source: "AI_INFERRED",
    });

    expect(result.status).toBe("UNCHANGED");
    expect(learning.update).not.toHaveBeenCalled();
  });

  it("lets a stronger source take over an AI guess", async () => {
    learning.findFirst.mockResolvedValue(row({ sourceType: "AI_INFERRED", confidence: 0.3 }));

    await MemoryService.remember({
      scope,
      insight: "Never use neon colours",
      polarity: "AVOID",
      source: "USER_EXPLICIT",
    });

    expect(learning.update.mock.calls[0]![0].data).toMatchObject({
      sourceType: "USER_EXPLICIT",
      confidence: 0.95,
    });
  });

  it("relabels an older machine-written memory with a source that outranks it, without lowering its confidence", async () => {
    learning.findFirst.mockResolvedValue(
      row({ sourceType: "MEASUREMENT_PLAN", confidence: 0.7 }),
    );

    await MemoryService.remember({
      scope,
      insight: "Never use neon colours",
      polarity: "AVOID",
      source: "OUTPUT_REJECTED",
    });

    expect(learning.update.mock.calls[0]![0].data.sourceType).toBe("OUTPUT_REJECTED");
    expect(learning.update.mock.calls[0]![0].data.confidence).toBe(0.7);
  });

  describe("when the client contradicts what is on record", () => {
    it.each(["USER_EXPLICIT", "USER_CORRECTION"] as const)(
      "%s replaces the opposite memory",
      async (source) => {
        learning.deleteMany.mockResolvedValue({ count: 1 });

        const result = await MemoryService.remember({
          scope,
          insight: "Neon colours",
          polarity: "AVOID",
          source,
        });

        expect(learning.deleteMany).toHaveBeenCalledWith({
          where: {
            brandId: "brand-1",
            polarity: "WORKS",
            insight: { equals: "Neon colours", mode: "insensitive" },
          },
        });
        expect(result.superseded).toBe(1);
      },
    );

    it.each(["OUTPUT_ACCEPTED", "OUTPUT_REJECTED", "AI_INFERRED"] as const)(
      "a %s reaction never overrides what the client said",
      async (source) => {
        await MemoryService.remember({
          scope,
          insight: "Neon colours",
          polarity: "WORKS",
          source,
        });

        expect(learning.deleteMany).not.toHaveBeenCalled();
      },
    );
  });
});

describe("MemoryService.rememberCreativeReaction", () => {
  const creativeRow = {
    title: "Autumn sale",
    channel: "instagram",
    formatKey: "instagram.post",
  };

  beforeEach(() => {
    creative.findFirst.mockResolvedValue(creativeRow);
  });

  it("records an approval as a tentative 'works' memory tied to the creative", async () => {
    await MemoryService.rememberCreativeReaction({
      scope,
      creativeId: "cr-1",
      outcome: "APPROVED",
    });

    expect(learning.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        insight: 'Client approved "Autumn sale" (instagram.post)',
        polarity: "WORKS",
        sourceType: "OUTPUT_ACCEPTED",
        sourceRef: "creative:cr-1",
        confidence: 0.5,
        evidenceCount: 1,
      }),
    });
  });

  it("records a rejection as a tentative 'avoid' memory", async () => {
    await MemoryService.rememberCreativeReaction({
      scope,
      creativeId: "cr-1",
      outcome: "REJECTED",
    });

    expect(learning.create.mock.calls[0]![0].data).toMatchObject({
      insight: 'Client rejected "Autumn sale" (instagram.post)',
      polarity: "AVOID",
      sourceType: "OUTPUT_REJECTED",
    });
  });

  it("records a revision request with what the client asked to change", async () => {
    await MemoryService.rememberCreativeReaction({
      scope,
      creativeId: "cr-1",
      outcome: "REVISION_REQUESTED",
      note: "  less busy background ",
    });

    expect(learning.create.mock.calls[0]![0].data).toMatchObject({
      insight: 'Client asked to change "Autumn sale" (instagram.post): less busy background',
      polarity: "AVOID",
      sourceType: "USER_CORRECTION",
      // A single revision is a hint, not a rule.
      confidence: 0.6,
      evidenceCount: 1,
    });
  });

  it("learns nothing from a revision request that says nothing", async () => {
    await expect(
      MemoryService.rememberCreativeReaction({
        scope,
        creativeId: "cr-1",
        outcome: "REVISION_REQUESTED",
        note: "   ",
      }),
    ).resolves.toBeNull();
    expect(learning.create).not.toHaveBeenCalled();
  });

  it("uses the channel when there is no format, and nothing when there is neither", async () => {
    creative.findFirst.mockResolvedValue({ title: "Post", channel: "instagram", formatKey: null });
    await MemoryService.rememberCreativeReaction({ scope, creativeId: "cr-1", outcome: "APPROVED" });
    expect(learning.create.mock.calls[0]![0].data.insight).toBe('Client approved "Post" (instagram)');

    creative.findFirst.mockResolvedValue({ title: "Post", channel: null, formatKey: null });
    await MemoryService.rememberCreativeReaction({ scope, creativeId: "cr-2", outcome: "APPROVED" });
    expect(learning.create.mock.calls[1]![0].data.insight).toBe('Client approved "Post"');
  });

  it("looks the creative up inside this project only", async () => {
    await MemoryService.rememberCreativeReaction({
      scope,
      creativeId: "cr-1",
      outcome: "APPROVED",
    });

    expect(creative.findFirst).toHaveBeenCalledWith({
      where: { id: "cr-1", projectId: "proj-1" },
      select: { title: true, channel: true, formatKey: true },
    });
  });

  it.each([
    ["it does not exist", null],
    ["it has no title", { title: null, channel: "instagram", formatKey: null }],
  ])("learns nothing when %s", async (_label, found) => {
    creative.findFirst.mockResolvedValue(found);

    await expect(
      MemoryService.rememberCreativeReaction({ scope, creativeId: "cr-1", outcome: "APPROVED" }),
    ).resolves.toBeNull();
    expect(learning.create).not.toHaveBeenCalled();
  });

  it("never throws, so it cannot break the decision it is learning from", async () => {
    creative.findFirst.mockRejectedValue(new Error("db down"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      MemoryService.rememberCreativeReaction({ scope, creativeId: "cr-1", outcome: "APPROVED" }),
    ).resolves.toBeNull();
  });
});

describe("MemoryService.rememberCreativeRating", () => {
  const creativeRow = {
    title: "Autumn sale",
    channel: "instagram",
    formatKey: "instagram.post",
    brief: "Hook: New\nVisual: A phone on pale blue",
    versions: [
      { generationMetadata: { layoutTemplate: { id: "l1", name: "Product hero" } } },
    ],
  };

  beforeEach(() => {
    creative.findFirst.mockResolvedValue(creativeRow);
  });

  it("records a like as a 'works' memory with what the post looked like", async () => {
    await MemoryService.rememberCreativeRating({
      scope,
      creativeId: "cr-1",
      rating: "LIKE",
    });

    expect(learning.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        insight:
          'Client liked "Autumn sale" (instagram.post) (visual: A phone on pale blue; layout: Product hero)',
        polarity: "WORKS",
        sourceType: "OUTPUT_ACCEPTED",
        sourceRef: "creative:cr-1:rating",
      }),
    });
  });

  it("records a dislike as an 'avoid' memory with the reasons the client ticked", async () => {
    await MemoryService.rememberCreativeRating({
      scope,
      creativeId: "cr-1",
      rating: "DISLIKE",
      reasons: ["product", "nonsense"],
      note: "  show it bigger ",
    });

    const data = learning.create.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      polarity: "AVOID",
      sourceType: "USER_CORRECTION",
      sourceRef: "creative:cr-1:rating",
    });
    expect(data.insight).toContain('Client did not like "Autumn sale"');
    expect(data.insight).toContain("the product is not shown right");
    expect(data.insight).not.toContain("nonsense");
    expect(data.insight.endsWith("show it bigger")).toBe(true);
  });

  it("replaces the previous verdict on the same post instead of piling up", async () => {
    await MemoryService.rememberCreativeRating({
      scope,
      creativeId: "cr-1",
      rating: "LIKE",
    });

    expect(learning.deleteMany).toHaveBeenCalledWith({
      where: { brandId: "brand-1", sourceRef: "creative:cr-1:rating" },
    });
    // The old verdict goes before the new one is written.
    expect(learning.deleteMany.mock.invocationCallOrder[0]!).toBeLessThan(
      learning.create.mock.invocationCallOrder[0]!,
    );
  });

  it("looks the post up inside this project only", async () => {
    await MemoryService.rememberCreativeRating({
      scope,
      creativeId: "cr-1",
      rating: "LIKE",
    });

    expect(creative.findFirst.mock.calls[0]![0].where).toEqual({
      id: "cr-1",
      projectId: "proj-1",
    });
  });

  it("works for a post made before layouts existed", async () => {
    creative.findFirst.mockResolvedValue({
      ...creativeRow,
      brief: null,
      versions: [{ generationMetadata: null }],
    });

    await MemoryService.rememberCreativeRating({
      scope,
      creativeId: "cr-1",
      rating: "LIKE",
    });

    expect(learning.create.mock.calls[0]![0].data.insight).toBe(
      'Client liked "Autumn sale" (instagram.post)',
    );
  });

  it.each([
    ["it does not exist", null],
    ["it has no title", { ...creativeRowOf(), title: null }],
  ])("learns nothing (and deletes nothing) when %s", async (_label, found) => {
    creative.findFirst.mockResolvedValue(found);

    await expect(
      MemoryService.rememberCreativeRating({ scope, creativeId: "cr-1", rating: "LIKE" }),
    ).resolves.toBeNull();
    expect(learning.create).not.toHaveBeenCalled();
    expect(learning.deleteMany).not.toHaveBeenCalled();
  });

  it("never throws, so it cannot break the tap it is learning from", async () => {
    creative.findFirst.mockRejectedValue(new Error("db down"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      MemoryService.rememberCreativeRating({ scope, creativeId: "cr-1", rating: "DISLIKE" }),
    ).resolves.toBeNull();
  });
});

function creativeRowOf() {
  return {
    title: "Autumn sale",
    channel: "instagram",
    formatKey: "instagram.post",
    brief: null,
    versions: [],
  };
}

describe("MemoryService.recall", () => {
  it("always brings back what the client explicitly said, whatever they ask", async () => {
    learning.findMany.mockResolvedValue([
      row({ id: "rule", insight: "Never use neon colours", sourceType: "USER_EXPLICIT" }),
    ]);

    const { standing, relevant } = await MemoryService.recall("brand-1", "make me a post");

    expect(standing.map((item) => item.text)).toEqual(["Never use neon colours"]);
    expect(relevant).toEqual([]);
  });

  it("only brings back a reaction when it matches what is being asked", async () => {
    learning.findMany.mockResolvedValue([
      row({
        id: "a",
        insight: 'Client approved "Autumn sale" (instagram.post)',
        polarity: "WORKS",
        sourceType: "OUTPUT_ACCEPTED",
        confidence: 0.5,
      }),
      row({
        id: "b",
        insight: 'Client approved "Spring launch" (instagram.story)',
        polarity: "WORKS",
        sourceType: "OUTPUT_ACCEPTED",
        confidence: 0.5,
      }),
    ]);

    const { relevant } = await MemoryService.recall("brand-1", "another autumn sale post");

    expect(relevant.map((item) => item.id)).toEqual(["a"]);
  });

  it("reads the stated decisions from before memories had a source, as the client's own words", async () => {
    userDecision.findMany.mockResolvedValue([
      {
        id: "d1",
        value: "premium_editorial",
        scope: "BRAND",
        createdAt: new Date("2026-08-01T10:00:00Z"),
      },
      {
        id: "d2",
        value: { market: "Germany" },
        scope: "CAMPAIGN",
        createdAt: new Date("2026-08-02T10:00:00Z"),
      },
    ]);

    const { standing } = await MemoryService.recall("brand-1", "");

    expect(standing.map((item) => [item.text, item.source])).toEqual([
      ['{"market":"Germany"} (CAMPAIGN)', "LEGACY_DECISION"],
      ["premium_editorial", "LEGACY_DECISION"],
    ]);
  });

  it("does not say a decision twice when it was also saved as a memory", async () => {
    learning.findMany.mockResolvedValue([
      row({ id: "l1", insight: "Premium editorial look", polarity: "WORKS", sourceRef: "d1" }),
    ]);
    userDecision.findMany.mockResolvedValue([
      { id: "d1", value: "premium_editorial", scope: "BRAND", createdAt: new Date() },
    ]);

    const { standing } = await MemoryService.recall("brand-1", "");

    expect(standing.map((item) => item.text)).toEqual(["Premium editorial look"]);
  });

  it("reads only this brand's memory, with bounded queries", async () => {
    await MemoryService.recall("brand-1", "anything");

    expect(learning.findMany).toHaveBeenCalledWith({
      where: { brandId: "brand-1" },
      orderBy: { createdAt: "desc" },
      take: 300,
    });
    expect(userDecision.findMany).toHaveBeenCalledWith({
      where: { brandId: "brand-1" },
      orderBy: { createdAt: "desc" },
      take: 60,
    });
  });

  it("marks a source it does not recognise as machine-written, never as the client's word", async () => {
    learning.findMany.mockResolvedValue([
      row({ id: "m", insight: "Video ads outperform static", sourceType: "MEASUREMENT_PLAN", confidence: 0.8, evidenceCount: 1 }),
    ]);

    const { standing, relevant } = await MemoryService.recall("brand-1", "video ads");

    expect(standing).toEqual([]);
    expect(relevant[0]).toMatchObject({ id: "m", source: "OTHER", seen: 1 });
  });
});
