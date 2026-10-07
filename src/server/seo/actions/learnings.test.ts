import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: öğrenme kapısı yalnız kontrol gruplu, örtüşmesiz,
// gerçek ve SIGNIFICANT WORKED sonucundan geçer (DIDNT, DIRECTIONAL, mock ve
// diğer türler geçmez); yazım sourceRef ile tekildir, polarity hep WORKS,
// güven 0.8 ya da 0.6; metin rakam, "/" ve "http" taşımaz; SEO_ACTIONS
// kapalıyken readSeoLearnings veritabanını okumaz.

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findMany: vi.fn(),
  update: vi.fn(),
  learningFind: vi.fn(),
  learningCreate: vi.fn(),
  learningMany: vi.fn(),
  brand: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    seoAction: {
      findUnique: mocks.findUnique,
      findMany: mocks.findMany,
      update: mocks.update,
    },
    brandLearning: {
      findFirst: mocks.learningFind,
      create: mocks.learningCreate,
      findMany: mocks.learningMany,
    },
    brand: { findFirst: mocks.brand },
  },
}));
vi.mock("./store", () => ({ actionViewOf: (row: unknown) => row }));

const {
  LEARNING_KINDS,
  SEO_LEARNING_SOURCE,
  SeoLearnings,
  learningGate,
  readSeoLearnings,
} = await import("./learnings");
const { actionViewFixture } = await import("@/lib/seo/actions/test-support");
const { SEO_FIX_KINDS } = await import("@/lib/seo/actions/kinds");

const NOW = new Date("2026-10-07T12:00:00.000Z");
const ENV_KEYS = ["SEO_ACTIONS", "SEO_HEALTH", "SEO_CRAWL"];
const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

type Overrides = Parameters<typeof actionViewFixture>[0];

function evaluationFixture(
  overrides: Record<string, unknown> = {},
): NonNullable<ReturnType<typeof actionViewFixture>["evaluation"]> {
  return {
    v: 1,
    method: "DID",
    metric: "ctr_adj",
    anchorDay: "2026-08-05",
    preWeeks: [],
    postWeeks: [],
    effect: 0.4,
    low: 0.2,
    high: 0.6,
    controls: 5,
    yoyAdjusted: false,
    treated: null,
    control: null,
    yoy: null,
    updates: [],
    truncated: false,
    cwv: null,
    sitemap: null,
    reason: null,
    outcome: "WORKED",
    confidence: "SIGNIFICANT",
    evaluatedAt: NOW.toISOString(),
    ...overrides,
  } as never;
}

function worked(overrides: Overrides = {}) {
  return actionViewFixture({
    id: "action-1",
    kind: "TITLE_META",
    status: "WORKED",
    outcome: "WORKED",
    confidence: "SIGNIFICANT",
    isMock: false,
    evaluation: evaluationFixture(),
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SEO_ACTIONS = "true";
  process.env.SEO_HEALTH = "true";
  process.env.SEO_CRAWL = "true";
  mocks.learningFind.mockResolvedValue(null);
  mocks.brand.mockResolvedValue({ id: "brand-1" });
  mocks.learningCreate.mockResolvedValue({ id: "learning-1" });
  mocks.update.mockResolvedValue({});
});

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("learningGate", () => {
  it("passes a significant controlled WORKED outcome of a learning kind", () => {
    expect(learningGate(worked())).toBe(true);
    for (const kind of LEARNING_KINDS) {
      expect(learningGate(worked({ kind }))).toBe(true);
    }
  });

  it("rejects every other kind", () => {
    for (const kind of SEO_FIX_KINDS) {
      if (LEARNING_KINDS.includes(kind)) continue;
      expect(learningGate(worked({ kind }))).toBe(false);
    }
  });

  it("never lets DIDNT or INCONCLUSIVE through", () => {
    expect(learningGate(worked({ outcome: "DIDNT" }))).toBe(false);
    expect(learningGate(worked({ outcome: "INCONCLUSIVE" }))).toBe(false);
    expect(learningGate(worked({ outcome: null }))).toBe(false);
  });

  it("requires SIGNIFICANT confidence", () => {
    expect(learningGate(worked({ confidence: "DIRECTIONAL" }))).toBe(false);
    expect(learningGate(worked({ confidence: null }))).toBe(false);
  });

  it("requires the control-group method with at least 3 controls", () => {
    expect(
      learningGate(
        worked({ evaluation: evaluationFixture({ method: "DID_SITE" }) }),
      ),
    ).toBe(false);
    expect(
      learningGate(
        worked({ evaluation: evaluationFixture({ method: "PRE_POST" }) }),
      ),
    ).toBe(false);
    expect(
      learningGate(worked({ evaluation: evaluationFixture({ controls: 2 }) })),
    ).toBe(false);
    expect(
      learningGate(worked({ evaluation: evaluationFixture({ controls: 3 }) })),
    ).toBe(true);
    expect(learningGate(worked({ evaluation: null }))).toBe(false);
  });

  it("rejects an outcome that listed an overlapping update", () => {
    const update = {
      name: "Core update",
      kind: "CORE",
      startedAt: NOW.toISOString(),
      endedAt: null,
    };
    expect(
      learningGate(
        worked({ evaluation: evaluationFixture({ updates: [update] }) }),
      ),
    ).toBe(false);
  });

  it("rejects mock actions and non-ctr metrics outside the DiD set", () => {
    expect(learningGate(worked({ isMock: true }))).toBe(false);
    expect(
      learningGate(
        worked({ evaluation: evaluationFixture({ metric: "cwv" }) }),
      ),
    ).toBe(false);
    expect(
      learningGate(
        worked({ evaluation: evaluationFixture({ metric: "clicks" }) }),
      ),
    ).toBe(true);
  });
});

describe("SeoLearnings.writeFor", () => {
  it("writes one WORKS learning with a digit-free insight and links it", async () => {
    mocks.findUnique.mockResolvedValue(worked());
    expect(await SeoLearnings.writeFor("action-1", NOW)).toBe(true);
    const data = mocks.learningCreate.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      workspaceId: "workspace-1",
      projectId: "project-1",
      brandId: "brand-1",
      sourceType: SEO_LEARNING_SOURCE,
      sourceRef: "action-1",
      polarity: "WORKS",
      evidenceCount: 1,
      lastReinforcedAt: NOW,
    });
    expect(data.insight).not.toMatch(/\d/);
    expect(data.insight).not.toContain("/");
    expect(data.insight).not.toContain("http");
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "action-1" },
      data: { learningId: "learning-1" },
    });
  });

  it("keeps every learning text free of digits, paths and urls", async () => {
    for (const kind of LEARNING_KINDS) {
      for (const metric of ["ctr_adj", "clicks", "impressions"]) {
        mocks.findUnique.mockResolvedValue(
          worked({ kind, evaluation: evaluationFixture({ metric }) }),
        );
        mocks.learningCreate.mockClear();
        await SeoLearnings.writeFor("action-1", NOW);
        const insight = mocks.learningCreate.mock.calls[0]![0].data
          .insight as string;
        expect(insight).not.toMatch(/\d/);
        expect(insight).not.toContain("/");
        expect(insight).not.toContain("http");
      }
    }
  });

  it("uses confidence 0.8 for a strong lower bound and 0.6 otherwise", async () => {
    mocks.findUnique.mockResolvedValue(
      worked({ evaluation: evaluationFixture({ low: 0.1 }) }),
    );
    await SeoLearnings.writeFor("action-1", NOW);
    expect(mocks.learningCreate.mock.calls[0]![0].data.confidence).toBe(0.8);
    mocks.findUnique.mockResolvedValue(
      worked({ evaluation: evaluationFixture({ low: 0.04 }) }),
    );
    await SeoLearnings.writeFor("action-1", NOW);
    expect(mocks.learningCreate.mock.calls[1]![0].data.confidence).toBe(0.6);
  });

  it("is idempotent by sourceRef and when the action already has a learning", async () => {
    mocks.findUnique.mockResolvedValue(worked());
    mocks.learningFind.mockResolvedValue({ id: "existing" });
    expect(await SeoLearnings.writeFor("action-1", NOW)).toBe(false);
    expect(mocks.learningFind).toHaveBeenCalledWith({
      where: { sourceRef: "action-1" },
      select: { id: true },
    });
    expect(mocks.learningCreate).not.toHaveBeenCalled();
    mocks.findUnique.mockResolvedValue(worked({ learningId: "learning-0" }));
    expect(await SeoLearnings.writeFor("action-1", NOW)).toBe(false);
  });

  it("writes nothing for DIDNT, other statuses or a gated-out action", async () => {
    mocks.findUnique.mockResolvedValue(
      worked({ status: "DIDNT", outcome: "DIDNT" }),
    );
    expect(await SeoLearnings.writeFor("action-1", NOW)).toBe(false);
    mocks.findUnique.mockResolvedValue(worked({ status: "EVALUATING" }));
    expect(await SeoLearnings.writeFor("action-1", NOW)).toBe(false);
    mocks.findUnique.mockResolvedValue(worked({ isMock: true }));
    expect(await SeoLearnings.writeFor("action-1", NOW)).toBe(false);
    mocks.findUnique.mockResolvedValue(null);
    expect(await SeoLearnings.writeFor("action-1", NOW)).toBe(false);
    expect(mocks.learningCreate).not.toHaveBeenCalled();
  });

  it("writes nothing without a default brand", async () => {
    mocks.findUnique.mockResolvedValue(worked());
    mocks.brand.mockResolvedValue(null);
    expect(await SeoLearnings.writeFor("action-1", NOW)).toBe(false);
    expect(mocks.learningCreate).not.toHaveBeenCalled();
  });
});

describe("SeoLearnings.writeDue", () => {
  it("does nothing without the loop flag", async () => {
    process.env.SEO_ACTIONS = "false";
    expect(await SeoLearnings.writeDue(NOW)).toBe(0);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("selects recent significant DID rows and counts the written ones", async () => {
    mocks.findMany.mockResolvedValue([{ id: "a1" }, { id: "a2" }]);
    mocks.findUnique
      .mockResolvedValueOnce(worked({ id: "a1" }))
      .mockResolvedValueOnce(null);
    expect(await SeoLearnings.writeDue(NOW)).toBe(1);
    const where = mocks.findMany.mock.calls[0]![0].where;
    expect(where.status).toBe("WORKED");
    expect(where.isMock).toBe(false);
    expect(where.learningId).toBeNull();
    expect(where.confidence).toBe("SIGNIFICANT");
    expect(where.kind).toEqual({ in: [...LEARNING_KINDS] });
    expect(where.evaluation).toEqual({ path: ["method"], equals: "DID" });
  });
});

describe("readSeoLearnings", () => {
  it("returns [] without a database read when SEO_ACTIONS is off", async () => {
    process.env.SEO_ACTIONS = "false";
    expect(await readSeoLearnings("project-1")).toEqual([]);
    expect(mocks.learningMany).not.toHaveBeenCalled();
  });

  it("reads the newest SEO learnings when the flag is on", async () => {
    mocks.learningMany.mockResolvedValue([
      { insight: "First insight." },
      { insight: "Second insight." },
    ]);
    expect(await readSeoLearnings("project-1")).toEqual([
      "First insight.",
      "Second insight.",
    ]);
    expect(mocks.learningMany).toHaveBeenCalledWith({
      where: {
        projectId: "project-1",
        sourceType: SEO_LEARNING_SOURCE,
        polarity: "WORKS",
      },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { insight: true },
    });
  });

  it("only needs the manager flag (SEO_ACTIONS), not the crawler", async () => {
    delete process.env.SEO_HEALTH;
    delete process.env.SEO_CRAWL;
    mocks.learningMany.mockResolvedValue([]);
    expect(await readSeoLearnings("project-1", 3)).toEqual([]);
    expect(mocks.learningMany).toHaveBeenCalledTimes(1);
  });
});
