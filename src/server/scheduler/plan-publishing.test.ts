import { beforeEach, describe, expect, it, vi } from "vitest";

// What this suite proves: "Turn on scheduled posting" never invents times for
// a client who already has slots (it only switches them on), builds slots from
// the plan's own clock times otherwise (max three, most used first, in the
// project's timezone), and writes the same rows the Publishing settings form
// does so they stay visible and editable there.

const findMany = vi.fn();
const update = vi.fn();
const create = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { projectSchedule: { findMany, update, create } },
}));
const computeNextRunAt = vi.fn();
vi.mock("./scheduler-service", () => ({ computeNextRunAt }));

const { planPublishTimes, enableScheduledPublishing } = await import(
  "./plan-publishing"
);

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockResolvedValue([]);
  computeNextRunAt.mockReturnValue(new Date("2026-10-02T07:00:00Z"));
  update.mockResolvedValue({});
  create.mockResolvedValue({});
});

const at = (iso: string) => new Date(iso);

describe("planPublishTimes", () => {
  it("reads the clock time in the project's timezone, not UTC", () => {
    // 07:00Z is 10:00 in Istanbul (UTC+3).
    expect(planPublishTimes([at("2026-10-05T07:00:00Z")], "Europe/Istanbul")).toEqual([
      "10:00",
    ]);
  });

  it("takes the three most used times, most used first in the pick, day order in the result", () => {
    const planned = [
      ...Array(4).fill(at("2026-10-05T07:00:00Z")), // 10:00 x4
      ...Array(3).fill(at("2026-10-06T15:00:00Z")), // 18:00 x3
      ...Array(2).fill(at("2026-10-07T10:00:00Z")), // 13:00 x2
      at("2026-10-08T05:00:00Z"), // 08:00 x1 (dropped)
    ];
    expect(planPublishTimes(planned, "Europe/Istanbul")).toEqual([
      "10:00",
      "13:00",
      "18:00",
    ]);
  });

  it("falls back to the plan default when nothing is scheduled", () => {
    expect(planPublishTimes([], "Europe/Istanbul")).toEqual(["10:00"]);
  });
});

describe("enableScheduledPublishing", () => {
  const base = {
    workspaceId: "ws-1",
    projectId: "proj-1",
    brandId: "brand-1",
    timezone: "Europe/Istanbul",
    times: ["10:00", "18:00"],
  };

  it("looks only at this project's Instagram publish-queue rows", async () => {
    await enableScheduledPublishing(base);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        projectId: "proj-1",
        capability: "INSTAGRAM_PUBLISH",
        configuration: { path: ["mode"], equals: "PUBLISH_NEXT_READY" },
      },
    });
  });

  it("creates the slots the settings form would, from the plan's times", async () => {
    const result = await enableScheduledPublishing(base);
    expect(result).toEqual({ turnedOn: 2, created: 2 });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]![0].data).toMatchObject({
      workspaceId: "ws-1",
      projectId: "proj-1",
      brandId: "brand-1",
      name: "Instagram publish — 18:00",
      capability: "INSTAGRAM_PUBLISH",
      scheduleType: "CRON",
      cronExpression: "00 18 * * *",
      timezone: "Europe/Istanbul",
      configuration: { mode: "PUBLISH_NEXT_READY", slot: 2 },
      enabled: true,
      nextRunAt: new Date("2026-10-02T07:00:00Z"),
    });
  });

  it("never makes more than the three slots the form has", async () => {
    await enableScheduledPublishing({
      ...base,
      times: ["08:00", "10:00", "13:00", "18:00"],
    });
    expect(create).toHaveBeenCalledTimes(3);
  });

  it("switches on the client's own slots without touching their times", async () => {
    findMany.mockResolvedValue([
      { id: "s1", enabled: false, cronExpression: "30 9 * * *", timezone: "UTC" },
      { id: "s2", enabled: true, cronExpression: "0 17 * * *", timezone: "UTC" },
    ]);
    const result = await enableScheduledPublishing(base);
    expect(result).toEqual({ turnedOn: 1, created: 0 });
    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: "s1" },
      data: { enabled: true, nextRunAt: new Date("2026-10-02T07:00:00Z") },
    });
    // The next run is worked out from the slot's OWN cron and timezone.
    expect(computeNextRunAt).toHaveBeenCalledWith({
      scheduleType: "CRON",
      cronExpression: "30 9 * * *",
      timezone: "UTC",
      configuration: null,
    });
  });
});
