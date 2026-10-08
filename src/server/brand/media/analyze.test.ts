import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  count: vi.fn(),
  assetFindUnique: vi.fn(),
  readAsset: vi.fn(),
  prepare: vi.fn(),
  run: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    brandMedia: {
      findUnique: mocks.findUnique,
      update: mocks.update,
      count: mocks.count,
    },
    asset: { findUnique: mocks.assetFindUnique },
  },
}));
vi.mock("@/server/storage/asset-storage", () => ({ readAsset: mocks.readAsset }));
vi.mock("@/server/brand/site-scan/image-colors", () => ({
  prepareVisionImage: mocks.prepare,
}));
vi.mock("@/server/reasoning/reasoning-service", () => ({
  ReasoningService: { run: mocks.run },
}));

import { MEDIA_ANALYSES_PER_DAY, MEDIA_ANALYSIS_VERSION } from "@/lib/brand-media";
import { AgentelseError } from "@/server/security/errors";

import { analyzeBrandMedia } from "./analyze";

const NOW = new Date("2026-10-07T10:00:00Z");
const media = (over: Record<string, unknown> = {}) => ({
  id: "m1",
  workspaceId: "w1",
  projectId: "p1",
  brandId: "b1",
  assetId: "a1",
  kind: "IMAGE",
  attempts: 0,
  tagsEdited: false,
  orientation: null,
  ...over,
});
const output = {
  description: "A barista pours milk.",
  tags: ["kahve", "barista"],
  subjects: ["barista"],
  setting: "cafe bar",
  mood: "warm",
  shotType: "medium",
  hasPeople: true,
  quality: 82,
  dominantColors: ["#b9772f"],
  focalX: 0.4,
  focalY: 0.55,
};
const updated = () => mocks.update.mock.calls.at(-1)![0].data;

describe("analyzeBrandMedia", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.findUnique.mockResolvedValue(media());
    mocks.count.mockResolvedValue(0);
    mocks.assetFindUnique.mockResolvedValue({
      storageKey: "r2://a.jpg",
      filename: "IMG_1.jpg",
      width: 800,
      height: 1200,
    });
    mocks.readAsset.mockResolvedValue(Buffer.from("bytes"));
    mocks.prepare.mockResolvedValue(Buffer.from("jpeg"));
    mocks.run.mockResolvedValue({ output, isMock: false, reasoningCallId: "r" });
    mocks.update.mockResolvedValue({});
  });

  it("writes what the model saw and marks the photo ready", async () => {
    expect(await analyzeBrandMedia("m1", NOW)).toBe("ok");
    expect(updated()).toMatchObject({
      status: "OK",
      version: MEDIA_ANALYSIS_VERSION,
      attempts: 0,
      nextAttemptAt: null,
      analyzedAt: NOW,
      description: "A barista pours milk.",
      tags: ["kahve", "barista"],
      hasPeople: true,
      quality: 82,
      orientation: "portrait",
      focalX: 0.4,
      shotType: "medium",
    });
    // One small picture to the model, scoped to the brand's project.
    const call = mocks.run.mock.calls[0]![1];
    expect(call).toMatchObject({ projectId: "p1", brandId: "b1", context: { filename: "IMG_1.jpg" } });
    expect(call.attachments).toEqual([{ mimeType: "image/jpeg", data: Buffer.from("jpeg").toString("base64") }]);
  });

  it("keeps the tags a person wrote through a re-analysis", async () => {
    mocks.findUnique.mockResolvedValue(media({ tagsEdited: true }));
    await analyzeBrandMedia("m1", NOW);
    expect(updated()).not.toHaveProperty("tags");
    expect(updated()).toMatchObject({ description: "A barista pours milk." });
  });

  it("waits when the project has used its analyses for the day, without calling the model", async () => {
    mocks.count.mockResolvedValue(MEDIA_ANALYSES_PER_DAY);
    expect(await analyzeBrandMedia("m1", NOW)).toBe("deferred");
    expect(mocks.run).not.toHaveBeenCalled();
    expect(updated().nextAttemptAt).toEqual(new Date(NOW.getTime() + 3_600_000));
    expect(updated()).not.toHaveProperty("status");
  });

  it("waits, without counting an attempt, when the day's AI budget is spent", async () => {
    mocks.run.mockRejectedValue(new AgentelseError("BUDGET_EXCEEDED", "cap"));
    expect(await analyzeBrandMedia("m1", NOW)).toBe("deferred");
    expect(updated()).toEqual({ nextAttemptAt: new Date(NOW.getTime() + 3_600_000) });
  });

  it("retries a failure later and gives up after three attempts", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.run.mockRejectedValue(new Error("boom"));
    expect(await analyzeBrandMedia("m1", NOW)).toBe("failed");
    expect(updated()).toMatchObject({ status: "PENDING", attempts: 1 });
    expect(updated().nextAttemptAt).toEqual(new Date(NOW.getTime() + 10 * 60_000));

    mocks.findUnique.mockResolvedValue(media({ attempts: 2 }));
    await analyzeBrandMedia("m1", NOW);
    expect(updated()).toMatchObject({ status: "FAILED", attempts: 3, nextAttemptAt: null });
    quiet.mockRestore();
  });

  it("fails a photo whose file cannot be prepared, and a missing row is simply missing", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.prepare.mockResolvedValue(null);
    expect(await analyzeBrandMedia("m1", NOW)).toBe("failed");
    expect(mocks.run).not.toHaveBeenCalled();
    mocks.findUnique.mockResolvedValue(null);
    expect(await analyzeBrandMedia("nope", NOW)).toBe("missing");
    quiet.mockRestore();
  });

  it("keeps a video as it is, to be understood later", async () => {
    mocks.findUnique.mockResolvedValue(media({ kind: "VIDEO" }));
    expect(await analyzeBrandMedia("m1", NOW)).toBe("deferred");
    expect(updated()).toEqual({ status: "SKIPPED" });
    expect(mocks.run).not.toHaveBeenCalled();
  });
});
