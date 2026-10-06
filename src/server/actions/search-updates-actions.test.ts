import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: operatör olmayan kullanıcı ve kapalı bayrak
// reddedilir (yazım yok); geçersiz ya da ters tarihler reddedilir; yalnız
// MANUAL satırlar silinir; her başarılı eylem denetim kaydı yazar ve sayfayı
// yeniler.

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireWorkspaceMembership: vi.fn(),
  isPlatformOperator: vi.fn(),
  record: vi.fn(),
  revalidatePath: vi.fn(),
  create: vi.fn(),
  deleteMany: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/server/security/tenant-context", () => ({
  requireUser: mocks.requireUser,
  requireWorkspaceMembership: mocks.requireWorkspaceMembership,
}));
vi.mock("@/server/security/operator", () => ({
  isPlatformOperator: mocks.isPlatformOperator,
}));
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: mocks.record },
}));
vi.mock("@/server/observability/periodic", () => ({
  claimPeriodic: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    searchUpdate: { create: mocks.create, deleteMany: mocks.deleteMany },
  },
}));

const { addSearchUpdateAction, removeSearchUpdateAction } =
  await import("./search-updates-actions");

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

const VALID = {
  name: "October 2026 core update",
  kind: "CORE",
  startedAt: "2026-10-01",
  endedAt: "",
  url: "https://status.search.google.com/incidents/abc",
};

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  vi.stubEnv("SEO_HEALTH", "true");
  mocks.requireUser.mockResolvedValue({ userId: "op-1" });
  mocks.requireWorkspaceMembership.mockResolvedValue({ workspaceId: "w-1" });
  mocks.isPlatformOperator.mockReturnValue(true);
  mocks.create.mockResolvedValue({ id: "su-1" });
  mocks.record.mockResolvedValue({});
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("addSearchUpdateAction", () => {
  it("rejects a user who is not the platform operator", async () => {
    mocks.isPlatformOperator.mockReturnValue(false);
    const result = await addSearchUpdateAction(form(VALID));
    expect(result).toEqual({
      ok: false,
      message: "Only the platform operator can do this.",
    });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("is unavailable while SEO_HEALTH is off", async () => {
    vi.stubEnv("SEO_HEALTH", "");
    const result = await addSearchUpdateAction(form(VALID));
    expect(result.ok).toBe(false);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("rejects invalid days, reversed ranges, bad kinds and plain http links", async () => {
    for (const values of [
      { ...VALID, startedAt: "" },
      { ...VALID, startedAt: "2026-02-30" },
      { ...VALID, startedAt: "01/10/2026" },
      { ...VALID, endedAt: "2026-09-01" },
      { ...VALID, kind: "SOMETHING" },
      { ...VALID, url: "http://status.search.google.com/x" },
      { ...VALID, name: "" },
    ]) {
      const result = await addSearchUpdateAction(form(values));
      expect(result.ok).toBe(false);
    }
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("adds a MANUAL row and records the audit entry", async () => {
    const result = await addSearchUpdateAction(
      form({ ...VALID, endedAt: "2026-10-03" }),
    );
    expect(result).toEqual({ ok: true });
    expect(mocks.create).toHaveBeenCalledWith({
      data: {
        externalId: null,
        name: "October 2026 core update",
        kind: "CORE",
        source: "MANUAL",
        startedAt: new Date("2026-10-01T00:00:00.000Z"),
        endedAt: new Date("2026-10-03T00:00:00.000Z"),
        url: "https://status.search.google.com/incidents/abc",
        createdByUserId: "op-1",
      },
      select: { id: true },
    });
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "w-1",
        actorType: "USER",
        actorId: "op-1",
        action: "search_update.added",
        entityType: "SearchUpdate",
        entityId: "su-1",
      }),
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/health/search-updates");
  });
});

describe("removeSearchUpdateAction", () => {
  it("removes only MANUAL rows", async () => {
    mocks.deleteMany.mockResolvedValueOnce({ count: 0 });
    const refused = await removeSearchUpdateAction(form({ id: "feed-row" }));
    expect(refused.ok).toBe(false);
    expect(mocks.deleteMany).toHaveBeenCalledWith({
      where: { id: "feed-row", source: "MANUAL" },
    });
    expect(mocks.record).not.toHaveBeenCalled();

    mocks.deleteMany.mockResolvedValueOnce({ count: 1 });
    const removed = await removeSearchUpdateAction(form({ id: "su-1" }));
    expect(removed).toEqual({ ok: true });
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "search_update.removed",
        entityType: "SearchUpdate",
        entityId: "su-1",
      }),
    );
  });

  it("rejects a user who is not the platform operator", async () => {
    mocks.isPlatformOperator.mockReturnValue(false);
    const result = await removeSearchUpdateAction(form({ id: "su-1" }));
    expect(result.ok).toBe(false);
    expect(mocks.deleteMany).not.toHaveBeenCalled();
  });
});
