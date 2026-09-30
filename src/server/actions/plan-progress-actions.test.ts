import { beforeEach, describe, expect, it, vi } from "vitest";

// What this suite proves about "Approve all" on a saved plan: it decides only
// the PENDING creative approvals of THIS plan's saved pieces in the caller's
// project, through the same approval path a single Approve takes, one after
// another, and one piece that cannot be approved never hides the others.

const requireUser = vi.fn();
const requireProjectAccess = vi.fn();
vi.mock("@/server/security/tenant-context", () => ({
  requireUser,
  requireProjectAccess,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const commandFindUnique = vi.fn();
const approvalFindMany = vi.fn();
const creativeFindMany = vi.fn();
const creativeFindUnique = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    command: { findUnique: commandFindUnique },
    approval: { findMany: approvalFindMany },
    creative: { findMany: creativeFindMany, findUnique: creativeFindUnique },
  },
}));

vi.mock("@/server/chat/content-plan", () => ({
  getProjectTimezone: vi.fn().mockResolvedValue("Europe/Istanbul"),
}));
const getPublishTargets = vi.fn();
vi.mock("@/server/integrations/meta-connection-status", () => ({
  getPublishTargets,
}));
const creativeTransition = vi.fn();
vi.mock("@/server/repositories/creative.repository", () => ({
  CreativeRepository: { transition: creativeTransition },
}));
const markCreativePublishState = vi.fn();
vi.mock("@/server/repositories/idea-chat.repository", () => ({
  IdeaChatRepository: { markCreativePublishState },
}));
const enableScheduledPublishing = vi.fn();
const loadPlanResults = vi.fn();
vi.mock("@/server/agency/journey/results", () => ({ loadPlanResults }));
vi.mock("@/server/scheduler/plan-publishing", async (importOriginal) => ({
  // planPublishTimes is pure: keep the real one.
  ...(await importOriginal<typeof import("@/server/scheduler/plan-publishing")>()),
  enableScheduledPublishing,
}));

const applyApprovalDecision = vi.fn();
vi.mock("@/server/commands/approval-decisions", () => ({
  applyApprovalDecision,
}));
const auditRecord = vi.fn().mockResolvedValue(undefined);
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: auditRecord },
}));

const {
  approvePlanItemsAction,
  enablePlanPublishingAction,
  getManualPublishItemsAction,
  getPlanResultsAction,
  markCreativePublishedAction,
} = await import("./plan-progress-actions");

const planRow = (over: Record<string, unknown> = {}) => ({
  projectId: "proj-1",
  parsedIntent: {
    card: {
      kind: "content-plan-draft",
      title: "Plan",
      timezone: "UTC",
      state: "saved",
      items: [],
      savedCreativeIds: ["c1", "c2", "c3"],
      ...over,
    },
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  requireUser.mockResolvedValue({ userId: "user-1" });
  requireProjectAccess.mockResolvedValue({
    workspaceId: "ws-1",
    defaultBrandId: "brand-1",
  });
  commandFindUnique.mockResolvedValue(planRow());
  approvalFindMany.mockResolvedValue([{ id: "a1" }, { id: "a2" }]);
  applyApprovalDecision.mockResolvedValue(undefined);
  getPublishTargets.mockResolvedValue([{ platform: "instagram" }]);
  creativeFindMany.mockResolvedValue([]);
  creativeTransition.mockResolvedValue(undefined);
  markCreativePublishState.mockResolvedValue(true);
  enableScheduledPublishing.mockResolvedValue({ turnedOn: 2, created: 2 });
});

describe("approvePlanItemsAction", () => {
  it("approves the pending creative approvals of the plan's pieces, in order", async () => {
    const result = await approvePlanItemsAction("plan-1");
    expect(result).toEqual({ ok: true, approved: 2, failed: 0 });

    // The guard IS the safety: this project, creatives only, this plan's
    // pieces only, still pending.
    expect(approvalFindMany).toHaveBeenCalledWith({
      where: {
        projectId: "proj-1",
        entityType: "Creative",
        entityId: { in: ["c1", "c2", "c3"] },
        status: "PENDING",
      },
      orderBy: { createdAt: "asc" },
    });
    expect(applyApprovalDecision.mock.calls.map((c) => c[0].approval.id)).toEqual(
      ["a1", "a2"],
    );
    expect(applyApprovalDecision).toHaveBeenCalledWith({
      approval: { id: "a1" },
      to: "APPROVED",
      reviewedByUserId: "user-1",
      actorType: "USER",
    });
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "content_plan.approved_all",
        entityId: "plan-1",
        metadata: { approved: 2, failed: 0 },
      }),
    );
  });

  it("checks access to the plan's own project", async () => {
    await approvePlanItemsAction("plan-1");
    expect(requireProjectAccess).toHaveBeenCalledWith("user-1", "proj-1");
  });

  it("a piece that cannot be approved never hides the others", async () => {
    applyApprovalDecision
      .mockRejectedValueOnce(new Error("nope"))
      .mockResolvedValueOnce(undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await approvePlanItemsAction("plan-1")).toEqual({
      ok: true,
      approved: 1,
      failed: 1,
    });
  });

  it("refuses something that is not a plan, or has nothing saved", async () => {
    commandFindUnique.mockResolvedValue({
      projectId: "proj-1",
      parsedIntent: { card: { kind: "content-package" } },
    });
    expect(await approvePlanItemsAction("x")).toEqual({
      ok: false,
      message: "Plan not found.",
    });
    commandFindUnique.mockResolvedValue(planRow({ savedCreativeIds: [] }));
    expect(await approvePlanItemsAction("x")).toMatchObject({ ok: false });
    commandFindUnique.mockResolvedValue(null);
    expect(await approvePlanItemsAction("x")).toEqual({
      ok: false,
      message: "Plan not found.",
    });
    expect(applyApprovalDecision).not.toHaveBeenCalled();
  });

  it("says so when nothing is waiting", async () => {
    approvalFindMany.mockResolvedValue([]);
    expect(await approvePlanItemsAction("plan-1")).toEqual({
      ok: false,
      message: "Nothing is waiting for your decision.",
    });
    expect(applyApprovalDecision).not.toHaveBeenCalled();
  });

  it("does not decide anything for a user without access to the project", async () => {
    requireProjectAccess.mockRejectedValue(new Error("Project not found"));
    expect(await approvePlanItemsAction("plan-1")).toEqual({
      ok: false,
      message: "Project not found",
    });
    expect(approvalFindMany).not.toHaveBeenCalled();
  });
});

describe("enablePlanPublishingAction", () => {
  it("turns scheduled posting on from the clock times the plan uses", async () => {
    creativeFindMany.mockResolvedValue([
      { scheduledFor: new Date("2099-10-05T07:00:00Z") },
      { scheduledFor: new Date("2099-10-06T07:00:00Z") },
      { scheduledFor: new Date("2099-10-07T15:00:00Z") },
    ]);
    const result = await enablePlanPublishingAction("proj-1");
    expect(result).toEqual({ ok: true, times: ["10:00", "18:00"] });
    expect(enableScheduledPublishing).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      projectId: "proj-1",
      brandId: "brand-1",
      timezone: "Europe/Istanbul",
      times: ["10:00", "18:00"],
    });
    // Only this project's Instagram plan pieces still ahead count.
    expect(creativeFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          projectId: "proj-1",
          planId: { not: null },
          platform: "INSTAGRAM",
        }),
      }),
    );
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "instagram_publish_schedule.enabled_from_plan",
      }),
    );
  });

  it("needs a connected account and access to the project", async () => {
    getPublishTargets.mockResolvedValue([]);
    expect(await enablePlanPublishingAction("proj-1")).toEqual({
      ok: false,
      message: "Connect Instagram first.",
    });
    expect(enableScheduledPublishing).not.toHaveBeenCalled();

    requireProjectAccess.mockRejectedValue(new Error("Project not found"));
    expect(await enablePlanPublishingAction("proj-1")).toEqual({
      ok: false,
      message: "Project not found",
    });
  });
});

describe("getManualPublishItemsAction", () => {
  it("returns what the client needs to post approved pieces themselves", async () => {
    creativeFindMany.mockResolvedValue([
      {
        id: "c1",
        title: "Clinic guide",
        channel: "seo",
        formatKey: "seo.article",
        scheduledFor: new Date("2026-10-05T07:00:00Z"),
        versions: [{ caption: null, copy: "Full article text", assetId: null }],
      },
      {
        id: "c2",
        title: "Tour",
        channel: "instagram",
        formatKey: "instagram.reel",
        scheduledFor: null,
        versions: [{ caption: "Caption", copy: "Longer", assetId: "asset-1" }],
      },
    ]);
    const result = await getManualPublishItemsAction("proj-1", ["c1", "c2"]);
    expect(result).toEqual({
      ok: true,
      items: [
        {
          id: "c1",
          title: "Clinic guide",
          where: "Blog / SEO · Article",
          date: "2026-10-05",
          text: "Full article text",
          assetId: undefined,
        },
        {
          id: "c2",
          title: "Tour",
          where: "Instagram · Reel",
          date: "",
          // The caption wins over the longer copy.
          text: "Caption",
          assetId: "asset-1",
        },
      ],
    });
    // Approved pieces of the caller's project only.
    expect(creativeFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["c1", "c2"] }, projectId: "proj-1", status: "APPROVED" },
      }),
    );
  });
});

describe("markCreativePublishedAction", () => {
  beforeEach(() => {
    creativeFindUnique.mockResolvedValue({
      projectId: "proj-1",
      status: "APPROVED",
      createdByTaskId: "task-1",
    });
  });

  it("moves an approved piece to published and updates its chat card", async () => {
    expect(await markCreativePublishedAction("c1")).toEqual({ ok: true });
    expect(requireProjectAccess).toHaveBeenCalledWith("user-1", "proj-1");
    expect(creativeTransition).toHaveBeenCalledWith("c1", "proj-1", "PUBLISHED");
    expect(markCreativePublishState).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-1",
        creativeId: "c1",
        publishState: "published",
      }),
    );
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: "creative.marked_published" }),
    );
  });

  it("only an approved piece can be marked, and a stale card never undoes the change", async () => {
    creativeFindUnique.mockResolvedValue({
      projectId: "proj-1",
      status: "IN_REVIEW",
      createdByTaskId: null,
    });
    expect(await markCreativePublishedAction("c1")).toEqual({
      ok: false,
      message: "Approve this piece before marking it as published.",
    });
    creativeFindUnique.mockResolvedValue({
      projectId: "proj-1",
      status: "PUBLISHED",
      createdByTaskId: null,
    });
    expect(await markCreativePublishedAction("c1")).toMatchObject({
      ok: false,
      message: "This piece is already marked as published.",
    });
    expect(creativeTransition).not.toHaveBeenCalled();

    // The card update failing must not fail the publish that already happened.
    creativeFindUnique.mockResolvedValue({
      projectId: "proj-1",
      status: "APPROVED",
      createdByTaskId: "task-1",
    });
    markCreativePublishState.mockRejectedValue(new Error("card gone"));
    expect(await markCreativePublishedAction("c1")).toEqual({ ok: true });
  });

  it("does not touch a piece of a project the caller cannot access", async () => {
    requireProjectAccess.mockRejectedValue(new Error("Project not found"));
    expect(await markCreativePublishedAction("c1")).toEqual({
      ok: false,
      message: "Project not found",
    });
    expect(creativeTransition).not.toHaveBeenCalled();
  });

  it("a piece that does not exist is not found", async () => {
    creativeFindUnique.mockResolvedValue(null);
    expect(await markCreativePublishedAction("x")).toEqual({
      ok: false,
      message: "Piece not found.",
    });
  });
});

describe("getPlanResultsAction", () => {
  it("returns the measurement results for a project the caller can access", async () => {
    loadPlanResults.mockResolvedValue([{ creativeId: "c1" }]);
    expect(await getPlanResultsAction("proj-1")).toEqual({
      ok: true,
      results: [{ creativeId: "c1" }],
    });
    expect(requireProjectAccess).toHaveBeenCalledWith("user-1", "proj-1");
    expect(loadPlanResults).toHaveBeenCalledWith("proj-1");
  });

  it("reads nothing for a project the caller cannot access", async () => {
    requireProjectAccess.mockRejectedValue(new Error("Project not found"));
    expect(await getPlanResultsAction("proj-1")).toEqual({
      ok: false,
      message: "Project not found",
    });
    expect(loadPlanResults).not.toHaveBeenCalled();
  });
});
