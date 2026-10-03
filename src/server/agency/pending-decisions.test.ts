import { beforeEach, describe, expect, it, vi } from "vitest";

// What this suite proves about the approve button a waiting creative gets: a
// piece with a planned time still ahead (a content-plan slot) is "planned" so
// the card never promises to publish it now, while a plain Instagram piece
// keeps today's "calendar" / "publish" intent and other channels get none.

const approvalFindMany = vi.fn();
const creativeFindMany = vi.fn();
const scheduleCount = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    approval: { findMany: approvalFindMany },
    task: { findMany: vi.fn().mockResolvedValue([]) },
    creative: { findMany: creativeFindMany },
    projectSchedule: { count: scheduleCount },
    brand: { findFirst: vi.fn().mockResolvedValue({ name: "Acme" }) },
  },
}));
const getPublishTargets = vi.fn();
vi.mock("@/server/integrations/meta-connection-status", () => ({
  getPublishTargets,
}));
vi.mock("@/server/execution/approval-details", () => ({
  approvalCategory: vi.fn(),
  buildApprovalDetails: vi.fn(),
}));

const { getPendingDecisions } = await import("./pending-decisions");

const DAY = 24 * 60 * 60_000;

const creative = (over: Record<string, unknown> = {}) => ({
  id: "c1",
  title: "Post",
  status: "IN_REVIEW",
  platform: "INSTAGRAM",
  scheduledFor: null,
  createdByTaskId: null,
  currentVersionId: null,
  versions: [],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  approvalFindMany.mockResolvedValue([
    {
      id: "a1",
      brandId: "b1",
      entityType: "Creative",
      entityId: "c1",
      createdAt: new Date("2026-10-01T08:00:00Z"),
    },
  ]);
  getPublishTargets.mockResolvedValue([{ platform: "instagram" }]);
  scheduleCount.mockResolvedValue(0);
});

async function intent(over: Record<string, unknown>) {
  creativeFindMany.mockResolvedValue([creative(over)]);
  const [decision] = await getPendingDecisions("proj-1");
  return decision?.card.kind === "creative-ready"
    ? decision.card.approveIntent
    : "no card";
}

describe("getPendingDecisions: the approve intent of a creative", () => {
  it("a piece with a planned time still ahead is kept for that time", async () => {
    expect(await intent({ scheduledFor: new Date(Date.now() + 3 * DAY) })).toBe(
      "planned",
    );
    // With a publish schedule too: still the planned time, not the next slot.
    scheduleCount.mockResolvedValue(1);
    expect(await intent({ scheduledFor: new Date(Date.now() + 3 * DAY) })).toBe(
      "planned",
    );
  });

  it("a piece with no planned time, or one whose time has come, keeps today's intent", async () => {
    expect(await intent({})).toBe("publish");
    expect(await intent({ scheduledFor: new Date(Date.now() - DAY) })).toBe(
      "publish",
    );
    scheduleCount.mockResolvedValue(1);
    expect(await intent({})).toBe("calendar");
  });

  it("promises nothing without a connection, or for another channel", async () => {
    getPublishTargets.mockResolvedValue([]);
    expect(await intent({ scheduledFor: new Date(Date.now() + DAY) })).toBeUndefined();
    // Only Instagram can take the Instagram post the button promises: a
    // Facebook Page (or any other channel) alone promises nothing.
    getPublishTargets.mockResolvedValue([
      { platform: "facebook", pageId: "p1", accountLabel: "Web Health" },
      { platform: "x", accountLabel: "@wh" },
    ]);
    expect(await intent({ scheduledFor: new Date(Date.now() + DAY) })).toBeUndefined();
    getPublishTargets.mockResolvedValue([{ platform: "instagram" }]);
    expect(
      await intent({ platform: "TIKTOK", scheduledFor: new Date(Date.now() + DAY) }),
    ).toBeUndefined();
  });
});
