import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  upsert: vi.fn(),
  findUnique: vi.fn(),
  record: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    brandVisualIdentity: {
      upsert: mocks.upsert,
      findUnique: mocks.findUnique,
    },
  },
}));
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: mocks.record },
}));
vi.mock("@/server/security/tenant-context", () => ({
  requireUser: async () => ({ userId: "u1" }),
  requireProjectAccess: async () => ({
    workspaceId: "w1",
    defaultBrandId: "b1",
  }),
}));

import { Prisma } from "@prisma/client";

import { updateDesignLookAction } from "./brand-layout-actions";

const saved = () => mocks.upsert.mock.calls[0]![0].update.designProfile;

describe("updateDesignLookAction", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.record.mockResolvedValue(undefined);
    mocks.findUnique.mockResolvedValue(null);
  });

  it("saves a design for one format of the caller's own brand", async () => {
    const result = await updateDesignLookAction("p1", "story", "statement");
    expect(result).toEqual({ ok: true });
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { brandId: "b1" },
        create: expect.objectContaining({ brandId: "b1", workspaceId: "w1" }),
      }),
    );
    expect(saved()).toEqual({ formats: { story: "statement" }, source: "user" });
  });

  it("keeps the other formats' picks when one changes", async () => {
    mocks.findUnique.mockResolvedValue({
      designProfile: { formats: { feed: "editorial", square: "promo" }, source: "user" },
    });
    await updateDesignLookAction("p1", "square", "info");
    expect(saved()).toEqual({
      formats: { feed: "editorial", square: "info" },
      source: "user",
    });
  });

  it("sets every format at once", async () => {
    await updateDesignLookAction("p1", "all", "promo");
    expect(saved().formats).toEqual({
      feed: "promo",
      square: "promo",
      landscape: "promo",
      story: "promo",
    });
  });

  it("takes one format back to automatic, and everything back with the last one", async () => {
    mocks.findUnique.mockResolvedValue({
      designProfile: { formats: { feed: "editorial", story: "info" }, source: "user" },
    });
    await updateDesignLookAction("p1", "feed", null);
    expect(saved()).toEqual({ formats: { story: "info" }, source: "user" });

    mocks.upsert.mockClear();
    mocks.findUnique.mockResolvedValue({
      designProfile: { formats: { story: "info" }, source: "user" },
    });
    await updateDesignLookAction("p1", "story", null);
    expect(saved()).toBe(Prisma.DbNull);
  });

  it("refuses a design or a format that does not exist, writing nothing", async () => {
    expect(await updateDesignLookAction("p1", "feed", "nonsense")).toMatchObject({ ok: false });
    expect(await updateDesignLookAction("p1", "tiktok" as never, "promo")).toMatchObject({ ok: false });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
});
