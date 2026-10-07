import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: kapı kapalıyken sıfır prisma/okuma; birincil bağ
// yoksa pasif; ay, sınır, kullanım ve "dolu"; fikrin slotu varsa hasSlot;
// geçersiz saat dilimi varsayılana düşer.

const mocks = vi.hoisted(() => ({
  primaryLink: vi.fn(),
  timezone: vi.fn(),
  count: vi.fn(),
  settingFindUnique: vi.fn(),
  creativeFindFirst: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    seoContentSetting: { findUnique: mocks.settingFindUnique },
    creative: { findFirst: mocks.creativeFindFirst },
  },
}));
vi.mock("@/server/seo/store", () => ({ primaryGscLink: mocks.primaryLink }));
vi.mock("@/server/chat/content-plan", () => ({
  getProjectTimezone: mocks.timezone,
}));
vi.mock("./pieces", () => ({ countSeoPiecesInMonth: mocks.count }));

const { seoMonthCapStatus, safeTimezone } = await import("./cap-status");

const NOW = new Date("2026-10-07T12:00:00.000Z");
const ENV_KEYS = [
  "SEO_CONTENT_PLAN",
  "GSC_SYNC",
  "SEO_INSIGHTS",
  "GSC_SEARCH_PAGE",
  "GSC_ROLLOUT_PROJECTS",
] as const;
const saved: Record<string, string | undefined> = {};

function on() {
  process.env.SEO_CONTENT_PLAN = "true";
  process.env.GSC_SYNC = "true";
  process.env.SEO_INSIGHTS = "on";
  process.env.GSC_SEARCH_PAGE = "true";
  delete process.env.GSC_ROLLOUT_PROJECTS;
}

function touched(): boolean {
  return Object.values(mocks).some((fn) => fn.mock.calls.length > 0);
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  on();
  mocks.primaryLink.mockResolvedValue({ id: "link-1" });
  mocks.timezone.mockResolvedValue("Europe/Istanbul");
  mocks.settingFindUnique.mockResolvedValue(null);
  mocks.count.mockResolvedValue(2);
  mocks.creativeFindFirst.mockResolvedValue(null);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("seoMonthCapStatus", () => {
  it("makes no read at all when the flag is off", async () => {
    process.env.SEO_CONTENT_PLAN = "false";
    expect(await seoMonthCapStatus("p1", { ideaId: "i1", now: NOW })).toEqual({
      active: false,
    });
    expect(touched()).toBe(false);
  });

  it("makes no read for a project outside the allow-list", async () => {
    process.env.GSC_ROLLOUT_PROJECTS = "other";
    expect(await seoMonthCapStatus("p1", { now: NOW })).toEqual({
      active: false,
    });
    expect(touched()).toBe(false);
  });

  it("is inactive without a primary Search Console link and reads nothing more", async () => {
    mocks.primaryLink.mockResolvedValue(null);
    expect(await seoMonthCapStatus("p1", { now: NOW })).toEqual({
      active: false,
    });
    expect(mocks.count).not.toHaveBeenCalled();
    expect(mocks.settingFindUnique).not.toHaveBeenCalled();
  });

  it("reports the default cap 4, the used count and the current local month", async () => {
    expect(await seoMonthCapStatus("p1", { now: NOW })).toEqual({
      active: true,
      cap: 4,
      used: 2,
      month: "2026-10",
      full: false,
      hasSlot: false,
    });
    expect(mocks.count).toHaveBeenCalledWith(expect.anything(), {
      projectId: "p1",
      month: "2026-10",
      timezone: "Europe/Istanbul",
    });
    // Slot sorgusu ideaId yokken atılmaz.
    expect(mocks.creativeFindFirst).not.toHaveBeenCalled();
  });

  it("uses the project-local month at a month boundary", async () => {
    // 31 Ekim 22:30 UTC = 1 Kasım 01:30 İstanbul.
    const result = await seoMonthCapStatus("p1", {
      now: new Date("2026-10-31T22:30:00.000Z"),
    });
    expect(result).toMatchObject({ active: true, month: "2026-11" });
  });

  it("honours an explicit month and the saved cap; full when used reaches it", async () => {
    mocks.settingFindUnique.mockResolvedValue({ monthlyCap: 2, autoPlan: true });
    const result = await seoMonthCapStatus("p1", { month: "2026-12" });
    expect(result).toMatchObject({
      active: true,
      cap: 2,
      used: 2,
      month: "2026-12",
      full: true,
    });
  });

  it("reports hasSlot when the idea still has an untouched planned slot", async () => {
    mocks.creativeFindFirst.mockResolvedValue({ id: "cr-1" });
    const result = await seoMonthCapStatus("p1", { ideaId: "i1", now: NOW });
    expect(result).toMatchObject({ active: true, hasSlot: true });
    expect(mocks.creativeFindFirst).toHaveBeenCalledWith({
      where: {
        projectId: "p1",
        formatKey: "seo.article",
        status: "DRAFT",
        planId: null,
        excludedAt: null,
        versions: { none: {} },
        post: { ideaId: "i1" },
      },
      select: { id: true },
    });
  });

  it("falls back to the default zone for a timezone the runtime does not know", async () => {
    mocks.timezone.mockResolvedValue("UTC+3");
    await seoMonthCapStatus("p1", { now: NOW });
    expect(mocks.count.mock.calls[0]?.[1].timezone).toBe("Europe/Istanbul");
    expect(safeTimezone("UTC+3")).toBe("Europe/Istanbul");
    expect(safeTimezone("America/New_York")).toBe("America/New_York");
  });
});
