import { beforeEach, describe, expect, it, vi } from "vitest";

// docs/meta-ads-plan.md F0b: a risk-reducing proposal (PAUSE / REDUCE) never
// drops on the daily task quota, a dropped proposal leaves a trace, and
// budget scale-ups wait for F2.

const m = vi.hoisted(() => ({
  plan: vi.fn(),
  checkAndIncrement: vi.fn(),
  findRecent: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@/server/commands/task-planner", () => ({
  TaskPlanner: { planForCapability: m.plan },
}));
vi.mock("@/server/repositories/autonomy-policy.repository", () => ({
  AutonomyPolicyRepository: {
    getOrCreate: vi.fn().mockResolvedValue({ taskCooldownHours: 24 }),
    checkAndIncrement: m.checkAndIncrement,
  },
}));
vi.mock("@/server/repositories/task.repository", () => ({
  TaskRepository: { findRecentByFingerprint: m.findRecent },
}));
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: m.audit },
}));

const { PerformanceOptimizer } = await import("./performance-optimizer");

const scope = { workspaceId: "w", projectId: "p", brandId: "b" };
const finding = (suggestedAction: unknown) =>
  ({
    rule: "HIGH_CPA",
    severity: "HIGH",
    title: "Ad set: high cost per result",
    summary: "summary",
    suggestedAction,
    metricsSnapshot: {},
  }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  m.findRecent.mockResolvedValue(null);
  m.audit.mockResolvedValue(undefined);
  m.plan.mockResolvedValue({});
});

describe("PerformanceOptimizer (F0b)", () => {
  it("proposes a PAUSE even when the daily task quota is full", async () => {
    m.checkAndIncrement.mockRejectedValue(new Error("cap"));
    const result = await PerformanceOptimizer.proposeAdSetAction({
      scope,
      campaignId: "k1",
      adSetId: "as1",
      adSetName: "TR",
      currentDailyBudgetCents: 5000,
      finding: finding({ type: "PAUSE" }),
      account: { adAccountId: "act_1", currency: "TRY" },
    });
    expect(result).toEqual({ proposed: true });
    expect(m.checkAndIncrement).not.toHaveBeenCalled();
    expect(m.plan).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "META_ADSET_UPDATE",
        payloadExtra: expect.objectContaining({
          adSetId: "as1",
          proposedStatus: "PAUSED",
          adAccountId: "act_1",
          currency: "TRY",
        }),
      }),
    );
  });

  it("does not propose a budget scale-up before F2", async () => {
    const result = await PerformanceOptimizer.proposeCampaignAction({
      scope,
      campaignId: "k1",
      campaignName: "Spring",
      currentDailyBudgetCents: 5000,
      finding: finding({
        type: "SCALE_BUDGET",
        proposedDailyBudgetCents: 6500,
      }),
    });
    expect(result).toEqual({ proposed: false, reason: "no-action" });
    expect(m.plan).not.toHaveBeenCalled();
  });

  it("keeps the cooldown: an open proposal for the same ad set blocks a second one", async () => {
    m.findRecent.mockResolvedValue({ id: "t1" });
    const result = await PerformanceOptimizer.proposeAdSetAction({
      scope,
      campaignId: "k1",
      adSetId: "as1",
      adSetName: "TR",
      currentDailyBudgetCents: 5000,
      finding: finding({ type: "REDUCE_BUDGET", proposedDailyBudgetCents: 3500 }),
    });
    expect(result).toEqual({ proposed: false, reason: "cooldown" });
  });
});
