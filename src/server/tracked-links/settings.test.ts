import { beforeEach, describe, expect, it, vi } from "vitest";

// Link izleme ayarı (GK10): bayrak kapalıyken sorgu yapılmaz, satır yoksa
// etiketleme açıktır, kayıtlı "kapalı" kapatır ve okuma hatası etiketlemeyi
// kapatır (asla fırlatmaz). Gerçek Postgres'teki akış store.integration
// testinde.

const mocks = vi.hoisted(() => ({ findUnique: vi.fn(), upsert: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    linkTrackingSetting: {
      findUnique: mocks.findUnique,
      upsert: mocks.upsert,
    },
  },
}));

import {
  loadLinkTrackingSettings,
  saveLinkTrackingSettings,
  utmTaggingOnFor,
} from "./settings";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("GA_UTM", "true");
});

describe("utmTaggingOnFor", () => {
  it("makes no query when the flag is off", async () => {
    vi.stubEnv("GA_UTM", "false");
    expect(await utmTaggingOnFor("p1")).toBe(false);
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("is on when there is no row, off for a stored off", async () => {
    mocks.findUnique.mockResolvedValueOnce(null);
    expect(await utmTaggingOnFor("p1")).toBe(true);
    mocks.findUnique.mockResolvedValueOnce({ utmEnabled: false });
    expect(await utmTaggingOnFor("p1")).toBe(false);
    mocks.findUnique.mockResolvedValueOnce({ utmEnabled: true });
    expect(await utmTaggingOnFor("p1")).toBe(true);
  });

  it("turns tagging off instead of throwing when the read fails", async () => {
    mocks.findUnique.mockRejectedValueOnce(new Error("db blip"));
    expect(await utmTaggingOnFor("p1")).toBe(false);
  });
});

describe("loadLinkTrackingSettings and saveLinkTrackingSettings", () => {
  it("reports defaults for a missing row and the stored value otherwise", async () => {
    mocks.findUnique.mockResolvedValueOnce(null);
    expect(await loadLinkTrackingSettings("p1")).toEqual({
      utmEnabled: true,
      stored: false,
    });
    mocks.findUnique.mockResolvedValueOnce({ utmEnabled: false });
    expect(await loadLinkTrackingSettings("p1")).toEqual({
      utmEnabled: false,
      stored: true,
    });
  });

  it("upserts one row per project", async () => {
    mocks.upsert.mockResolvedValueOnce({ utmEnabled: false });
    const saved = await saveLinkTrackingSettings({
      workspaceId: "w1",
      projectId: "p1",
      userId: "u1",
      value: { utmEnabled: false },
    });
    expect(saved).toEqual({ utmEnabled: false, stored: true });
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId: "p1" },
        create: expect.objectContaining({
          workspaceId: "w1",
          projectId: "p1",
          utmEnabled: false,
          updatedByUserId: "u1",
        }),
        update: { utmEnabled: false, updatedByUserId: "u1" },
      }),
    );
  });
});
