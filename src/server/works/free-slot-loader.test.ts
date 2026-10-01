import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listScheduledInRange: vi.fn(),
  findMany: vi.fn(),
  getProjectTimezone: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: { projectSchedule: { findMany: mocks.findMany } },
}));
vi.mock("@/server/repositories/creative.repository", () => ({
  CreativeRepository: { listScheduledInRange: mocks.listScheduledInRange },
}));
vi.mock("@/server/chat/content-plan", () => ({
  getProjectTimezone: mocks.getProjectTimezone,
}));

import {
  loadOccupiedSlots,
  loadPublishTimes,
  loadSuggestedSlots,
} from "@/server/works/free-slot-loader";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProjectTimezone.mockResolvedValue("Europe/Istanbul");
  mocks.listScheduledInRange.mockResolvedValue([]);
  mocks.findMany.mockResolvedValue([]);
});

describe("free slot loader", () => {
  it("maps UTC rows to project wall clock", async () => {
    mocks.listScheduledInRange.mockResolvedValue([
      { scheduledFor: new Date("2026-10-05T07:00:00Z"), channel: "instagram" },
      { scheduledFor: null, channel: "x" },
    ]);
    const out = await loadOccupiedSlots("p1", "Europe/Istanbul", new Date("2026-10-01T00:00:00Z"));
    expect(out).toEqual([{ date: "2026-10-05", time: "10:00", channel: "instagram" }]);
  });

  it("reads enabled publish rows only and parses their cron", async () => {
    mocks.findMany.mockResolvedValue([
      { cronExpression: "30 9 * * *" },
      { cronExpression: "garbage" },
    ]);
    expect(await loadPublishTimes("p1")).toEqual(["09:30"]);
    expect(mocks.findMany.mock.calls[0]![0].where).toMatchObject({
      projectId: "p1",
      enabled: true,
      capability: "INSTAGRAM_PUBLISH",
    });
  });

  it("uses publish times for instagram only", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
    mocks.findMany.mockResolvedValue([{ cronExpression: "45 8 * * *" }]);
    const ig = await loadSuggestedSlots("p1", { channel: "instagram" });
    expect(ig.slots[0]!.time).toBe("08:45");
    mocks.findMany.mockClear();
    const li = await loadSuggestedSlots("p1", { channel: "linkedin" });
    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(li.slots[0]!.time).toBe("10:00");
    vi.useRealTimers();
  });

  it("returns empty slots with the timezone on error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.listScheduledInRange.mockRejectedValue(new Error("db"));
    const out = await loadSuggestedSlots("p1", { channel: "instagram" });
    expect(out).toEqual({ timezone: "Europe/Istanbul", slots: [] });
  });
});
