import { describe, expect, it, vi } from "vitest";

import {
  archiveSlotPiecesInTx,
  countSeoPiecesInMonth,
  createSlotPiecesInTx,
  deleteSlotPiecesInTx,
  monthRangeUtc,
  seoPieceDaysInMonth,
} from "./pieces";

// Bu dosyanın kanıtladığı: slot parçaları yalnız DRAFT, planId'siz ve sürümsüz
// yazılır (onay yok); arşiv/silme where'i DRAFT + sürümsüz + planId'siz taşır
// ve yalnız gerçekten dokunulanları bildirir; ay aralığı DST'de doğru.

function fakeTx() {
  return {
    post: {
      create: vi.fn().mockResolvedValue({ id: "post-1" }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    creative: {
      create: vi.fn().mockResolvedValue({ id: "cr-1" }),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      count: vi.fn().mockResolvedValue(0),
    },
    creativeVersion: { create: vi.fn() },
  };
}

const scope = { workspaceId: "w1", projectId: "p1", brandId: "b1" };

describe("createSlotPiecesInTx", () => {
  it("writes a DRAFT post and creative without plan id, version or approval", async () => {
    const tx = fakeTx();
    const refs = await createSlotPiecesInTx(tx as never, scope, {
      timezone: "Europe/Istanbul",
      items: [
        {
          date: "2026-10-14",
          time: "10:00",
          title: "How to repot a cactus",
          brief: "Planned SEO article.",
          ideaId: "idea-1",
        },
      ],
    });
    expect(refs).toEqual([{ postId: "post-1", creativeId: "cr-1" }]);

    const post = tx.post.create.mock.calls[0]![0].data;
    expect(post).toMatchObject({
      workId: null,
      planId: null,
      ideaId: "idea-1",
      topic: "How to repot a cactus",
      goal: "traffic",
      timezone: "Europe/Istanbul",
    });
    expect(post).not.toHaveProperty("approvedAt");
    expect(post.scheduledFor.toISOString()).toBe("2026-10-14T07:00:00.000Z");

    const creative = tx.creative.create.mock.calls[0]![0].data;
    expect(creative).toMatchObject({
      status: "DRAFT",
      planId: null,
      postId: "post-1",
      channel: "seo",
      formatKey: "seo.article",
      goal: "traffic",
    });
    expect(creative.scheduledFor.toISOString()).toBe(
      "2026-10-14T07:00:00.000Z",
    );
    expect(tx.creativeVersion.create).not.toHaveBeenCalled();
  });
});

describe("archiveSlotPiecesInTx", () => {
  it("archives only untouched creatives and reports exactly those", async () => {
    const tx = fakeTx();
    tx.creative.findMany.mockResolvedValue([{ id: "cr-1", postId: "post-1" }]);
    const result = await archiveSlotPiecesInTx(
      tx as never,
      "p1",
      [
        { postId: "post-1", creativeId: "cr-1" },
        { postId: "post-2", creativeId: "cr-2" },
      ],
      new Date("2026-10-10T00:00:00Z"),
    );
    expect(result).toEqual({ archived: ["cr-1"] });
    const where = tx.creative.updateMany.mock.calls[0]![0].where;
    expect(where).toMatchObject({
      projectId: "p1",
      status: "DRAFT",
      planId: null,
      versions: { none: {} },
      id: { in: ["cr-1"] },
    });
    expect(tx.creative.updateMany.mock.calls[0]![0].data).toEqual({
      status: "ARCHIVED",
    });
    // Post yalnız arşivlenen creative'in Post'u.
    expect(tx.post.updateMany.mock.calls[0]![0].where.id).toEqual({
      in: ["post-1"],
    });
  });

  it("does nothing when no piece is untouched", async () => {
    const tx = fakeTx();
    const result = await archiveSlotPiecesInTx(
      tx as never,
      "p1",
      [{ postId: "post-1", creativeId: "cr-1" }],
      new Date(),
    );
    expect(result).toEqual({ archived: [] });
    expect(tx.creative.updateMany).not.toHaveBeenCalled();
    expect(tx.post.updateMany).not.toHaveBeenCalled();
  });

  it("makes no query for an empty list", async () => {
    const tx = fakeTx();
    await archiveSlotPiecesInTx(tx as never, "p1", [], new Date());
    expect(tx.creative.findMany).not.toHaveBeenCalled();
  });
});

describe("deleteSlotPiecesInTx", () => {
  it("deletes the creative first, then posts without deliveries", async () => {
    const tx = fakeTx();
    const order: string[] = [];
    tx.creative.findMany.mockResolvedValue([{ id: "cr-1", postId: "post-1" }]);
    tx.creative.deleteMany.mockImplementation(async () => {
      order.push("creative");
      return { count: 1 };
    });
    tx.post.deleteMany.mockImplementation(async () => {
      order.push("post");
      return { count: 1 };
    });
    const result = await deleteSlotPiecesInTx(tx as never, "p1", [
      { postId: "post-1", creativeId: "cr-1" },
    ]);
    expect(result).toEqual({ deleted: ["cr-1"] });
    expect(order).toEqual(["creative", "post"]);
    // Atlanan/değiştirilen yuvanın arşivlenmiş parçası da silinir.
    expect(tx.creative.deleteMany.mock.calls[0]![0].where).toMatchObject({
      status: { in: ["DRAFT", "ARCHIVED"] },
      planId: null,
      versions: { none: {} },
    });
    expect(tx.post.deleteMany.mock.calls[0]![0].where).toMatchObject({
      deliveries: { none: {} },
    });
  });
});

describe("countSeoPiecesInMonth", () => {
  it("counts seo.article pieces of the local month that are not archived", async () => {
    const tx = fakeTx();
    tx.creative.count.mockResolvedValue(3);
    const count = await countSeoPiecesInMonth(tx as never, {
      projectId: "p1",
      month: "2026-10",
      timezone: "Europe/Istanbul",
      excludeCreativeId: "cr-9",
    });
    expect(count).toBe(3);
    const where = tx.creative.count.mock.calls[0]![0].where;
    expect(where).toMatchObject({
      projectId: "p1",
      formatKey: "seo.article",
      status: { notIn: ["ARCHIVED", "REJECTED"] },
      excludedAt: null,
      id: { not: "cr-9" },
    });
    expect(where.scheduledFor.gte.toISOString()).toBe(
      "2026-09-30T21:00:00.000Z",
    );
    expect(where.scheduledFor.lt.toISOString()).toBe("2026-10-31T21:00:00.000Z");
  });

  it("lists the distinct local days of the month's pieces", async () => {
    const tx = fakeTx();
    tx.creative.findMany.mockResolvedValue([
      { scheduledFor: new Date("2026-10-14T07:00:00Z") },
      { scheduledFor: new Date("2026-10-14T08:00:00Z") },
      { scheduledFor: new Date("2026-10-20T22:30:00Z") },
      { scheduledFor: null },
    ]);
    const days = await seoPieceDaysInMonth(tx as never, {
      projectId: "p1",
      month: "2026-10",
      timezone: "Europe/Istanbul",
    });
    expect(days).toEqual(["2026-10-14", "2026-10-21"]);
  });
});

describe("monthRangeUtc", () => {
  const iso = (range: { from: Date; to: Date }) => [
    range.from.toISOString(),
    range.to.toISOString(),
  ];

  it("uses a fixed offset in Europe/Istanbul", () => {
    expect(iso(monthRangeUtc("2026-03", "Europe/Istanbul"))).toEqual([
      "2026-02-28T21:00:00.000Z",
      "2026-03-31T21:00:00.000Z",
    ]);
  });

  it("follows DST in America/New_York (March start)", () => {
    // 8 Mart 2026'da yaz saati başlar: ay başı UTC-5, ay sonu (1 Nisan) UTC-4;
    // ay kendi yerel gece yarılarıyla sınırlanır.
    expect(iso(monthRangeUtc("2026-03", "America/New_York"))).toEqual([
      "2026-03-01T05:00:00.000Z",
      "2026-04-01T04:00:00.000Z",
    ]);
  });

  it("follows DST in America/New_York (November end)", () => {
    // 1 Kasım 2026'da yaz saati biter (02:00).
    expect(iso(monthRangeUtc("2026-11", "America/New_York"))).toEqual([
      "2026-11-01T04:00:00.000Z",
      "2026-12-01T05:00:00.000Z",
    ]);
  });

  it("rolls the year over in December", () => {
    expect(iso(monthRangeUtc("2026-12", "Europe/Istanbul"))).toEqual([
      "2026-11-30T21:00:00.000Z",
      "2026-12-31T21:00:00.000Z",
    ]);
  });
});
