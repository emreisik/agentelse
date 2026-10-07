import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: ayarlar okunurken hiçbir şey yazılmaz (satır yoksa
// varsayılan 10), günlük sınır 1..25'e sıkıştırılır, denetim kaydının
// metadata'sına yalnız dailyLimit girer ve IndexNow görünümü yalnız
// SEO_INDEXNOW açıkken döner.

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  upsert: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    seoApplySetting: { findUnique: mocks.findUnique, upsert: mocks.upsert },
  },
}));
vi.mock("./audit", () => ({ recordSeoApplyAudit: mocks.audit }));

const { readApplySettings, saveApplySettings } = await import("./settings");

const KEY = "0123456789abcdef0123456789abcdef";

beforeEach(() => {
  vi.unstubAllEnvs();
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.upsert.mockResolvedValue({});
  mocks.audit.mockResolvedValue(undefined);
});

describe("readApplySettings", () => {
  it("returns defaults without writing when there is no row", async () => {
    mocks.findUnique.mockResolvedValue(null);
    const result = await readApplySettings("p1");
    expect(result).toEqual({ dailyLimit: 10, indexNow: null });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("clamps a stored out-of-range limit", async () => {
    mocks.findUnique.mockResolvedValue({ dailyLimit: 99 });
    expect((await readApplySettings("p1")).dailyLimit).toBe(25);
  });

  it("hides IndexNow while SEO_INDEXNOW is off", async () => {
    vi.stubEnv("SEO_APPLY", "true");
    vi.stubEnv("SEO_HEALTH", "true");
    mocks.findUnique.mockResolvedValue({
      dailyLimit: 5,
      indexNowEnabled: true,
      indexNowKey: KEY,
      indexNowHost: "example.com",
      indexNowVerifiedAt: new Date(),
      indexNowLastPingAt: null,
    });
    expect((await readApplySettings("p1")).indexNow).toBeNull();
  });

  it("builds the IndexNow view when the flag is on", async () => {
    vi.stubEnv("SEO_APPLY", "true");
    vi.stubEnv("SEO_HEALTH", "true");
    vi.stubEnv("SEO_INDEXNOW", "true");
    mocks.findUnique.mockResolvedValue({
      dailyLimit: 5,
      indexNowEnabled: true,
      indexNowKey: KEY,
      indexNowHost: "example.com",
      indexNowVerifiedAt: new Date("2026-10-01T00:00:00.000Z"),
      indexNowLastPingAt: new Date("2026-10-02T00:00:00.000Z"),
    });
    const result = await readApplySettings("p1");
    expect(result.dailyLimit).toBe(5);
    expect(result.indexNow).toEqual({
      enabled: true,
      key: KEY,
      keyFileName: `${KEY}.txt`,
      keyUrl: `https://example.com/${KEY}.txt`,
      verified: true,
      lastPingAt: "2026-10-02T00:00:00.000Z",
    });
  });
});

describe("saveApplySettings", () => {
  it("upserts the clamped limit and audits only dailyLimit", async () => {
    await saveApplySettings({
      projectId: "p1",
      workspaceId: "w1",
      userId: "u1",
      dailyLimit: 400,
    });
    expect(mocks.upsert).toHaveBeenCalledWith({
      where: { projectId: "p1" },
      create: { workspaceId: "w1", projectId: "p1", dailyLimit: 25 },
      update: { dailyLimit: 25 },
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      "seo_apply.settings_saved",
      { dailyLimit: 25 },
      { workspaceId: "w1", projectId: "p1", userId: "u1" },
    );
  });

  it("falls back to the default for a non-number", async () => {
    await saveApplySettings({
      projectId: "p1",
      workspaceId: "w1",
      userId: "u1",
      dailyLimit: Number.NaN,
    });
    expect(mocks.upsert.mock.calls[0]?.[0].update).toEqual({ dailyLimit: 10 });
  });
});
