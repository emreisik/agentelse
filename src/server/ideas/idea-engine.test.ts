import { beforeEach, describe, expect, it, vi } from "vitest";

import type { IdeaConcept } from "@/lib/ideas/concept";

const loadIdeaContext = vi.fn();
vi.mock("@/server/ideas/idea-context", () => ({
  loadIdeaContext,
  ideaMemoryOf: () => ({
    pool: ["Our oat milk, explained in one minute"],
    saved: [],
    dismissed: [],
  }),
}));
const run = vi.fn();
const isMockMode = vi.fn(() => false);
vi.mock("@/server/reasoning/reasoning-service", () => ({
  ReasoningService: { run, isMockMode },
}));
const create = vi.fn();
const countActive = vi.fn();
const transition = vi.fn();
vi.mock("@/server/repositories/idea.repository", () => ({
  IdeaRepository: { create, countActive, transition },
}));
const getOrCreate = vi.fn();
const checkAndIncrement = vi.fn();
vi.mock("@/server/repositories/autonomy-policy.repository", () => ({
  AutonomyPolicyRepository: { getOrCreate, checkAndIncrement },
}));
const loadBrandRules = vi.fn();
vi.mock("@/server/works/brand-rule-loader", () => ({ loadBrandRules }));
vi.mock("@/server/brand/rule-language", () => ({
  brandRuleLanguageOf: vi.fn(async () => "en"),
}));

const { IdeaEngine, rotationCandidates } = await import("./idea-engine");
const { AgentelseError } = await import("@/server/security/errors");

const NOW = new Date("2026-10-06T10:00:00Z");

const CONTEXT = {
  workspaceId: "w1",
  projectId: "p1",
  brandId: "b1",
  timezone: "Europe/Istanbul",
  today: "2026-10-06",
  brand: { name: "Mira Coffee" },
  channels: ["instagram"],
  layouts: [
    {
      id: "headline-top",
      name: "Headline on top",
      headline: true,
      formats: [],
    },
  ],
  defaultLayoutId: "headline-top",
  signals: [],
  opportunities: [],
  postResults: { worked: [], didNotWork: [] },
  recentPosts: ["Behind the roast: our new single origin"],
  ideas: [],
  photos: [],
};

function raw(hook: string, caption = "Come try it this week.") {
  return {
    hook,
    headline: "Autumn is here",
    visual: "A latte on a wooden bar",
    caption,
    channels: ["instagram"],
    format: "post",
    layoutId: "headline-top",
    source: "season",
    strength: 2,
  };
}

function typedRow(id: string, createdAt: string, status = "VALIDATED") {
  const concept: IdeaConcept = {
    v: 2,
    module: "social",
    source: "brand",
    draft: {
      hook: id,
      headline: "x",
      visual: "y",
      caption: "z",
      channels: ["instagram"],
    },
  };
  return {
    id,
    status,
    title: id,
    description: "",
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
    concept,
    isMock: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  loadIdeaContext.mockResolvedValue(CONTEXT);
  getOrCreate.mockResolvedValue({ maxActiveIdeas: 20, unlimitedMode: false });
  countActive.mockResolvedValue(5);
  checkAndIncrement.mockResolvedValue(undefined);
  loadBrandRules.mockResolvedValue({
    language: "en",
    never: [{ text: "cheapest", origin: "client-rule" }],
    approvedClaims: [],
    competitors: [],
  });
  let n = 0;
  create.mockImplementation(async () => ({ id: `new-${++n}` }));
});

describe("IdeaEngine.generate", () => {
  it("saves cleaned post ideas as typed, VALIDATED ideas", async () => {
    run.mockResolvedValue({
      isMock: false,
      output: { ideas: [raw("Five new cups for colder mornings")] },
    });
    const result = await IdeaEngine.generate({
      projectId: "p1",
      count: 6,
      trigger: "manual",
      now: NOW,
    });
    expect(result).toEqual({ ok: true, created: ["new-1"], rotated: 0 });
    const input = create.mock.calls[0]![0];
    expect(input).toMatchObject({
      projectId: "p1",
      brandId: "b1",
      title: "Five new cups for colder mornings",
      description: "Come try it this week.",
      status: "VALIDATED",
      fingerprint: "social:five new cups for colder mornings",
    });
    expect(input.concept).toMatchObject({
      v: 2,
      module: "social",
      source: "season",
    });
    expect(checkAndIncrement).toHaveBeenCalledWith(
      { workspaceId: "w1", projectId: "p1", brandId: "b1" },
      "ideasCreated",
      1,
    );
  });

  it("drops what breaks a brand rule or repeats the pool or a recent post", async () => {
    run.mockResolvedValue({
      isMock: false,
      output: {
        ideas: [
          raw("The cheapest coffee in town", "Our cheapest cup yet."),
          raw("Our oat milk explained in a single minute"),
          raw("Behind the roast: the new single origin"),
          raw("Meet the barista behind your morning cup"),
        ],
      },
    });
    const result = await IdeaEngine.generate({
      projectId: "p1",
      count: 6,
      trigger: "refill",
      now: NOW,
    });
    expect(result).toMatchObject({ ok: true, created: ["new-1"] });
    expect(create.mock.calls.map((call) => call[0].title)).toEqual([
      "Meet the barista behind your morning cup",
    ]);
  });

  it("makes room in a full pool by retiring the oldest untouched typed ideas", async () => {
    loadIdeaContext.mockResolvedValue({
      ...CONTEXT,
      ideas: [
        typedRow("newer", "2026-10-05T10:00:00Z"),
        typedRow("oldest", "2026-09-20T10:00:00Z"),
        typedRow("saved", "2026-09-01T10:00:00Z", "APPROVED"),
      ],
    });
    countActive.mockResolvedValue(20);
    run.mockResolvedValue({
      isMock: false,
      output: { ideas: [raw("Meet the barista behind your morning cup")] },
    });
    const result = await IdeaEngine.generate({
      projectId: "p1",
      count: 6,
      trigger: "manual",
      now: NOW,
    });
    expect(transition).toHaveBeenCalledWith("oldest", "p1", "ARCHIVED");
    expect(result).toEqual({ ok: true, created: ["new-1"], rotated: 1 });
  });

  it("checks the room before the model call: a full pool with nothing to retire pays for nothing", async () => {
    loadIdeaContext.mockResolvedValue({
      ...CONTEXT,
      ideas: [typedRow("saved", "2026-09-01T10:00:00Z", "APPROVED")],
    });
    countActive.mockResolvedValue(20);
    expect(
      await IdeaEngine.generate({
        projectId: "p1",
        count: 6,
        trigger: "refill",
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: "FULL" });
    expect(run).not.toHaveBeenCalled();
    // Real runs count real ideas only (mock rows of the shared dev database
    // never fill the pool).
    expect(countActive).toHaveBeenCalledWith("p1", { isMock: false });
  });

  it("asks the model only for what the pool can take", async () => {
    countActive.mockResolvedValue(18);
    run.mockResolvedValue({
      isMock: false,
      output: { ideas: [raw("Meet the barista behind your morning cup")] },
    });
    await IdeaEngine.generate({
      projectId: "p1",
      count: 6,
      trigger: "manual",
      now: NOW,
    });
    expect(run.mock.calls[0]![1].context.count).toBe(2);
  });

  it("says so when today's AI limit is reached", async () => {
    run.mockRejectedValue(new AgentelseError("BUDGET_EXCEEDED", "limit"));
    expect(
      await IdeaEngine.generate({
        projectId: "p1",
        count: 6,
        trigger: "manual",
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: "BUDGET" });
    expect(create).not.toHaveBeenCalled();
  });
});

describe("rotationCandidates", () => {
  it("retires expired ideas first, then the oldest, never saved or untyped ones", () => {
    const expired = typedRow("expired", "2026-10-04T10:00:00Z");
    expired.concept = {
      ...expired.concept,
      expiresAt: "2026-10-05T00:00:00.000Z",
    };
    const rows = [
      typedRow("newest", "2026-10-05T10:00:00Z"),
      typedRow("old", "2026-09-01T10:00:00Z"),
      expired,
      typedRow("saved", "2026-08-01T10:00:00Z", "APPROVED"),
      { ...typedRow("untyped", "2026-07-01T10:00:00Z"), concept: null },
    ];
    expect(rotationCandidates(rows as never, 2, NOW)).toEqual([
      "expired",
      "old",
    ]);
    expect(rotationCandidates(rows as never, 0, NOW)).toEqual([]);
  });
});
