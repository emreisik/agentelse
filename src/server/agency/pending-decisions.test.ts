import { beforeEach, describe, expect, it, vi } from "vitest";

// What this suite proves about the approve button a waiting creative gets: a
// piece with a planned time still ahead (a content-plan slot) is "planned" so
// the card never promises to publish it now, while a plain Instagram piece
// keeps today's "calendar" / "publish" intent and other channels get none.

const approvalFindMany = vi.fn();
const creativeFindMany = vi.fn();
const taskFindMany = vi.fn();
const scheduleCount = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    approval: { findMany: approvalFindMany },
    task: { findMany: taskFindMany },
    creative: { findMany: creativeFindMany },
    projectSchedule: { count: scheduleCount },
    brand: { findFirst: vi.fn().mockResolvedValue({ name: "Acme" }) },
  },
}));
const getPublishTargets = vi.fn();
vi.mock("@/server/integrations/meta-connection-status", () => ({
  getPublishTargets,
}));
const buildApprovalDetails = vi.fn();
vi.mock("@/server/execution/approval-details", () => ({
  approvalCategory: vi.fn(),
  buildApprovalDetails,
}));
const costApprovalNotes = vi.fn();
vi.mock("@/server/billing/approval-threshold", () => ({ costApprovalNotes }));

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
  taskFindMany.mockResolvedValue([]);
  buildApprovalDetails.mockReturnValue(undefined);
  costApprovalNotes.mockResolvedValue(new Map());
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

// The "Why you are asked" line of a cost approval lives on the one-time chat card
// only; the decisions tray rebuilds its cards from the records, so it works the
// sentence out again from the task and today's plan (billing, Faz 3C).
describe("getPendingDecisions: why an automatic task is asked about", () => {
  const NOTE = "This automatic task would use 3 post images of your plan.";

  const waitingTask = (over: Record<string, unknown> = {}) => ({
    id: "t1",
    title: "A launch post",
    capability: "CREATE_SOCIAL_CREATIVE",
    riskLevel: "LOW",
    departmentKey: null,
    payload: { request: "a post", variantCount: 3 },
    createdByType: "SYSTEM",
    ...over,
  });

  beforeEach(() => {
    approvalFindMany.mockResolvedValue([
      {
        id: "a1",
        workspaceId: "w-1",
        brandId: "b1",
        entityType: "Task",
        entityId: "t1",
        createdAt: new Date("2026-10-01T08:00:00Z"),
      },
    ]);
    taskFindMany.mockResolvedValue([waitingTask()]);
  });

  async function details() {
    const [decision] = await getPendingDecisions("proj-1");
    return decision?.card.kind === "approval-request"
      ? decision.card.details
      : "no card";
  }

  it("gives the card the reason, worked out for the project's plan", async () => {
    costApprovalNotes.mockResolvedValue(new Map([["t1", NOTE]]));

    expect(await details()).toEqual([
      { label: "Why you are asked", value: NOTE },
    ]);
    expect(costApprovalNotes).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "w-1",
        projectId: "proj-1",
        tasks: [expect.objectContaining({ id: "t1", createdByType: "SYSTEM" })],
      }),
    );
  });

  it("leaves the card as it was when there is no reason to give", async () => {
    expect(await details()).toBeUndefined();
  });

  it("keeps a task's own details and does not ask about its cost", async () => {
    const own = [{ label: "Budget", value: "$20 -> $15" }];
    buildApprovalDetails.mockReturnValue(own);
    costApprovalNotes.mockResolvedValue(new Map([["t1", NOTE]]));

    expect(await details()).toEqual(own);
    expect(costApprovalNotes).toHaveBeenCalledWith(
      expect.objectContaining({ tasks: [] }),
    );
  });
});
