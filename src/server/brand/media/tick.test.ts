import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  analyze: vi.fn(),
  adopt: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { brandMedia: { findMany: mocks.findMany } },
}));
vi.mock("@/server/brand/media/analyze", () => ({ analyzeBrandMedia: mocks.analyze }));
vi.mock("@/server/brand/media/store", () => ({ adoptExistingPhotos: mocks.adopt }));

import { MEDIA_ANALYSIS_VERSION } from "@/lib/brand-media";
import { isBackground, runAsBackground } from "@/server/billing/usage-context";

import { runDueMediaAnalysis } from "./tick";

describe("runDueMediaAnalysis", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.adopt.mockResolvedValue(0);
  });

  it("reads the waiting photos oldest first, a few at a time, and counts the ones that worked", async () => {
    mocks.findMany.mockResolvedValue([
      { id: "a", status: "PENDING" },
      { id: "b", status: "PENDING" },
      { id: "c", status: "PENDING" },
    ]);
    mocks.analyze.mockImplementation(async (id: string) => (id === "b" ? "failed" : "ok"));
    const now = new Date("2026-10-07T10:00:00Z");

    expect(await runDueMediaAnalysis(3, now)).toBe(2);
    expect(mocks.analyze.mock.calls.map((call) => call[0])).toEqual(["a", "b", "c"]);

    const query = mocks.findMany.mock.calls[0]![0];
    expect(query).toMatchObject({ take: 3, orderBy: { createdAt: "asc" } });
    expect(query.where).toMatchObject({ kind: "IMAGE", archivedAt: null });
    // Waiting photos whose retry time has come, and photos read by an older version.
    expect(query.where.OR).toEqual([
      { status: "PENDING", OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
      { status: "OK", version: { lt: MEDIA_ANALYSIS_VERSION } },
    ]);
  });

  it("reads a photo the person uploaded as THEIR work even inside the system's tick step, and a library re-read as the system's", async () => {
    mocks.findMany.mockResolvedValue([
      { id: "waiting", status: "PENDING" },
      { id: "old-version", status: "OK" },
    ]);
    const background: Record<string, boolean> = {};
    mocks.analyze.mockImplementation(async (id: string) => {
      background[id] = isBackground();
      return "ok";
    });

    await runAsBackground(() => runDueMediaAnalysis(2));

    expect(background).toEqual({ waiting: false, "old-version": true });
  });

  it("brings in older uploads now and then, not on every tick", async () => {
    mocks.findMany.mockResolvedValue([]);
    const later = new Date(Date.now() + 10 * 3_600_000);
    await runDueMediaAnalysis(4, later);
    await runDueMediaAnalysis(4, new Date(later.getTime() + 10_000));
    expect(mocks.adopt).toHaveBeenCalledTimes(1);
    await runDueMediaAnalysis(4, new Date(later.getTime() + 31 * 60_000));
    expect(mocks.adopt).toHaveBeenCalledTimes(2);
  });

  it("still analyses when bringing in older uploads fails", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.adopt.mockRejectedValue(new Error("db"));
    mocks.findMany.mockResolvedValue([{ id: "a", status: "PENDING" }]);
    mocks.analyze.mockResolvedValue("ok");
    const later = new Date(Date.now() + 100 * 3_600_000);
    expect(await runDueMediaAnalysis(4, later)).toBe(1);
    quiet.mockRestore();
  });
});
