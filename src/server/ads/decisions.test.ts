import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  decisionFindFirst: vi.fn(),
  decisionUpdateMany: vi.fn(),
  approvalFindUnique: vi.fn(),
  jobFindFirst: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    adsDecision: { findFirst: db.decisionFindFirst, updateMany: db.decisionUpdateMany },
    approval: { findUnique: db.approvalFindUnique },
    executionJob: { findFirst: db.jobFindFirst },
  },
}));
vi.mock("@/server/ads/accounts", () => ({ AdsAccounts: {} }));
vi.mock("@/server/commands/task-planner", () => ({ TaskPlanner: {} }));
vi.mock("@/server/integrations/meta/launch-writes", () => ({ readBack: vi.fn() }));
vi.mock("@/server/integrations/meta/call-context", () => ({
  withMetaCallContext: (_c: unknown, run: () => unknown) => run(),
}));
const notify = vi.hoisted(() => ({
  applied: vi.fn(async () => undefined),
  failed: vi.fn(async () => undefined),
  undone: vi.fn(async () => undefined),
}));
vi.mock("@/server/ads/autopilot-notify", () => ({ AutopilotNotify: notify }));

import { AdsDecisions, changeOf } from "./decisions";

const now = new Date("2026-10-06T10:00:00Z");

describe("AdsDecisions lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.decisionUpdateMany.mockResolvedValue({ count: 1 });
  });

  it("applies on completion and waits for mature data before judging", async () => {
    db.decisionFindFirst.mockResolvedValue({ id: "d1", evidence: { offsite: true }, rollbackOfId: null });
    await AdsDecisions.onTaskCompleted("t1", now);
    const data = db.decisionUpdateMany.mock.calls[0]![0].data;
    expect(data.status).toBe("APPLIED");
    // 7-day after window + 7 days of maturity for off-site conversions.
    expect(data.evaluateAfter.toISOString()).toBe("2026-10-20T10:00:00.000Z");
  });

  it("marks the original rolled back when an undo lands", async () => {
    db.decisionFindFirst.mockResolvedValue({ id: "d2", evidence: {}, rollbackOfId: "d1" });
    await AdsDecisions.onTaskCompleted("t2", now);
    expect(db.decisionUpdateMany.mock.calls[1]![0]).toEqual({
      where: { id: "d1" },
      data: { status: "ROLLED_BACK" },
    });
  });

  it("maps a stopped task to the decision's end", async () => {
    db.decisionFindFirst.mockResolvedValue({ id: "d1", approvalId: "ap1" });
    db.approvalFindUnique.mockResolvedValue({ status: "REJECTED" });
    db.jobFindFirst.mockResolvedValue(null);
    await AdsDecisions.onTaskTerminal("t1", "CANCELLED");
    expect(db.decisionUpdateMany.mock.calls[0]![0].data.status).toBe("REJECTED");

    db.approvalFindUnique.mockResolvedValue({ status: "APPROVED" });
    db.jobFindFirst.mockResolvedValue({ errorCode: "META:STATE:superseded" });
    await AdsDecisions.onTaskTerminal("t1", "FAILED");
    expect(db.decisionUpdateMany.mock.calls[1]![0].data.status).toBe("SUPERSEDED");

    db.jobFindFirst.mockResolvedValue({ errorCode: "META:VALIDATION:100" });
    await AdsDecisions.onTaskTerminal("t1", "FAILED");
    expect(db.decisionUpdateMany.mock.calls[2]![0].data.status).toBe("FAILED");
  });

  it("reports an automatic change after it lands, and a failed one as critical (F7)", async () => {
    db.decisionFindFirst.mockResolvedValue({
      id: "d3",
      evidence: {},
      rollbackOfId: null,
      autonomy: "GUARDED",
    });
    await AdsDecisions.onTaskCompleted("t3", now);
    expect(notify.applied).toHaveBeenCalledWith(
      expect.objectContaining({ id: "d3" }),
      now,
    );

    db.decisionFindFirst.mockResolvedValue({ id: "d4", approvalId: null, autonomy: "GUARDED" });
    db.jobFindFirst.mockResolvedValue({ errorCode: "META:TRANSIENT:2" });
    await AdsDecisions.onTaskTerminal("t4", "FAILED");
    expect(notify.failed).toHaveBeenCalledWith(expect.objectContaining({ id: "d4" }));
  });

  it("does not announce suggestions a person approved", async () => {
    db.decisionFindFirst.mockResolvedValue({
      id: "d5",
      evidence: {},
      rollbackOfId: null,
      autonomy: "SUGGEST",
    });
    await AdsDecisions.onTaskCompleted("t5", now);
    expect(notify.applied).not.toHaveBeenCalled();
  });

  it("closes the automatic-change notice when it is undone", async () => {
    db.decisionFindFirst.mockResolvedValue({
      id: "d6",
      evidence: {},
      rollbackOfId: "d3",
      projectId: "p1",
      autonomy: "SUGGEST",
    });
    await AdsDecisions.onTaskCompleted("t6", now);
    expect(notify.undone).toHaveBeenCalledWith("d3", "p1", now);
  });

  it("reads a change defensively", () => {
    expect(changeOf({ change: { field: "dailyBudgetMinor", from: 1, to: 2 } })).toEqual({
      field: "dailyBudgetMinor",
      from: 1,
      to: 2,
    });
    expect(changeOf({ change: null })).toBeNull();
    expect(changeOf({ change: { field: "status" } })).toBeNull();
  });
});
