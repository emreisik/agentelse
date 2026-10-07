import { beforeEach, describe, expect, it, vi } from "vitest";

// Saklama taraması: yalnız Search Console bağı hiç kalmamış projelerin SEO
// kartları temizlenir; bağı olan proje dokunulmaz.

const mocks = vi.hoisted(() => ({
  groupBy: vi.fn(),
  findMany: vi.fn(),
  linkFindMany: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    command: { groupBy: mocks.groupBy, findMany: mocks.findMany },
    gscSiteLink: { findMany: mocks.linkFindMany },
  },
}));
vi.mock("@/server/chat/card-store", () => ({
  updateCommandCard: vi.fn(),
}));

const { sweepOrphanSeoCardsSearchData } = await import("./forget-cards");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findMany.mockResolvedValue([]);
});

describe("sweepOrphanSeoCardsSearchData", () => {
  it("does nothing without SEO cards", async () => {
    mocks.groupBy.mockResolvedValue([]);
    expect(await sweepOrphanSeoCardsSearchData()).toBe(0);
    expect(mocks.linkFindMany).not.toHaveBeenCalled();
  });

  it("scrubs only projects that have no Search Console link", async () => {
    mocks.groupBy.mockResolvedValue([
      { projectId: "p-linked" },
      { projectId: "p-orphan" },
    ]);
    mocks.linkFindMany.mockResolvedValue([{ projectId: "p-linked" }]);
    await sweepOrphanSeoCardsSearchData();
    expect(mocks.findMany).toHaveBeenCalledTimes(1);
    expect(mocks.findMany.mock.calls[0]![0].where.projectId).toEqual({
      in: ["p-orphan"],
    });
  });

  it("skips the card scan when every project is still linked", async () => {
    mocks.groupBy.mockResolvedValue([{ projectId: "p-linked" }]);
    mocks.linkFindMany.mockResolvedValue([{ projectId: "p-linked" }]);
    expect(await sweepOrphanSeoCardsSearchData()).toBe(0);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });
});
