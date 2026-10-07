import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: plan o proje için etkin değilse (bayrak kapalı ya da
// izin listesi dışı) "" ve sıfır sorgu; etkinse tek sayım ve 1 / 3 slot metni.

const mocks = vi.hoisted(() => ({ count: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  prisma: { creative: { count: mocks.count } },
}));

const { weeklySeoNote } = await import("./weekly");

const FROM = new Date("2026-10-12T00:00:00.000Z");
const TO = new Date("2026-10-19T00:00:00.000Z");
const ENV_KEYS = [
  "SEO_CONTENT_PLAN",
  "GSC_SYNC",
  "SEO_INSIGHTS",
  "GSC_SEARCH_PAGE",
  "GSC_ROLLOUT_PROJECTS",
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  process.env.SEO_CONTENT_PLAN = "true";
  process.env.GSC_SYNC = "true";
  process.env.SEO_INSIGHTS = "on";
  process.env.GSC_SEARCH_PAGE = "true";
  delete process.env.GSC_ROLLOUT_PROJECTS;
  mocks.count.mockResolvedValue(0);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("weeklySeoNote", () => {
  it("returns '' with no query when the flag is off", async () => {
    process.env.SEO_CONTENT_PLAN = "false";
    expect(await weeklySeoNote("p1", FROM, TO)).toBe("");
    expect(mocks.count).not.toHaveBeenCalled();
  });

  it("returns '' with no query for a project outside the allow-list", async () => {
    process.env.GSC_ROLLOUT_PROJECTS = "other";
    expect(await weeklySeoNote("p1", FROM, TO)).toBe("");
    expect(mocks.count).not.toHaveBeenCalled();
  });

  it("counts untouched slots due in the week with one query", async () => {
    await weeklySeoNote("p1", FROM, TO);
    expect(mocks.count).toHaveBeenCalledTimes(1);
    expect(mocks.count).toHaveBeenCalledWith({
      where: {
        projectId: "p1",
        formatKey: "seo.article",
        status: "DRAFT",
        planId: null,
        scheduledFor: { gte: FROM, lt: TO },
      },
    });
  });

  it("is empty when no slot is due", async () => {
    expect(await weeklySeoNote("p1", FROM, TO)).toBe("");
  });

  it("says so for one slot and for three", async () => {
    mocks.count.mockResolvedValue(1);
    expect(await weeklySeoNote("p1", FROM, TO)).toBe(
      "One SEO article from this month's plan is also due this week.",
    );
    mocks.count.mockResolvedValue(3);
    expect(await weeklySeoNote("p1", FROM, TO)).toBe(
      "3 SEO articles from this month's plan are also due this week.",
    );
  });
});
