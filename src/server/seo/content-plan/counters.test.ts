import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı (SC-F7, /health): bayrak kapalıyken null döner ve
// veritabanına gidilmez; sayaçlar neden ve duruma göre sayılır, sonuç yalnız
// sayıdır (anahtar kelime, başlık, yol ya da proje kimliği içermez), yalnız
// geçerli kipin satırları okunur ve düşen bir sayaç 0 olur.

const mocks = vi.hoisted(() => ({
  on: vi.fn(),
  mock: vi.fn(),
  plans: vi.fn(),
  audit: vi.fn(),
  groupBy: vi.fn(),
}));

vi.mock("@/lib/seo/content-plan/flags", () => ({
  SeoContentPlanFlags: { on: mocks.on },
}));
vi.mock("@/server/integrations/search-console/search-analytics", () => ({
  gscMockMode: mocks.mock,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    seoContentPlan: { findMany: mocks.plans },
    auditLog: { count: mocks.audit },
    creative: { groupBy: mocks.groupBy },
  },
}));

const { loadSeoContentPlanCounters } = await import("./counters");

const NOW = new Date("2026-10-07T12:00:00.000Z");
const SECRET_KEYWORD = "secret keyword fixture";

function onlyNumbers(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (value && typeof value === "object") {
    return Object.values(value).every(onlyNumbers);
  }
  return false;
}

function slot(id: string, status: string, creativeId: string | null) {
  return {
    id,
    status,
    kind: "SUPPORT",
    clusterId: null,
    clusterName: null,
    keyword: SECRET_KEYWORD,
    queries: [SECRET_KEYWORD],
    intent: "informational",
    impressions: 200,
    share: 0.05,
    position: null,
    gap: "NO_PAGE",
    rising: false,
    findingId: null,
    title: SECRET_KEYWORD,
    angle: "",
    description: "",
    date: "2026-10-12",
    time: "10:00",
    creativeId,
    postId: creativeId ? `post-${id}` : null,
    ideaId: `idea-${id}`,
    prevIdeaStatus: null,
    linkFrom: [],
    linkTo: [],
    linksVerified: false,
    reusedIdea: false,
  };
}

function activeRow(
  projectId: string,
  slots: ReturnType<typeof slot>[],
  wording = "AI",
) {
  return {
    projectId,
    status: "ACTIVE",
    wording,
    data: { v: 1, slots, nextSlot: slots.length + 1, reason: null },
  };
}

function emptyRow(projectId: string, reason: string) {
  return {
    projectId,
    status: "EMPTY",
    wording: "BASIC",
    data: { v: 1, reason },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.on.mockReturnValue(true);
  mocks.mock.mockReturnValue(false);
  mocks.audit.mockImplementation(
    async ({ where }: { where: { action: string } }) =>
      where.action === "seo_content_plan.regenerated" ? 2 : 5,
  );
  mocks.plans.mockResolvedValue([
    activeRow(
      "project-secret-1",
      [
        slot("s1", "PLANNED", "c1"),
        slot("s2", "PLANNED", "c2"),
        slot("s3", "SKIPPED", "c3"),
        slot("s4", "REMOVED", "c5"),
      ],
      "AI",
    ),
    activeRow("project-secret-2", [slot("s1", "PLANNED", "c4")], "BASIC"),
    emptyRow("project-secret-3", "NO_GAPS"),
    emptyRow("project-secret-4", "NO_GAPS"),
    emptyRow("project-secret-5", "AI_LIMIT"),
  ]);
  mocks.groupBy.mockResolvedValue([
    { status: "DRAFT", _count: { _all: 1 } },
    { status: "APPROVED", _count: { _all: 1 } },
    { status: "PUBLISHED", _count: { _all: 1 } },
  ]);
});

describe("loadSeoContentPlanCounters", () => {
  it("returns null with zero database calls when the flag is off", async () => {
    mocks.on.mockReturnValue(false);
    expect(await loadSeoContentPlanCounters(NOW)).toBeNull();
    expect(mocks.plans).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.groupBy).not.toHaveBeenCalled();
  });

  it("counts plans by state and empty reason, slots by status and wording", async () => {
    expect(await loadSeoContentPlanCounters(NOW)).toEqual({
      plans30d: 2,
      empty30d: 3,
      byEmptyReason: { NO_GAPS: 2, AI_LIMIT: 1 },
      slotsPlanned: 3,
      slotsWritten: 2,
      slotsPublished: 1,
      slotsSkipped: 1,
      wordingBasic30d: 1,
      regenerations30d: 2,
      capBlocked30d: 5,
      projectsWithPlan: 2,
    });
    // Skipped yuvanın Creative'ı sorguya girmez
    const ids = mocks.groupBy.mock.calls[0]![0].where.id.in as string[];
    expect([...ids].sort()).toEqual(["c1", "c2", "c4"]);
  });

  it("returns only numbers and no row content", async () => {
    const counters = await loadSeoContentPlanCounters(NOW);
    expect(
      onlyNumbers({ ...counters, byEmptyReason: counters?.byEmptyReason }),
    ).toBe(true);
    const json = JSON.stringify(counters);
    expect(json).not.toContain(SECRET_KEYWORD);
    expect(json).not.toContain("project-secret");
    expect(json).not.toContain("idea-");
  });

  it("reads only the current mode, only counts text-free columns and skips the creative query when nothing is planned", async () => {
    await loadSeoContentPlanCounters(NOW);
    expect(mocks.plans.mock.calls[0]![0].where.isMock).toBe(false);
    mocks.mock.mockReturnValue(true);
    await loadSeoContentPlanCounters(NOW);
    expect(mocks.plans.mock.calls[1]![0].where.isMock).toBe(true);

    mocks.groupBy.mockClear();
    mocks.plans.mockResolvedValue([emptyRow("p", "NO_DATA")]);
    const counters = await loadSeoContentPlanCounters(NOW);
    expect(mocks.groupBy).not.toHaveBeenCalled();
    expect(counters).toMatchObject({
      plans30d: 0,
      empty30d: 1,
      byEmptyReason: { NO_DATA: 1 },
      slotsPlanned: 0,
      slotsWritten: 0,
    });
  });

  it("falls back to 0 for every counter that fails", async () => {
    mocks.plans.mockRejectedValue(new Error("db"));
    mocks.audit.mockRejectedValue(new Error("db"));
    mocks.groupBy.mockRejectedValue(new Error("db"));
    expect(await loadSeoContentPlanCounters(NOW)).toEqual({
      plans30d: 0,
      empty30d: 0,
      byEmptyReason: {},
      slotsPlanned: 0,
      slotsWritten: 0,
      slotsPublished: 0,
      slotsSkipped: 0,
      wordingBasic30d: 0,
      regenerations30d: 0,
      capBlocked30d: 0,
      projectsWithPlan: 0,
    });

    mocks.plans.mockResolvedValue([
      activeRow("p", [slot("s1", "PLANNED", "c1")]),
    ]);
    const partial = await loadSeoContentPlanCounters(NOW);
    expect(partial).toMatchObject({
      slotsPlanned: 1,
      slotsWritten: 0,
      slotsPublished: 0,
    });
  });
});
