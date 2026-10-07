import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  planDataFixture,
  slotFixture,
} from "@/lib/seo/content-plan/test-support";

// Bu dosyanın kanıtladığı: bayrak kapalıyken görünüm null ve sıfır veritabanı
// okuması; ayar satırı yoksa varsayılanlar ve hiç yazma yok; needs_data /
// waiting / empty / ready durumları; slot durumu Creative'den (etkin kartlı
// slot IN_PROGRESS, kaldırılan slot gizli, atlanan SKIPPED); kullanılan sayı;
// canPlanNow ve canRefresh kuralları; ayar kaydı sınırı kırpar ve denetler.

const mocks = vi.hoisted(() => ({
  settingFind: vi.fn(),
  settingUpsert: vi.fn(),
  planFind: vi.fn(),
  creativeCount: vi.fn(),
  creativeFindMany: vi.fn(),
  commandFindMany: vi.fn(),
  primaryGscLink: vi.fn(),
  readEngineState: vi.fn(),
  getProjectTimezone: vi.fn(),
  record: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    seoContentSetting: { findUnique: mocks.settingFind, upsert: mocks.settingUpsert },
    seoContentPlan: { findUnique: mocks.planFind },
    creative: { count: mocks.creativeCount, findMany: mocks.creativeFindMany },
    command: { findMany: mocks.commandFindMany },
  },
}));
vi.mock("@/server/seo/store", () => ({ primaryGscLink: mocks.primaryGscLink }));
vi.mock("@/server/seo/opportunities/state", () => ({
  readEngineState: mocks.readEngineState,
}));
vi.mock("@/server/chat/content-plan", () => ({
  getProjectTimezone: mocks.getProjectTimezone,
}));
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: mocks.record },
}));

const { loadContentPlanView, readPlanSettings, savePlanSettings, activeSeoCards, localClock } =
  await import("./store");

const ENV_KEYS = [
  "SEO_CONTENT_PLAN",
  "GSC_SYNC",
  "SEO_INSIGHTS",
  "GSC_SEARCH_PAGE",
  "GSC_ROLLOUT_PROJECTS",
  "GSC_SYNC_DEV_PROJECTS",
] as const;
const saved: Record<string, string | undefined> = {};

// 7 Ekim 2026 12:00 (Europe/Istanbul = UTC+3)
const NOW = new Date("2026-10-07T09:00:00Z");

const LINK = { id: "link-1", projectId: "p1", isMock: false, lastWeeklyWeek: "2026-09-28" };

function planRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "plan-1",
    linkId: "link-1",
    month: "2026-10",
    status: "ACTIVE",
    isMock: false,
    cap: 4,
    existingAtPlan: 0,
    basedOnWeek: "2026-09-28",
    wording: "AI",
    regenerations: 0,
    data: planDataFixture(),
    ...overrides,
  };
}

function creative(
  id: string,
  status: string,
  scheduledFor: string | null,
  versions = 0,
) {
  return { id, status, scheduledFor: scheduledFor ? new Date(scheduledFor) : null, _count: { versions } };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  process.env.SEO_CONTENT_PLAN = "true";
  process.env.GSC_SYNC = "true";
  process.env.SEO_INSIGHTS = "on";
  process.env.GSC_SEARCH_PAGE = "true";
  delete process.env.GSC_ROLLOUT_PROJECTS;
  mocks.getProjectTimezone.mockResolvedValue("Europe/Istanbul");
  mocks.primaryGscLink.mockResolvedValue(LINK);
  mocks.readEngineState.mockResolvedValue({ lastWeek: "2026-09-28" });
  mocks.settingFind.mockResolvedValue(null);
  mocks.planFind.mockResolvedValue(planRow());
  mocks.creativeCount.mockResolvedValue(2);
  mocks.creativeFindMany.mockResolvedValue([
    creative("creative-1", "DRAFT", "2026-10-14T07:00:00Z"),
    creative("creative-2", "DRAFT", "2026-10-20T07:00:00Z"),
  ]);
  mocks.commandFindMany.mockResolvedValue([]);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function allPrismaCalls(): number {
  return [
    mocks.settingFind,
    mocks.settingUpsert,
    mocks.planFind,
    mocks.creativeCount,
    mocks.creativeFindMany,
    mocks.commandFindMany,
    mocks.primaryGscLink,
    mocks.readEngineState,
    mocks.getProjectTimezone,
  ].reduce((sum, fn) => sum + fn.mock.calls.length, 0);
}

describe("loadContentPlanView off", () => {
  it("returns null with zero reads when the flag is off", async () => {
    process.env.SEO_CONTENT_PLAN = "false";
    expect(await loadContentPlanView("p1", { now: NOW })).toBeNull();
    expect(allPrismaCalls()).toBe(0);
  });

  it("returns null with zero reads outside the rollout allow-list", async () => {
    process.env.GSC_ROLLOUT_PROJECTS = "other-project";
    expect(await loadContentPlanView("p1", { now: NOW })).toBeNull();
    expect(allPrismaCalls()).toBe(0);
  });
});

describe("settings", () => {
  it("returns the defaults without a row and never writes", async () => {
    expect(await readPlanSettings("p1")).toEqual({ monthlyCap: 4, autoPlan: true });
    expect(mocks.settingUpsert).not.toHaveBeenCalled();
  });

  it("reads a stored row", async () => {
    mocks.settingFind.mockResolvedValue({ monthlyCap: 8, autoPlan: false });
    expect(await readPlanSettings("p1")).toEqual({ monthlyCap: 8, autoPlan: false });
  });

  it("clamps the cap, saves and audits only numbers", async () => {
    mocks.settingUpsert.mockImplementation(async (args: { create: { monthlyCap: number; autoPlan: boolean } }) => ({
      id: "set-1",
      monthlyCap: args.create.monthlyCap,
      autoPlan: args.create.autoPlan,
    }));
    const saved = await savePlanSettings({
      workspaceId: "w1",
      projectId: "p1",
      userId: "u1",
      monthlyCap: 99,
      autoPlan: false,
    });
    expect(saved).toEqual({ monthlyCap: 12, autoPlan: false });
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "seo_content_plan.settings_saved",
        metadata: { cap: 12, autoPlan: false },
      }),
    );
  });
});

describe("loadContentPlanView states", () => {
  it("needs data without a primary link", async () => {
    mocks.primaryGscLink.mockResolvedValue(null);
    const view = await loadContentPlanView("p1", { now: NOW });
    expect(view).toMatchObject({ state: "needs_data", canPlanNow: false, canRefresh: false });
    expect(view!.cap).toBe(4);
  });

  it("needs data while the link has no weekly week or the engine has no state", async () => {
    mocks.primaryGscLink.mockResolvedValue({ ...LINK, lastWeeklyWeek: null });
    expect((await loadContentPlanView("p1", { now: NOW }))!.state).toBe("needs_data");
    mocks.primaryGscLink.mockResolvedValue(LINK);
    mocks.readEngineState.mockResolvedValue(null);
    expect((await loadContentPlanView("p1", { now: NOW }))!.state).toBe("needs_data");
  });

  it("waits when there is no plan row yet and the window is open", async () => {
    mocks.planFind.mockResolvedValue(null);
    const view = await loadContentPlanView("p1", { now: NOW });
    expect(view).toMatchObject({
      state: "waiting",
      emptyReason: null,
      canPlanNow: true,
      month: "2026-10",
      monthLabel: "October 2026",
    });
  });

  it("reads empty/NO_ROOM when the window is closed and no plan exists", async () => {
    mocks.planFind.mockResolvedValue(null);
    // 30 Ekim: ayın bitmesine 1 gün var, elle plan da kapalı.
    const view = await loadContentPlanView("p1", { now: new Date("2026-10-30T09:00:00Z") });
    expect(view).toMatchObject({ state: "empty", emptyReason: "NO_ROOM", canPlanNow: false });
    expect(view!.emptyText).toContain("Too few days");
  });

  it("reads an EMPTY row with its reason and lets the user plan now", async () => {
    mocks.planFind.mockResolvedValue(
      planRow({ status: "EMPTY", data: planDataFixture({ slots: [], reason: "CAP_FULL" }) }),
    );
    const view = await loadContentPlanView("p1", { now: NOW });
    expect(view).toMatchObject({
      state: "empty",
      emptyReason: "CAP_FULL",
      canPlanNow: true,
      canRefresh: false,
    });
    expect(view!.emptyText).toBe("You already have all the articles this month's limit allows.");
  });

  it("does not offer a manual plan for another month", async () => {
    mocks.planFind.mockResolvedValue(null);
    const view = await loadContentPlanView("p1", { now: NOW, month: "2026-09" });
    expect(view).toMatchObject({ month: "2026-09", state: "empty", canPlanNow: false });
  });
});

describe("loadContentPlanView ready", () => {
  it("counts the month's pieces for the usage figure", async () => {
    mocks.creativeCount.mockResolvedValue(3);
    const view = await loadContentPlanView("p1", { now: NOW });
    expect(view).toMatchObject({ state: "ready", used: 3, cap: 4, planned: 2 });
    const where = mocks.creativeCount.mock.calls[0]![0].where;
    expect(where.formatKey).toBe("seo.article");
  });

  it("maps slot states from the creatives, never from the plan JSON", async () => {
    mocks.planFind.mockResolvedValue(
      planRow({
        data: planDataFixture({
          slots: [
            slotFixture({ id: "s1", creativeId: "c1", ideaId: "i1", date: "2026-10-12" }),
            slotFixture({ id: "s2", creativeId: "c2", ideaId: "i2", date: "2026-10-13" }),
            slotFixture({ id: "s3", creativeId: "c3", ideaId: "i3", date: "2026-10-14" }),
            slotFixture({ id: "s4", creativeId: "c4", ideaId: "i4", date: "2026-10-15" }),
            slotFixture({ id: "s5", creativeId: "c5", ideaId: "i5", status: "SKIPPED" }),
            slotFixture({ id: "s6", creativeId: "c6", ideaId: "i6", status: "REMOVED" }),
            slotFixture({ id: "s7", creativeId: "c7", ideaId: "i7", date: "2026-10-01" }),
          ],
          nextSlot: 8,
        }),
      }),
    );
    mocks.creativeFindMany.mockResolvedValue([
      creative("c1", "DRAFT", "2026-10-12T07:00:00Z"),
      creative("c2", "DRAFT", "2026-10-13T07:00:00Z"),
      creative("c3", "APPROVED", "2026-10-14T07:00:00Z", 1),
      creative("c4", "PUBLISHED", "2026-10-05T07:00:00Z", 1),
      creative("c5", "ARCHIVED", "2026-10-16T07:00:00Z"),
      creative("c7", "DRAFT", "2026-10-01T07:00:00Z"),
    ]);
    // s2'nin fikrinde teslim edilmemiş etkin SEO kartı var.
    mocks.commandFindMany.mockResolvedValue([
      {
        workId: "work-9",
        parsedIntent: { card: { kind: "module-flow", module: "seo", data: { hint: { ideaId: "i2" } } } },
      },
    ]);
    const view = await loadContentPlanView("p1", { now: NOW });
    const byId = new Map(view!.slots.map((slot) => [slot.id, slot]));
    expect(byId.has("s6")).toBe(false);
    expect(byId.get("s1")).toMatchObject({
      state: "PLANNED",
      stateLabel: "Planned",
      canWrite: true,
      canSkip: true,
      canMove: true,
      canReplace: true,
      date: "2026-10-12",
      time: "10:00",
      writeHref: "/projects/p1?module=seo&idea=i1",
    });
    expect(byId.get("s2")).toMatchObject({
      state: "IN_PROGRESS",
      canWrite: false,
      canContinue: true,
      canSkip: false,
      writeHref: null,
      continueHref: "/projects/p1?work=work-9",
    });
    expect(byId.get("s3")).toMatchObject({ state: "SCHEDULED", canWrite: false, canSkip: false });
    expect(byId.get("s4")).toMatchObject({ state: "PUBLISHED" });
    expect(byId.get("s5")).toMatchObject({ state: "SKIPPED", canWrite: false, canReplace: false });
    expect(byId.get("s7")).toMatchObject({ state: "OVERDUE", canWrite: true });
    // Tek Command sorgusu, yalnız PLANNED slot fikirleriyle.
    expect(mocks.commandFindMany).toHaveBeenCalledTimes(1);
    const or = mocks.commandFindMany.mock.calls[0]![0].where.AND[2].OR;
    expect(or).toHaveLength(5);
  });

  it("ignores a delivered card (the article is already placed)", async () => {
    mocks.commandFindMany.mockResolvedValue([
      {
        workId: "w",
        parsedIntent: {
          card: { kind: "module-flow", module: "seo", data: { hint: { ideaId: "idea-1" }, delivery: { creativeId: "x" } } },
        },
      },
    ]);
    const view = await loadContentPlanView("p1", { now: NOW });
    expect(view!.slots.find((slot) => slot.id === "s1")!.canContinue).toBe(false);
  });

  it("derives canRefresh from the left refreshes and the replaceable slots", async () => {
    expect((await loadContentPlanView("p1", { now: NOW }))!).toMatchObject({
      canRefresh: true,
      regenerationsLeft: 3,
    });
    mocks.planFind.mockResolvedValue(planRow({ regenerations: 3 }));
    expect((await loadContentPlanView("p1", { now: NOW }))!).toMatchObject({
      canRefresh: false,
      regenerationsLeft: 0,
    });
    // Her slot yazılmış/planlanmış: değiştirilecek bir şey yok.
    mocks.planFind.mockResolvedValue(planRow());
    mocks.creativeFindMany.mockResolvedValue([
      creative("creative-1", "APPROVED", "2026-10-14T07:00:00Z", 1),
      creative("creative-2", "APPROVED", "2026-10-20T07:00:00Z", 1),
    ]);
    expect((await loadContentPlanView("p1", { now: NOW }))!.canRefresh).toBe(false);
  });

  it("adds the no-crawl note when no slot has verified links and exposes pillar views", async () => {
    mocks.planFind.mockResolvedValue(
      planRow({
        data: planDataFixture({
          slots: [slotFixture({ id: "s1", linksVerified: false, creativeId: "creative-1" })],
          pillars: [
            {
              clusterId: "c-strong",
              name: "Dental implants",
              impressions: 5400,
              share: 0.12,
              pillarUrl: "https://example.com/a",
              pillarPath: "/a",
              weak: false,
              slotIds: ["s1"],
            },
            {
              clusterId: "c-weak",
              name: "Whitening",
              impressions: 100,
              share: 0.004,
              pillarUrl: null,
              pillarPath: null,
              weak: true,
              slotIds: [],
            },
          ],
        }),
      }),
    );
    const view = await loadContentPlanView("p1", { now: NOW });
    expect(view!.notes.join(" ")).toContain("turn on the site scan");
    expect(view!.pillars[0]).toEqual({
      clusterId: "c-strong",
      name: "Dental implants",
      sharePct: 12,
      pillarPath: "/a",
      weak: false,
      articles: 1,
    });
    expect(view!.pillars[1]).toMatchObject({ weak: true, pillarPath: null, articles: 0 });
  });
});

describe("activeSeoCards", () => {
  it("makes no query for an empty list", async () => {
    const result = await activeSeoCards({ command: { findMany: mocks.commandFindMany } } as never, "p1", []);
    expect(result.size).toBe(0);
    expect(mocks.commandFindMany).not.toHaveBeenCalled();
  });
});

describe("localClock", () => {
  it("reads the project's local day and month", () => {
    expect(localClock("Europe/Istanbul", new Date("2026-09-30T22:00:00Z"))).toMatchObject({
      today: "2026-10-01",
      month: "2026-10",
    });
  });
});
