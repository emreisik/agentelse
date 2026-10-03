import { beforeEach, describe, expect, it, vi } from "vitest";

const listForCalendarBoard = vi.fn();
const taskFindMany = vi.fn();
const scheduleCount = vi.fn();
const jobFindMany = vi.fn();
const getPublishTargets = vi.fn();

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    task: { findMany: (...args: unknown[]) => taskFindMany(...args) },
    projectSchedule: { count: (...args: unknown[]) => scheduleCount(...args) },
    executionJob: { findMany: (...args: unknown[]) => jobFindMany(...args) },
  },
}));
vi.mock("@/server/repositories/creative.repository", () => ({
  CreativeRepository: {
    listForCalendarBoard: (...args: unknown[]) => listForCalendarBoard(...args),
  },
}));
vi.mock("@/server/integrations/meta-connection-status", () => ({
  getPublishTargets: (...args: unknown[]) => getPublishTargets(...args),
}));

import { loadCalendarData } from "./load-calendar";

const NOW = new Date("2026-10-03T12:00:00Z");
const HOUR = 3600 * 1000;

function creative(overrides: Record<string, unknown> = {}) {
  return {
    id: "c1",
    title: "Launch post",
    status: "APPROVED",
    platform: "INSTAGRAM",
    channel: "instagram",
    formatKey: "instagram.post",
    scheduledFor: new Date(NOW.getTime() + 48 * HOUR),
    currentVersionId: "v1",
    versions: [
      {
        caption: "  Hello   world  ",
        copy: null,
        asset: {
          id: "a1",
          mimeType: "image/png",
          storageKey: "creatives/a1.png",
        },
      },
    ],
    ...overrides,
  };
}

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: "t1",
    status: "FAILED",
    payload: { creativeId: "c1" },
    completedAt: new Date(NOW.getTime() - HOUR),
    updatedAt: new Date(NOW.getTime() - HOUR),
    ...overrides,
  };
}

const range = {
  projectId: "p1",
  timezone: "Europe/Istanbul",
  from: new Date("2026-09-28T00:00:00Z"),
  to: new Date("2026-11-01T00:00:00Z"),
  now: NOW,
};

beforeEach(() => {
  vi.clearAllMocks();
  listForCalendarBoard.mockResolvedValue([creative()]);
  taskFindMany.mockResolvedValue([]);
  jobFindMany.mockResolvedValue([{ taskId: "t1", errorMessage: "Token expired" }]);
  scheduleCount.mockResolvedValue(1);
  getPublishTargets.mockResolvedValue([
    {
      platform: "instagram",
      pageId: "pg",
      pageName: "Instagram",
      igUsername: "brand",
    },
  ]);
});

describe("loadCalendarData", () => {
  it("parçayı proje saat diliminde gün+saat ve durumla eşler", async () => {
    const { items } = await loadCalendarData(range);
    expect(items).toHaveLength(1);
    const item = items[0]!;
    // 2026-10-05T12:00Z = İstanbul'da 15:00 (UTC+3)
    expect(item.localDay).toBe("2026-10-05");
    expect(item.localTime).toBe("15:00");
    expect(item.stage).toBe("scheduled");
    expect(item.source.key).toBe("instagram");
    expect(item.label).toBe("Instagram · Post");
    expect(item.assetId).toBe("a1");
    expect(item.preview).toBe("Hello world");
    expect(item.movable).toBe(true);
  });

  it("bağlı hesapları etiketiyle ve bağlı olmayanları ayrı döndürür", async () => {
    const { connections } = await loadCalendarData(range);
    const ig = connections.find((c) => c.source.key === "instagram");
    const fb = connections.find((c) => c.source.key === "facebook");
    expect(ig).toMatchObject({ connected: true, account: "@brand" });
    expect(fb).toMatchObject({ connected: false, account: null });
  });

  it("başarısız yayın görevi failed olur ve hata metnini taşır", async () => {
    // Parçanın zamanı geçmiş: hata o denemeye ait.
    listForCalendarBoard.mockResolvedValue([
      creative({ scheduledFor: new Date(NOW.getTime() - 2 * HOUR) }),
    ]);
    taskFindMany.mockResolvedValue([task()]);
    const { items } = await loadCalendarData(range);
    expect(items[0]!.stage).toBe("failed");
    expect(items[0]!.reason).toContain("Token expired");
  });

  it("hatadan sonra gelecekte yeniden planlanan parça failed sayılmaz", async () => {
    // Hata 1 saat önce; parça şimdi 2 gün sonraya planlı.
    taskFindMany.mockResolvedValue([task()]);
    const { items } = await loadCalendarData(range);
    expect(items[0]!.stage).toBe("scheduled");
  });

  it("istemcinin durumu yeniden türetebilmesi için ham olguları taşır", async () => {
    taskFindMany.mockResolvedValue([task()]);
    const { items, loadedAt } = await loadCalendarData(range);
    expect(loadedAt).toBe(NOW.getTime());
    expect(items[0]!.facts).toEqual({
      status: "APPROVED",
      hasContent: true,
      platform: "INSTAGRAM",
      channel: "instagram",
      formatKey: "instagram.post",
      connected: true,
      task: {
        state: "failed",
        error: "Token expired",
        at: new Date(NOW.getTime() - HOUR).toISOString(),
      },
    });
  });

  it("hata metnini yalnız başarısız görevler için okur", async () => {
    taskFindMany.mockResolvedValue([task({ status: "RUNNING" })]);
    await loadCalendarData(range);
    expect(jobFindMany).not.toHaveBeenCalled();

    taskFindMany.mockResolvedValue([task()]);
    await loadCalendarData(range);
    expect(jobFindMany).toHaveBeenCalledTimes(1);
    expect(jobFindMany.mock.calls[0]![0].where).toEqual({
      taskId: { in: ["t1"] },
    });
  });

  it("çalışan yayın görevi publishing yapar ve taşınamaz", async () => {
    taskFindMany.mockResolvedValue([
      task({ status: "RUNNING" }),
    ]);
    const { items } = await loadCalendarData(range);
    expect(items[0]!.stage).toBe("publishing");
    expect(items[0]!.movable).toBe(false);
  });

  it("aynı parçanın en yeni görevi kazanır", async () => {
    // Sorgu createdAt azalan döner: önce yeni (çalışıyor), sonra eski (hata).
    taskFindMany.mockResolvedValue([
      task({ status: "RUNNING" }),
      task(),
    ]);
    const { items } = await loadCalendarData(range);
    expect(items[0]!.stage).toBe("publishing");
  });

  it("yayınlanmış parça için yayın anını görevin tamamlanmasından alır", async () => {
    const done = new Date(NOW.getTime() - 3 * HOUR);
    listForCalendarBoard.mockResolvedValue([creative({ status: "PUBLISHED" })]);
    taskFindMany.mockResolvedValue([
      task({ status: "COMPLETED", completedAt: done }),
    ]);
    const { items } = await loadCalendarData(range);
    expect(items[0]!.stage).toBe("published");
    expect(items[0]!.publishedAt).toBe(done.toISOString());
    expect(items[0]!.movable).toBe(false);
  });

  it("bağlı olmayan platformdaki onaylı parça held olur", async () => {
    getPublishTargets.mockResolvedValue([]);
    const { items } = await loadCalendarData(range);
    expect(items[0]!.stage).toBe("held");
    expect(items[0]!.reason).toMatch(/isn't connected/);
  });

  it("mock görselli ya da görsel olmayan varlık küçük resim sayılmaz", async () => {
    listForCalendarBoard.mockResolvedValue([
      creative({
        versions: [
          {
            caption: null,
            copy: "Metin",
            asset: { id: "a2", mimeType: "video/mp4", storageKey: "x.mp4" },
          },
        ],
      }),
    ]);
    const { items } = await loadCalendarData(range);
    expect(items[0]!.assetId).toBeNull();
    expect(items[0]!.preview).toBe("Metin");
  });

  it("görev sorgusu hata verirse takvim yine de açılır", async () => {
    taskFindMany.mockRejectedValue(new Error("db down"));
    const { items } = await loadCalendarData(range);
    expect(items[0]!.stage).toBe("scheduled");
  });
});
