import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: bayrak (GA_FIXES_ANNOTATIONS, alpha) yokken sorgusuz
// 0; yalnız son 3 gündeki ACTIVE kampanyalar aranır; aynı kampanya için
// saklanan tam anahtar (ANNOTATION_CREATE:launch:<id>) TÜM durumlarda
// (reddedilmiş/süresi dolmuş dahil) varsa yeniden önerilmez; ad önce
// spec.campaignName, sonra spec.plan.campaignName, sonra sabit yedek; başlık
// 'Agentelse: ' önekli, en çok 60 karakter, URL'siz; gün mülk saat
// diliminde; duraklatılmış proje atlanır; haftalık yayın notu yalnız kendi alt
// bayrağıyla, ISO haftada bir kez ve o hafta tamamlanmış yayın Task'ı
// varsa; her öneri GaFixes.proposeAnnotation'dan geçer ve yazıcı hiç
// çağrılmaz; tick başına en çok 20.

const NOW = new Date("2026-10-07T09:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  launchFindMany: vi.fn(),
  changeFindMany: vi.fn(),
  taskGroupBy: vi.fn(),
  agencyActive: vi.fn(),
  propose: vi.fn(),
  createWriter: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: mocks.queryRaw,
    adsLaunch: { findMany: mocks.launchFindMany },
    gaConfigChange: { findMany: mocks.changeFindMany },
    task: { groupBy: mocks.taskGroupBy },
  },
}));
vi.mock("@/server/repositories/agency-loop-state.repository", () => ({
  isProjectAgencyActive: mocks.agencyActive,
}));
vi.mock("./fixes", () => ({
  GaFixes: { proposeAnnotation: mocks.propose },
}));
vi.mock("@/server/integrations/google-analytics/admin-write", () => ({
  createGaAdminWriter: mocks.createWriter,
}));

const { GaAnnotations, isoWeekOf, launchAnnotationTitle, launchCampaignName } =
  await import("./annotations");

const CANDIDATE = {
  linkId: "link-1",
  projectId: "proj-1",
  timeZone: "Europe/Istanbul",
};

function launch(overrides: Record<string, unknown> = {}) {
  return {
    id: "L1",
    projectId: "proj-1",
    activatedAt: new Date(NOW.getTime() - DAY),
    spec: { campaignName: "Autumn sale" },
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("GA_FIXES", "true");
  vi.stubEnv("GA_SYNC", "true");
  vi.stubEnv("GA_FIXES_ALPHA", "true");
  vi.stubEnv("GA_FIXES_ANNOTATIONS", "true");
  vi.stubEnv("GA_FIXES_ANNOTATIONS_PUBLISH", "");
  vi.stubEnv("AGENTELSE_PROVIDER_MODE", "");
  mocks.queryRaw.mockResolvedValue([CANDIDATE]);
  mocks.launchFindMany.mockResolvedValue([launch()]);
  mocks.changeFindMany.mockResolvedValue([]);
  mocks.taskGroupBy.mockResolvedValue([]);
  mocks.agencyActive.mockResolvedValue(true);
  mocks.propose.mockResolvedValue({
    ok: true,
    changeId: "c1",
    status: "PROPOSED",
    created: true,
    approvalId: "a1",
  });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("flags", () => {
  it("returns 0 with no query when GA_FIXES_ANNOTATIONS is missing", async () => {
    vi.stubEnv("GA_FIXES_ANNOTATIONS", "");
    expect(await GaAnnotations.runDue(20, NOW)).toBe(0);
    expect(mocks.queryRaw).not.toHaveBeenCalled();
    expect(mocks.launchFindMany).not.toHaveBeenCalled();
  });

  it("returns 0 with no query when the alpha kill switch is off", async () => {
    vi.stubEnv("GA_FIXES_ALPHA", "");
    expect(await GaAnnotations.runDue(20, NOW)).toBe(0);
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });

  it("returns 0 with no query when GA_FIXES is off", async () => {
    vi.stubEnv("GA_FIXES", "");
    expect(await GaAnnotations.runDue(20, NOW)).toBe(0);
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });

  it("skips projects outside the dev allow-list and sends the list to SQL", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@db.example.com/main");
    vi.stubEnv("GA_SYNC_DEV_PROJECTS", "other-project");
    expect(await GaAnnotations.runDue(20, NOW)).toBe(0);
    const query = mocks.queryRaw.mock.calls[0]?.[0] as { values: unknown[] };
    expect(query.values).toContainEqual(["other-project"]);
    expect(mocks.launchFindMany).not.toHaveBeenCalled();
  });
});

describe("launch trigger", () => {
  it("looks only at ACTIVE launches activated in the last 3 days", async () => {
    await GaAnnotations.runDue(20, NOW);
    expect(mocks.launchFindMany).toHaveBeenCalledTimes(1);
    const args = mocks.launchFindMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
      take: number;
    };
    expect(args.where).toEqual({
      projectId: { in: ["proj-1"] },
      status: "ACTIVE",
      activatedAt: { gte: new Date(NOW.getTime() - 3 * DAY) },
    });
    expect(args.take).toBe(50);
  });

  it("proposes through GaFixes.proposeAnnotation with the launch dedupe subject", async () => {
    expect(await GaAnnotations.runDue(20, NOW)).toBe(1);
    expect(mocks.propose).toHaveBeenCalledTimes(1);
    expect(mocks.propose).toHaveBeenCalledWith({
      projectId: "proj-1",
      title: "Agentelse: Autumn sale launched",
      day: "2026-10-06",
      dedupeKey: "launch:L1",
    });
  });

  it("uses the property time zone for the day", async () => {
    mocks.launchFindMany.mockResolvedValue([
      launch({ activatedAt: new Date("2026-10-06T22:30:00.000Z") }),
    ]);
    await GaAnnotations.runDue(20, NOW);
    expect(mocks.propose.mock.calls[0]?.[0]).toMatchObject({
      day: "2026-10-07",
    });

    mocks.propose.mockClear();
    mocks.queryRaw.mockResolvedValue([
      { ...CANDIDATE, timeZone: "America/Los_Angeles" },
    ]);
    await GaAnnotations.runDue(20, NOW);
    expect(mocks.propose.mock.calls[0]?.[0]).toMatchObject({
      day: "2026-10-06",
    });
  });

  it("skips a launch whose exact stored key exists in any status (rejected is not re-proposed)", async () => {
    // Satır durumu sorguda yok: REJECTED/EXPIRED/FAILED de bulunur.
    mocks.changeFindMany.mockResolvedValue([
      { linkId: "link-1", dedupeKey: "ANNOTATION_CREATE:launch:L1" },
    ]);
    expect(await GaAnnotations.runDue(20, NOW)).toBe(0);
    expect(mocks.propose).not.toHaveBeenCalled();
    const where = (
      mocks.changeFindMany.mock.calls[0]?.[0] as {
        where: Record<string, unknown>;
      }
    ).where;
    expect(where.dedupeKey).toEqual({ in: ["ANNOTATION_CREATE:launch:L1"] });
    expect(where).not.toHaveProperty("status");
    expect(where).not.toHaveProperty("openKey");
  });

  it("only skips the launch that already has a change", async () => {
    mocks.launchFindMany.mockResolvedValue([launch(), launch({ id: "L2" })]);
    mocks.changeFindMany.mockResolvedValue([
      { linkId: "link-1", dedupeKey: "ANNOTATION_CREATE:launch:L1" },
    ]);
    expect(await GaAnnotations.runDue(20, NOW)).toBe(1);
    expect(mocks.propose.mock.calls[0]?.[0]).toMatchObject({
      dedupeKey: "launch:L2",
    });
  });

  it("skips paused projects", async () => {
    mocks.agencyActive.mockResolvedValue(false);
    expect(await GaAnnotations.runDue(20, NOW)).toBe(0);
    expect(mocks.agencyActive).toHaveBeenCalledWith("proj-1");
    expect(mocks.propose).not.toHaveBeenCalled();
  });

  it("does not count a refused or already-open proposal", async () => {
    mocks.propose.mockResolvedValueOnce({
      ok: false,
      code: "limit_reached",
      message: "x",
    });
    expect(await GaAnnotations.runDue(20, NOW)).toBe(0);

    mocks.propose.mockResolvedValueOnce({
      ok: true,
      changeId: "c1",
      status: "PROPOSED",
      created: false,
      approvalId: null,
    });
    expect(await GaAnnotations.runDue(20, NOW)).toBe(0);
  });

  it("a failing proposal does not stop the rest of the tick", async () => {
    mocks.launchFindMany.mockResolvedValue([launch(), launch({ id: "L2" })]);
    mocks.propose.mockRejectedValueOnce(new Error("db"));
    expect(await GaAnnotations.runDue(20, NOW)).toBe(1);
  });

  it("proposes at most 20 per tick", async () => {
    mocks.launchFindMany.mockResolvedValue(
      Array.from({ length: 25 }, (_, index) => launch({ id: `L${index}` })),
    );
    expect(await GaAnnotations.runDue(50, NOW)).toBe(20);
    expect(mocks.propose).toHaveBeenCalledTimes(20);
  });

  it("never calls a writer", async () => {
    mocks.launchFindMany.mockResolvedValue([launch()]);
    await GaAnnotations.runDue(20, NOW);
    expect(mocks.createWriter).not.toHaveBeenCalled();
  });
});

describe("campaign name and title shaping", () => {
  it("prefers spec.campaignName over spec.plan.campaignName", () => {
    expect(
      launchCampaignName({
        campaignName: "Top level",
        plan: { campaignName: "Nested" },
      }),
    ).toBe("Top level");
  });

  it("falls back to spec.plan.campaignName, then the fixed name", () => {
    expect(launchCampaignName({ plan: { campaignName: "Nested" } })).toBe(
      "Nested",
    );
    expect(launchCampaignName({})).toBe("ad campaign");
    expect(launchCampaignName(null)).toBe("ad campaign");
    expect(launchCampaignName("text")).toBe("ad campaign");
    expect(launchCampaignName({ campaignName: 42, plan: [] })).toBe(
      "ad campaign",
    );
    expect(launchCampaignName({ campaignName: "   " })).toBe("ad campaign");
  });

  it("prefixes, caps at 60 characters and drops URLs and markup", () => {
    const long = launchAnnotationTitle({ campaignName: "A".repeat(200) });
    expect(long.startsWith("Agentelse: ")).toBe(true);
    expect(long.endsWith(" launched")).toBe(true);
    expect(Array.from(long).length).toBeLessThanOrEqual(60);

    const dirty = launchAnnotationTitle({
      campaignName: "<b>Sale</b> https://evil.example.com/x?y=1 now",
    });
    expect(dirty).not.toMatch(/https?:|<|>|evil/);
    expect(dirty).toBe("Agentelse: b Sale /b now launched");
  });

  it("an empty cleaned name uses the fallback", () => {
    expect(
      launchAnnotationTitle({ campaignName: "https://evil.example.com/x" }),
    ).toBe("Agentelse: ad campaign launched");
  });
});

describe("isoWeekOf", () => {
  it("returns the ISO week key and Monday", () => {
    expect(isoWeekOf("2026-10-07")).toEqual({
      key: "2026-W41",
      monday: "2026-10-05",
    });
    expect(isoWeekOf("2026-10-05")).toEqual({
      key: "2026-W41",
      monday: "2026-10-05",
    });
    expect(isoWeekOf("2026-10-11")).toEqual({
      key: "2026-W41",
      monday: "2026-10-05",
    });
  });

  it("handles year boundaries", () => {
    expect(isoWeekOf("2027-01-01")).toEqual({
      key: "2026-W53",
      monday: "2026-12-28",
    });
    expect(isoWeekOf("2024-12-30")).toEqual({
      key: "2025-W01",
      monday: "2024-12-30",
    });
    expect(isoWeekOf("2026-01-01")).toEqual({
      key: "2026-W01",
      monday: "2025-12-29",
    });
  });
});

describe("weekly publish trigger", () => {
  beforeEach(() => {
    vi.stubEnv("GA_FIXES_ANNOTATIONS_PUBLISH", "true");
    mocks.launchFindMany.mockResolvedValue([]);
    mocks.taskGroupBy.mockResolvedValue([
      {
        projectId: "proj-1",
        _max: { completedAt: new Date(NOW.getTime() - 3600_000) },
      },
    ]);
  });

  it("does nothing without its own sub-flag", async () => {
    vi.stubEnv("GA_FIXES_ANNOTATIONS_PUBLISH", "");
    expect(await GaAnnotations.runDue(20, NOW)).toBe(0);
    expect(mocks.taskGroupBy).not.toHaveBeenCalled();
    expect(mocks.propose).not.toHaveBeenCalled();
  });

  it("proposes one weekly note with the week's Monday as the day", async () => {
    expect(await GaAnnotations.runDue(20, NOW)).toBe(1);
    expect(mocks.propose).toHaveBeenCalledTimes(1);
    expect(mocks.propose).toHaveBeenCalledWith({
      projectId: "proj-1",
      title: "Agentelse: new posts published",
      day: "2026-10-05",
      dedupeKey: "publish:2026-W41",
    });
  });

  it("only counts COMPLETED publish tasks completed inside this week", async () => {
    await GaAnnotations.runDue(20, NOW);
    const args = mocks.taskGroupBy.mock.calls[0]?.[0] as {
      by: string[];
      where: {
        projectId: { in: string[] };
        status: string;
        capability: { in: string[] };
        completedAt: { gte: Date; lte: Date };
      };
    };
    expect(args.by).toEqual(["projectId"]);
    expect(args.where.projectId.in).toEqual(["proj-1"]);
    expect(args.where.status).toBe("COMPLETED");
    expect(args.where.capability.in.length).toBeGreaterThan(0);
    expect(
      args.where.capability.in.every((key) => key.endsWith("_PUBLISH")),
    ).toBe(true);
    // Pazartesi 00:00 Europe/Istanbul (UTC+3) = Pazar 21:00 UTC.
    expect(args.where.completedAt.gte).toEqual(
      new Date("2026-10-04T21:00:00.000Z"),
    );
    expect(args.where.completedAt.lte).toEqual(NOW);
  });

  it("ignores a publish task completed before this week's start", async () => {
    mocks.taskGroupBy.mockResolvedValue([
      {
        projectId: "proj-1",
        _max: { completedAt: new Date("2026-10-04T20:00:00.000Z") },
      },
    ]);
    expect(await GaAnnotations.runDue(20, NOW)).toBe(0);
    expect(mocks.propose).not.toHaveBeenCalled();
  });

  it("checks publish tasks for all candidates in one query", async () => {
    await GaAnnotations.runDue(20, NOW);
    expect(mocks.taskGroupBy).toHaveBeenCalledTimes(1);
  });

  it("proposes nothing when no publish task completed this week", async () => {
    mocks.taskGroupBy.mockResolvedValue([]);
    expect(await GaAnnotations.runDue(20, NOW)).toBe(0);
    expect(mocks.propose).not.toHaveBeenCalled();
  });

  it("is once per ISO week: any status of the stored key blocks it", async () => {
    mocks.changeFindMany.mockResolvedValue([
      { linkId: "link-1", dedupeKey: "ANNOTATION_CREATE:publish:2026-W41" },
    ]);
    expect(await GaAnnotations.runDue(20, NOW)).toBe(0);
    expect(mocks.taskGroupBy).not.toHaveBeenCalled();
    expect(mocks.propose).not.toHaveBeenCalled();
  });

  it("proposes again in the next week", async () => {
    mocks.changeFindMany.mockResolvedValue([
      { linkId: "link-1", dedupeKey: "ANNOTATION_CREATE:publish:2026-W41" },
    ]);
    const nextWeek = new Date(NOW.getTime() + 7 * DAY);
    mocks.taskGroupBy.mockResolvedValue([
      {
        projectId: "proj-1",
        _max: { completedAt: new Date(nextWeek.getTime() - 3600_000) },
      },
    ]);
    expect(await GaAnnotations.runDue(20, nextWeek)).toBe(1);
    expect(mocks.propose.mock.calls[0]?.[0]).toMatchObject({
      dedupeKey: "publish:2026-W42",
      day: "2026-10-12",
    });
  });

  it("skips paused projects", async () => {
    mocks.agencyActive.mockResolvedValue(false);
    expect(await GaAnnotations.runDue(20, NOW)).toBe(0);
    expect(mocks.propose).not.toHaveBeenCalled();
  });
});
