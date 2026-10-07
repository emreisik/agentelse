import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: bağ listesi boşsa hiçbir sorgu yapılmaz; öğrenmeler
// learningId YA DA sourceRef ile silinir (sourceType'ı yeniden yazılmış satır
// da gider); eylemler 500'lük dilimlerle silinir; kimlik bilgisi yolu kart
// temizliğini benzersiz proje kimlikleriyle çağırır ve temizleme hatası eylem
// silmeyi durdurmaz.

const mocks = vi.hoisted(() => ({
  actionFindMany: vi.fn(),
  actionDeleteMany: vi.fn(),
  learningDeleteMany: vi.fn(),
  linkFindMany: vi.fn(),
  scrub: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    seoAction: {
      findMany: mocks.actionFindMany,
      deleteMany: mocks.actionDeleteMany,
    },
    brandLearning: { deleteMany: mocks.learningDeleteMany },
    gscSiteLink: { findMany: mocks.linkFindMany },
  },
}));
vi.mock("@/server/modules/seo/forget-cards", () => ({
  scrubSeoCardsSearchData: mocks.scrub,
}));

import {
  forgetSeoActionsForCredential,
  forgetSeoActionsForLinks,
  forgetSeoActionsForProjectMode,
} from "./forget";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.actionDeleteMany.mockImplementation(async ({ where }) => ({
    count: where.id.in.length,
  }));
  mocks.learningDeleteMany.mockImplementation(async () => ({ count: 1 }));
  mocks.scrub.mockResolvedValue(2);
});

describe("forgetSeoActionsForLinks", () => {
  it("does nothing, and queries nothing, for an empty list", async () => {
    expect(await forgetSeoActionsForLinks([])).toEqual({
      actions: 0,
      learnings: 0,
    });
    expect(mocks.actionFindMany).not.toHaveBeenCalled();
    expect(mocks.learningDeleteMany).not.toHaveBeenCalled();
  });

  it("deletes learnings by learningId or sourceRef, whatever their source type", async () => {
    mocks.actionFindMany.mockResolvedValueOnce([
      { id: "a1", learningId: "l1" },
      { id: "a2", learningId: null },
    ]);
    const result = await forgetSeoActionsForLinks(["link-1", "link-1"]);
    expect(result).toEqual({ actions: 2, learnings: 1 });
    expect(mocks.actionFindMany.mock.calls[0]![0].where).toEqual({
      linkId: { in: ["link-1"] },
    });
    const where = mocks.learningDeleteMany.mock.calls[0]![0].where;
    expect(where).toEqual({
      OR: [{ id: { in: ["l1"] } }, { sourceRef: { in: ["a1", "a2"] } }],
    });
    expect(JSON.stringify(where)).not.toContain("sourceType");
    // Öğrenmeler eylemlerden ÖNCE silinir.
    expect(mocks.learningDeleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.actionDeleteMany.mock.invocationCallOrder[0]!,
    );
  });

  it("works through the rows in chunks of 500", async () => {
    const chunk = Array.from({ length: 500 }, (_, index) => ({
      id: `a${index}`,
      learningId: null,
    }));
    mocks.actionFindMany
      .mockResolvedValueOnce(chunk)
      .mockResolvedValueOnce([{ id: "last", learningId: null }]);
    const result = await forgetSeoActionsForLinks(["link-1"]);
    expect(result.actions).toBe(501);
    expect(mocks.actionFindMany).toHaveBeenCalledTimes(2);
    expect(mocks.actionFindMany.mock.calls[0]![0].take).toBe(500);
  });
});

describe("forgetSeoActionsForCredential", () => {
  it("scrubs the cards of the distinct projects of the credential's links", async () => {
    mocks.linkFindMany.mockResolvedValue([
      { id: "l1", projectId: "p1" },
      { id: "l2", projectId: "p1" },
      { id: "l3", projectId: "p2" },
    ]);
    mocks.actionFindMany.mockResolvedValueOnce([
      { id: "a1", learningId: null },
    ]);
    const result = await forgetSeoActionsForCredential("cred-1");
    expect(result).toEqual({ actions: 1, learnings: 1, cards: 2 });
    expect(mocks.scrub).toHaveBeenCalledWith(["p1", "p2"]);
    expect(mocks.actionFindMany.mock.calls[0]![0].where).toEqual({
      linkId: { in: ["l1", "l2", "l3"] },
    });
  });

  it("still deletes the actions when the card scrub fails", async () => {
    mocks.linkFindMany.mockResolvedValue([{ id: "l1", projectId: "p1" }]);
    mocks.actionFindMany.mockResolvedValueOnce([
      { id: "a1", learningId: null },
    ]);
    mocks.scrub.mockRejectedValue(new Error("boom"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await forgetSeoActionsForCredential("cred-1");
    spy.mockRestore();
    expect(result).toEqual({ actions: 1, learnings: 1, cards: 0 });
    expect(mocks.actionDeleteMany).toHaveBeenCalledTimes(1);
  });

  it("makes no card call when the credential has no links", async () => {
    mocks.linkFindMany.mockResolvedValue([]);
    const result = await forgetSeoActionsForCredential("cred-1");
    expect(result).toEqual({ actions: 0, learnings: 0, cards: 0 });
    expect(mocks.scrub).not.toHaveBeenCalled();
  });
});

describe("forgetSeoActionsForProjectMode", () => {
  it("covers one mode's links and scrubs that project's cards", async () => {
    mocks.linkFindMany.mockResolvedValue([{ id: "l1" }]);
    mocks.actionFindMany.mockResolvedValueOnce([{ id: "a1", learningId: "x" }]);
    const result = await forgetSeoActionsForProjectMode("p1", true);
    expect(mocks.linkFindMany.mock.calls[0]![0].where).toEqual({
      projectId: "p1",
      isMock: true,
    });
    expect(mocks.scrub).toHaveBeenCalledWith(["p1"]);
    expect(result).toEqual({ actions: 1, learnings: 1, cards: 2 });
  });
});
