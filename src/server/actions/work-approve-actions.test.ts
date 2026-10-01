import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  isWorksEnabled: vi.fn(),
  isRateLimited: vi.fn(),
  commandFindMany: vi.fn(),
  workFindFirst: vi.fn(),
  approvalFindMany: vi.fn(),
  versionFindMany: vi.fn(),
  applyApprovalDecision: vi.fn(),
  loadLiveCreativeRows: vi.fn(),
  loadLiveInputs: vi.fn(),
  record: vi.fn(),
  revalidatePath: vi.fn(),
  approvePlanItemsAction: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/server/security/tenant-context", () => ({
  requireUser: mocks.requireUser,
  requireProjectAccess: mocks.requireProjectAccess,
}));
vi.mock("@/server/works/flag", () => ({ isWorksEnabled: mocks.isWorksEnabled }));
vi.mock("@/lib/rate-limit", () => ({ isRateLimited: mocks.isRateLimited }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    command: { findMany: mocks.commandFindMany },
    work: { findFirst: mocks.workFindFirst },
    approval: { findMany: mocks.approvalFindMany },
    creativeVersion: { findMany: mocks.versionFindMany },
  },
}));
vi.mock("@/server/commands/approval-decisions", () => ({
  applyApprovalDecision: mocks.applyApprovalDecision,
}));
vi.mock("@/server/agency/journey/live-creative-state", () => ({
  loadLiveCreativeRows: mocks.loadLiveCreativeRows,
  loadLiveInputs: mocks.loadLiveInputs,
}));
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: mocks.record },
}));
vi.mock("@/server/actions/plan-progress-actions", () => ({
  approvePlanItemsAction: mocks.approvePlanItemsAction,
}));

import { approvePlansAction } from "@/server/actions/work-approve-actions";

function planCommand(id: string, savedCreativeIds: string[], workId: string | null = null) {
  return {
    id,
    workId,
    parsedIntent: {
      card: {
        kind: "content-plan-draft",
        title: "Plan",
        summary: "s",
        items: [],
        savedCreativeIds,
      },
    },
  };
}

const pendingOf = (ids: string[]) =>
  ids.map((id) => ({ id: `a-${id}`, entityId: id, status: "PENDING" }));

const NOW = new Date("2026-10-01T10:00:00Z");

function liveRow(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    status: "APPROVED",
    platform: "INSTAGRAM",
    channel: "instagram",
    formatKey: "instagram.post",
    scheduledFor: new Date("2026-10-05T10:00:00Z"),
    planId: "c1",
    version: { version: 1, assetId: "as1" },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isWorksEnabled.mockReturnValue(true);
  mocks.isRateLimited.mockReturnValue(false);
  mocks.requireUser.mockResolvedValue({ userId: "u1" });
  mocks.requireProjectAccess.mockResolvedValue({
    workspaceId: "w1",
    defaultBrandId: "b1",
  });
  mocks.commandFindMany.mockResolvedValue([planCommand("c1", ["k1", "k2"], "wk1")]);
  mocks.workFindFirst.mockResolvedValue({ status: "ACTIVE" });
  mocks.approvalFindMany.mockResolvedValue(pendingOf(["k1", "k2"]));
  mocks.versionFindMany.mockResolvedValue([]);
  mocks.applyApprovalDecision.mockResolvedValue(undefined);
  mocks.loadLiveCreativeRows.mockResolvedValue(new Map());
  mocks.loadLiveInputs.mockResolvedValue({
    now: NOW,
    connectedPlatforms: new Set(["instagram"]),
    scheduleEnabled: true,
  });
  mocks.record.mockResolvedValue(undefined);
});

describe("approvePlansAction", () => {
  it("is disabled when Works is off and touches nothing", async () => {
    mocks.isWorksEnabled.mockReturnValue(false);
    const r = await approvePlansAction("p1", { planIds: ["c1"], creativeIds: ["k1"] });
    expect(r).toMatchObject({ ok: false, code: "DISABLED" });
    expect(mocks.commandFindMany).not.toHaveBeenCalled();
  });

  it("is rate limited", async () => {
    mocks.isRateLimited.mockReturnValue(true);
    const r = await approvePlansAction("p1", { planIds: ["c1"], creativeIds: ["k1"] });
    expect(r).toMatchObject({ ok: false, code: "RATE" });
    expect(mocks.isRateLimited).toHaveBeenCalledWith(
      "approve-plans:u1",
      20,
      10 * 60_000,
    );
    expect(mocks.applyApprovalDecision).not.toHaveBeenCalled();
  });

  it("scopes plans and approvals to the project; foreign plans yield nothing", async () => {
    mocks.commandFindMany.mockResolvedValue([]);
    const r = await approvePlansAction("p1", {
      planIds: ["foreign"],
      creativeIds: ["k1"],
    });
    expect(mocks.commandFindMany.mock.calls[0]?.[0].where).toMatchObject({
      id: { in: ["foreign"] },
      projectId: "p1",
    });
    expect(mocks.approvalFindMany).not.toHaveBeenCalled();
    expect(mocks.applyApprovalDecision).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, approved: 0 });
  });

  it("looks the Work up with the project id", async () => {
    await approvePlansAction("p1", { planIds: ["c1"], creativeIds: ["k1", "k2"] });
    expect(mocks.workFindFirst.mock.calls[0]?.[0].where).toEqual({
      id: "wk1",
      projectId: "p1",
    });
    expect(mocks.approvalFindMany.mock.calls[0]?.[0].where).toMatchObject({
      projectId: "p1",
      entityType: "Creative",
      status: "PENDING",
    });
  });

  it("caps and dedupes both lists, dropping invalid ids", async () => {
    const planIds = Array.from({ length: 20 }, (_, i) => `c${i}`);
    const creativeIds = [
      ...Array.from({ length: 150 }, (_, i) => `k${i}`),
      "k0",
      "x".repeat(65),
    ];
    mocks.commandFindMany.mockResolvedValue([]);
    await approvePlansAction("p1", { planIds: [...planIds, "c0"], creativeIds });
    expect(mocks.commandFindMany.mock.calls[0]?.[0].where.id.in).toHaveLength(12);
  });

  it("caps shown ids at 100 (a larger pending set is then CHANGED)", async () => {
    const ids = Array.from({ length: 105 }, (_, i) => `k${i}`);
    mocks.commandFindMany.mockResolvedValue([planCommand("c1", ids)]);
    mocks.approvalFindMany.mockResolvedValue(pendingOf(ids));
    const r = await approvePlansAction("p1", { planIds: ["c1"], creativeIds: ids });
    expect(r).toMatchObject({ ok: false, code: "CHANGED" });
    expect(mocks.applyApprovalDecision).not.toHaveBeenCalled();
  });

  it("approves only the shown pieces, one after another, never via approvePlanItemsAction", async () => {
    let running = 0;
    let maxRunning = 0;
    mocks.applyApprovalDecision.mockImplementation(async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await Promise.resolve();
      running -= 1;
    });
    const r = await approvePlansAction("p1", {
      planIds: ["c1"],
      creativeIds: ["k1", "k2", "k-not-pending"],
    });
    expect(r).toMatchObject({ ok: true, approved: 2, failed: 0, locked: 0 });
    expect(maxRunning).toBe(1);
    expect(mocks.applyApprovalDecision).toHaveBeenCalledTimes(2);
    expect(mocks.applyApprovalDecision.mock.calls[0]?.[0]).toMatchObject({
      to: "APPROVED",
      reviewedByUserId: "u1",
      actorType: "USER",
    });
    expect(mocks.approvePlanItemsAction).not.toHaveBeenCalled();
  });

  it("approves nothing and answers CHANGED when more are pending than were shown", async () => {
    mocks.approvalFindMany.mockResolvedValue(pendingOf(["k1", "k2"]));
    const r = await approvePlansAction("p1", { planIds: ["c1"], creativeIds: ["k1"] });
    expect(r).toEqual({
      ok: false,
      code: "CHANGED",
      message: "1 more pieces are ready. Review them first.",
    });
    expect(mocks.applyApprovalDecision).not.toHaveBeenCalled();
  });

  it("leaves a piece with alternatives for review: not approved, not counted as unseen", async () => {
    // k3 has alternatives; the page's filtered step lists only k1 and k2.
    mocks.approvalFindMany.mockResolvedValue(pendingOf(["k1", "k2", "k3"]));
    mocks.versionFindMany.mockResolvedValue([
      { creativeId: "k3", generationMetadata: { alternatives: [{ assetId: "x" }] } },
      { creativeId: "k1", generationMetadata: { alternatives: [] } },
    ]);
    const r = await approvePlansAction("p1", {
      planIds: ["c1"],
      creativeIds: ["k1", "k2"],
    });
    expect(r).toMatchObject({ ok: true, approved: 2 });
    const approvedIds = mocks.applyApprovalDecision.mock.calls.map(
      (c) => c[0].approval.entityId,
    );
    expect(approvedIds).toEqual(["k1", "k2"]);
    expect(mocks.versionFindMany.mock.calls[0]?.[0].where).toMatchObject({
      version: 1,
      creative: { projectId: "p1" },
    });
  });

  it("still answers CHANGED for a genuinely new piece without alternatives", async () => {
    mocks.approvalFindMany.mockResolvedValue(pendingOf(["k1", "k2", "k3"]));
    mocks.versionFindMany.mockResolvedValue([
      { creativeId: "k3", generationMetadata: { alternatives: [{ assetId: "x" }] } },
    ]);
    const r = await approvePlansAction("p1", { planIds: ["c1"], creativeIds: ["k1"] });
    expect(r).toMatchObject({ ok: false, code: "CHANGED" });
    expect(mocks.applyApprovalDecision).not.toHaveBeenCalled();
  });

  it("skips plans of a completed Work and counts them as locked", async () => {
    mocks.commandFindMany.mockResolvedValue([
      planCommand("c1", ["k1"], "wk-done"),
      planCommand("c2", ["k2"], "wk1"),
    ]);
    mocks.workFindFirst.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === "wk-done" ? { status: "DONE" } : { status: "ACTIVE" },
    );
    mocks.approvalFindMany.mockResolvedValue(pendingOf(["k2"]));
    const r = await approvePlansAction("p1", {
      planIds: ["c1", "c2"],
      creativeIds: ["k2"],
    });
    expect(mocks.approvalFindMany.mock.calls[0]?.[0].where.entityId.in).toEqual(["k2"]);
    expect(r).toMatchObject({ ok: true, approved: 1, locked: 1 });
  });

  it("allows a plan with no Work", async () => {
    mocks.commandFindMany.mockResolvedValue([planCommand("c1", ["k1"], null)]);
    mocks.approvalFindMany.mockResolvedValue(pendingOf(["k1"]));
    const r = await approvePlansAction("p1", { planIds: ["c1"], creativeIds: ["k1"] });
    expect(mocks.workFindFirst).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, approved: 1, locked: 0 });
  });

  it("a piece no longer pending is not a failure; a throwing approval is", async () => {
    mocks.approvalFindMany.mockResolvedValue(pendingOf(["k1"]));
    const r1 = await approvePlansAction("p1", {
      planIds: ["c1"],
      creativeIds: ["k1", "k2"],
    });
    expect(r1).toMatchObject({ ok: true, approved: 1, failed: 0 });

    mocks.approvalFindMany.mockResolvedValue(pendingOf(["k1", "k2"]));
    mocks.applyApprovalDecision.mockRejectedValueOnce(new Error("boom"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r2 = await approvePlansAction("p1", {
      planIds: ["c1"],
      creativeIds: ["k1", "k2"],
    });
    expect(r2).toMatchObject({ ok: true, approved: 1, failed: 1 });
  });

  it("an approval another tab already decided is skipped, not failed", async () => {
    mocks.approvalFindMany.mockResolvedValue(pendingOf(["k1", "k2"]));
    mocks.applyApprovalDecision.mockRejectedValueOnce(
      Object.assign(new Error("Approval a1 was already decided"), {
        code: "INVALID_STATE_TRANSITION",
      }),
    );
    const r = await approvePlansAction("p1", {
      planIds: ["c1"],
      creativeIds: ["k1", "k2"],
    });
    expect(r).toMatchObject({ ok: true, approved: 1, failed: 0 });
  });

  it("does not count a legacy (not Work-owned) piece as held", async () => {
    mocks.loadLiveCreativeRows.mockResolvedValue(
      new Map([["k1", liveRow("k1", { scheduledFor: null, owned: false })]]),
    );
    mocks.commandFindMany.mockResolvedValue([planCommand("c1", ["k1"])]);
    mocks.approvalFindMany.mockResolvedValue(pendingOf(["k1"]));
    const r = await approvePlansAction("p1", {
      planIds: ["c1"],
      creativeIds: ["k1"],
    });
    expect(r).toMatchObject({ ok: true, approved: 1, held: 0 });
  });

  it("counts held only for pieces whose publish line is held", async () => {
    mocks.loadLiveCreativeRows.mockResolvedValue(
      new Map([
        ["k1", liveRow("k1", { scheduledFor: null })], // held: no time
        ["k2", liveRow("k2")], // scheduled
        ["k3", liveRow("k3", { scheduledFor: null, platform: "LINKEDIN", channel: "linkedin", formatKey: "linkedin.post" })], // manual
        ["k4", liveRow("k4", { status: "PUBLISHED", scheduledFor: null })], // published
      ]),
    );
    mocks.commandFindMany.mockResolvedValue([planCommand("c1", ["k1", "k2", "k3", "k4"])]);
    mocks.approvalFindMany.mockResolvedValue(pendingOf(["k1", "k2", "k3", "k4"]));
    mocks.loadLiveInputs.mockResolvedValue({
      now: NOW,
      connectedPlatforms: new Set(["instagram", "linkedin"]),
      scheduleEnabled: true,
    });
    const r = await approvePlansAction("p1", {
      planIds: ["c1"],
      creativeIds: ["k1", "k2", "k3", "k4"],
    });
    expect(mocks.loadLiveCreativeRows).toHaveBeenCalledWith("p1", ["k1", "k2", "k3", "k4"]);
    expect(r).toMatchObject({ ok: true, approved: 4, held: 1 });
    expect(mocks.record.mock.calls[0]?.[0]).toMatchObject({
      action: "content_plan.approved_plans",
      metadata: { plans: 1, approved: 4, failed: 0, held: 1, locked: 0 },
    });
  });
});
