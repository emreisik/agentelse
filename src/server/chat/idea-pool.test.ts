import { beforeEach, describe, expect, it, vi } from "vitest";

// What this suite proves: the chat sees the idea pool best first (put-forward
// ideas, then shortlisted, then the newest); a plan item keeps only an ideaId
// that names a real pool idea of the project, once; the plan card carries it
// as "From: Idea pool"; the model is told to plan from the pool; and saving
// marks the used ideas planned without one failure stopping the rest.

const idea = { findMany: vi.fn() };
vi.mock("@/lib/prisma", () => ({ prisma: { idea } }));
vi.mock("./card-store", () => ({ updateCommandCard: vi.fn() }));

const advanceForScheduling = vi.fn();
vi.mock("@/server/repositories/idea.repository", () => ({
  IdeaRepository: { advanceForScheduling },
}));

const {
  loadIdeaPoolForPrompt,
  poolAlternativesFor,
  poolIdeaIds,
  markIdeasPlanned,
} = await import("./idea-pool");
const { keepPoolIdeaIds, buildPlanCard } = await import("./content-plan");
const { worksNotes } = await import("./works-notes");

beforeEach(() => {
  vi.clearAllMocks();
  console.error = vi.fn();
});

const row = (id: string, status: string, description = "Why it works") => ({
  id,
  title: `Idea ${id}`,
  description,
  status,
});

describe("loadIdeaPoolForPrompt", () => {
  it("puts put-forward ideas first, then shortlisted, then the newest", async () => {
    idea.findMany.mockResolvedValue([
      row("raw-new", "RAW"),
      row("short", "SHORTLISTED"),
      row("raw-old", "RAW"),
      row("forward", "APPROVED"),
    ]);

    const pool = await loadIdeaPoolForPrompt("p1");

    expect(pool.map((entry) => entry.id)).toEqual([
      "forward",
      "short",
      "raw-new",
      "raw-old",
    ]);
    expect(pool[0]).toMatchObject({ putForward: true });
    expect(pool[1]).not.toHaveProperty("putForward");
  });

  it("keeps summaries short and never throws", async () => {
    idea.findMany.mockResolvedValue([row("a", "RAW", "x ".repeat(400))]);
    const [first] = await loadIdeaPoolForPrompt("p1");
    expect(first!.summary.length).toBeLessThanOrEqual(180);

    idea.findMany.mockRejectedValue(new Error("db down"));
    expect(await loadIdeaPoolForPrompt("p1")).toEqual([]);
  });
});

const post = (
  hook: string,
  extra: { strength?: number; channels?: string[]; expiresAt?: string } = {},
) => ({
  v: 2,
  module: "social",
  source: "brand",
  strength: extra.strength ?? 2,
  ...(extra.expiresAt ? { expiresAt: extra.expiresAt } : {}),
  why: "People ask for it.",
  draft: {
    hook,
    headline: "Cold mornings, warm cups",
    visual: "A latte on a wooden bar",
    caption: "Come by this week.",
    channels: extra.channels ?? ["instagram"],
  },
});

const typed = (id: string, status: string, concept: unknown) => ({
  ...row(id, status),
  concept,
});

describe("post ideas of the Ideas board in the pool", () => {
  it("ranks them after put-forward ideas, strongest first, and leaves out other modules and past ideas", async () => {
    idea.findMany.mockResolvedValue([
      row("short", "SHORTLISTED"),
      typed("weak", "VALIDATED", post("A weak one", { strength: 1 })),
      typed("seo", "VALIDATED", {
        v: 2,
        module: "seo",
        source: "search",
        strength: 3,
        draft: {
          keyword: "oat latte",
          intent: "informational",
          title: "Oat latte",
          description: "How",
          angle: "Ours",
        },
      }),
      typed(
        "past",
        "VALIDATED",
        post("Over already", { expiresAt: "2020-01-01T00:00:00.000Z" }),
      ),
      typed("strong", "VALIDATED", post("A strong one", { strength: 3 })),
      row("forward", "APPROVED"),
    ]);

    const pool = await loadIdeaPoolForPrompt("p1");

    expect(pool.map((entry) => entry.id)).toEqual([
      "forward",
      "strong",
      "weak",
      "short",
    ]);
    expect(pool[1]).toMatchObject({
      title: "A strong one",
      summary: "People ask for it.",
      captionIdea:
        '"Cold mornings, warm cups" | A latte on a wooden bar | Come by this week.',
      channels: ["instagram"],
    });
    expect(pool[3]).not.toHaveProperty("captionIdea");
  });

  it("offers a plan's post the unused ones, its channel's first, linked to their idea", async () => {
    idea.findMany.mockResolvedValue([
      typed("fb", "VALIDATED", post("For Facebook", { channels: ["facebook"], strength: 3 })),
      typed("used", "VALIDATED", post("Already on the plan")),
      typed("same", "VALIDATED", post("Our autumn menu")),
      typed("ig", "VALIDATED", post("For Instagram", { strength: 1 })),
      row("legacy", "SHORTLISTED"),
    ]);

    const offers = await poolAlternativesFor({
      projectId: "p1",
      channel: "instagram",
      exclude: new Set(["used"]),
      takenTopics: ["Our Autumn menu "],
      limit: 2,
    });

    expect(offers.map((offer) => offer.ideaId)).toEqual(["ig", "fb"]);
    expect(offers[0]).toEqual({
      topic: "For Instagram",
      captionIdea:
        '"Cold mornings, warm cups" | A latte on a wooden bar | Come by this week.',
      from: "Idea pool",
      ideaId: "ig",
      origin: { kind: "idea", ref: "ig" },
    });
    expect(
      await poolAlternativesFor({
        projectId: "p1",
        exclude: new Set(),
        takenTopics: [],
        limit: 0,
      }),
    ).toEqual([]);
  });
});

describe("poolIdeaIds", () => {
  it("asks only for this project's pool ideas, and skips the query for none", async () => {
    idea.findMany.mockResolvedValue([{ id: "i1" }]);
    expect([...(await poolIdeaIds("p1", ["i1", "i1", "made-up"]))]).toEqual([
      "i1",
    ]);
    expect(idea.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          projectId: "p1",
          id: { in: ["i1", "made-up"] },
        }),
      }),
    );

    idea.findMany.mockClear();
    expect((await poolIdeaIds("p1", [])).size).toBe(0);
    expect(idea.findMany).not.toHaveBeenCalled();
  });
});

describe("keepPoolIdeaIds", () => {
  it("keeps a valid id once and drops unknown or repeated ones", () => {
    const items = [
      { topic: "A", ideaId: " i1 " },
      { topic: "B", ideaId: "i1" },
      { topic: "C", ideaId: "nope" },
      { topic: "D" },
    ];
    expect(keepPoolIdeaIds(items, new Set(["i1"]))).toEqual([
      { topic: "A", ideaId: "i1" },
      { topic: "B" },
      { topic: "C" },
      { topic: "D" },
    ]);
  });
});

describe("buildPlanCard with pool ideas", () => {
  it("marks a post built from an idea as coming from the pool", () => {
    const card = buildPlanCard(
      {
        title: "Social media plan",
        items: [
          {
            date: "2026-10-06",
            channel: "instagram",
            formatKey: "instagram.post",
            topic: "From the pool",
            captionIdea: "Caption",
            ideaId: "i1",
          },
          {
            date: "2026-10-08",
            channel: "instagram",
            formatKey: "instagram.post",
            topic: "Own idea",
            captionIdea: "Caption",
          },
        ],
      },
      "Europe/Istanbul",
    );
    expect(card.items[0]).toMatchObject({
      ideaId: "i1",
      origin: { kind: "idea", ref: "i1" },
      from: "Idea pool",
    });
    expect(card.items[1]).not.toHaveProperty("ideaId");
    expect(card.items[1]).not.toHaveProperty("from");
  });
});

describe("worksNotes with an idea pool", () => {
  it("tells the model to plan from the pool, only when there is one", () => {
    const withPool = worksNotes({
      ideaPool: [{ id: "i1", title: "Idea", summary: "Why" }],
    }).join("\n");
    expect(withPool).toContain("Idea pool");
    expect(withPool).toContain('"id":"i1"');
    expect(withPool).toContain("ideaId");

    expect(worksNotes({}).join("\n")).not.toContain("Idea pool (");
  });
});

describe("markIdeasPlanned", () => {
  it("moves each used idea once and keeps going after a failure", async () => {
    advanceForScheduling
      .mockRejectedValueOnce(new Error("archived"))
      .mockResolvedValue("MEASURING");

    await markIdeasPlanned("p1", ["i1", "i2", "i1"]);

    expect(advanceForScheduling).toHaveBeenCalledTimes(2);
    expect(advanceForScheduling).toHaveBeenCalledWith("i1", "p1");
    expect(advanceForScheduling).toHaveBeenCalledWith("i2", "p1");
  });
});
