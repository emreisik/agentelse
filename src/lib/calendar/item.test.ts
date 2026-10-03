import { describe, expect, it } from "vitest";

import {
  mergeFresh,
  rescheduleItem,
  reuseUnchanged,
  stageFromFacts,
  type ItemCache,
} from "./item";
import { facts, item, payload } from "./test-fixtures";

const NOW = new Date("2026-10-03T12:00:00Z");
const ctx = { timezone: "Europe/Istanbul", scheduleEnabled: true, now: NOW };

describe("rescheduleItem", () => {
  it("yeni gün+saati yerel alanlara ve UTC ana yazar", () => {
    const moved = rescheduleItem(item(), "2026-10-09T18:30", ctx);
    expect(moved.localDay).toBe("2026-10-09");
    expect(moved.localTime).toBe("18:30");
    // İstanbul UTC+3
    expect(moved.scheduledFor).toBe("2026-10-09T15:30:00.000Z");
    expect(moved.stage).toBe("scheduled");
  });

  it("günü kaldırınca atanmamış olur ve durum yeniden türetilir", () => {
    const moved = rescheduleItem(item(), null, ctx);
    expect(moved.localDay).toBeNull();
    expect(moved.localTime).toBeNull();
    expect(moved.scheduledFor).toBeNull();
    // Onaylı ama günü yok: bekletilir.
    expect(moved.stage).toBe("held");
  });

  it("kaçırılmış parça gelecekte yeni bir zamana taşınınca scheduled olur", () => {
    const missed = item(
      {
        stage: "missed",
        scheduledFor: "2026-10-01T07:00:00.000Z",
        localDay: "2026-10-01",
        localTime: "10:00",
        overdue: true,
      },
    );
    const moved = rescheduleItem(missed, "2026-10-08T10:00", ctx);
    expect(moved.stage).toBe("scheduled");
    expect(moved.overdue).toBe(false);
  });

  it("hatadan sonra gelecekte yeniden planlanan parça failed sayılmaz", () => {
    const failedAt = "2026-10-03T10:00:00.000Z";
    const failed = item(
      { stage: "failed", reason: "The platform said: x" },
      { task: { state: "failed", error: "x", at: failedAt } },
    );
    // Aynı slotta kalırsa hâlâ başarısız (zamanı hatadan önce).
    expect(
      stageFromFacts(
        failed.facts,
        new Date("2026-10-03T09:00:00Z"),
        true,
        NOW,
      ).stage,
    ).toBe("failed");
    // Gelecekte yeni bir zamana taşınırsa yeniden planlanmıştır.
    expect(rescheduleItem(failed, "2026-10-10T10:00", ctx).stage).toBe(
      "scheduled",
    );
  });

  it("zamanlı yayın kapalıyken scheduled yerine held çıkar", () => {
    const moved = rescheduleItem(item(), "2026-10-09T18:30", {
      ...ctx,
      scheduleEnabled: false,
    });
    expect(moved.stage).toBe("held");
  });

  it("yayınlanmış parça taşınamaz olarak kalır", () => {
    const published = item({}, { status: "PUBLISHED" });
    expect(stageFromFacts(published.facts, new Date(), true, NOW).movable).toBe(
      false,
    );
  });
});

describe("reuseUnchanged", () => {
  it("içeriği değişmeyen öğelerde ESKİ nesneyi döndürür", () => {
    const cache: ItemCache = new Map();
    const first = reuseUnchanged([item({ id: "a" }), item({ id: "b" })], cache);
    // Sunucudan gelen yeni nesneler, aynı içerik.
    const second = reuseUnchanged(
      [item({ id: "a" }), item({ id: "b", title: "Changed" })],
      cache,
    );
    expect(second[0]).toBe(first[0]);
    expect(second[1]).not.toBe(first[1]);
    expect(second[1]!.title).toBe("Changed");
  });

  it("artık olmayan öğeleri önbellekten düşürür", () => {
    const cache: ItemCache = new Map();
    reuseUnchanged([item({ id: "a" }), item({ id: "b" })], cache);
    reuseUnchanged([item({ id: "a" })], cache);
    expect([...cache.keys()]).toEqual(["a"]);
  });
});

describe("mergeFresh", () => {
  const local = item({ id: "a", localDay: "2026-10-09", localTime: "18:30" });
  const server = item({ id: "a", localDay: "2026-10-07" });

  it("yazmadan SONRA okunmaya başlayan yanıt sunucu halini getirir", () => {
    const merged = mergeFresh(
      [local],
      payload([server], { loadedAt: 2_000 }),
      new Map([["a", 1_000]]),
    );
    expect(merged[0]).toBe(server);
  });

  it("yazmadan ÖNCE okunmaya başlayan eski yanıt yerel halı ezmez", () => {
    const merged = mergeFresh(
      [local],
      payload([server], { loadedAt: 500 }),
      new Map([["a", 1_000]]),
    );
    expect(merged[0]).toBe(local);
  });

  it("damgası olmayan öğeler sunucudan gelir; yeni ve silinen öğeler izlenir", () => {
    const added = item({ id: "new" });
    const merged = mergeFresh(
      [local, item({ id: "gone" })],
      payload([server, added], { loadedAt: 2_000 }),
      new Map(),
    );
    expect(merged.map((i) => i.id)).toEqual(["a", "new"]);
    expect(merged[0]).toBe(server);
  });
});

describe("fixtures", () => {
  it("facts varsayılanı onaylı bağlı Instagram parçasıdır", () => {
    expect(facts().status).toBe("APPROVED");
    expect(facts().connected).toBe(true);
  });
});
