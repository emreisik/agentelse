import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: seçili ek mülk geçersiz kılması yokken
// primaryGaLink bugünkü sorguyu birebir atar; geçersiz kılma içinde aynı
// projeye ait seçili bağı sorgusuz verir, başka projede yine bugünkü sorgu.

const db = vi.hoisted(() => ({ gaPropertyLink: { findFirst: vi.fn() } }));
vi.mock("@/lib/prisma", () => ({ prisma: db }));

const { primaryGaLink } = await import("./store");
const { withSelectedGaLink } = await import("./agency/selected-link");

beforeEach(() => {
  db.gaPropertyLink.findFirst.mockReset();
  db.gaPropertyLink.findFirst.mockResolvedValue({ id: "main" });
});

describe("primaryGaLink", () => {
  it("issues exactly today's query without an override", async () => {
    expect(await primaryGaLink("p1")).toEqual({ id: "main" });
    expect(db.gaPropertyLink.findFirst).toHaveBeenCalledTimes(1);
    expect(db.gaPropertyLink.findFirst).toHaveBeenCalledWith({
      where: { projectId: "p1", isPrimary: true },
      orderBy: { updatedAt: "desc" },
    });
  });

  it("returns the selected extra inside the override without a query", async () => {
    const extra = { id: "extra", projectId: "p1" };
    const result = await withSelectedGaLink(
      extra as never,
      async () => primaryGaLink("p1"),
    );
    expect(result).toBe(extra);
    expect(db.gaPropertyLink.findFirst).not.toHaveBeenCalled();
  });

  it("queries normally for another project inside the override", async () => {
    const extra = { id: "extra", projectId: "p1" };
    const result = await withSelectedGaLink(
      extra as never,
      async () => primaryGaLink("p2"),
    );
    expect(result).toEqual({ id: "main" });
    expect(db.gaPropertyLink.findFirst).toHaveBeenCalledWith({
      where: { projectId: "p2", isPrimary: true },
      orderBy: { updatedAt: "desc" },
    });
  });
});
