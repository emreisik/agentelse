import { beforeEach, describe, expect, it, vi } from "vitest";

// The Autonomy settings form (billing, Faz 3C): the limits a person sets for themselves
// never go past their plan.

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  access: vi.fn(),
  entitlements: vi.fn(),
  update: vi.fn(),
  findUnique: vi.fn(),
  record: vi.fn(),
  revalidate: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@/lib/prisma", () => ({
  prisma: { autonomyPolicy: { findUnique: mocks.findUnique } },
}));
vi.mock("@/server/security/tenant-context", () => ({
  requireUser: mocks.requireUser,
  requireProjectAccess: mocks.access,
}));
vi.mock("@/server/billing/entitlements", () => ({
  getEntitlements: mocks.entitlements,
}));
vi.mock("@/server/repositories/autonomy-policy.repository", () => ({
  AutonomyPolicyRepository: { update: mocks.update },
}));
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: mocks.record },
}));
vi.mock("@/server/agency/signals/scan-cadence", () => ({
  nextScanAt: vi.fn(),
}));

const { updateAutonomyPolicyAction } = await import("./agency-config-actions");

function form(values: Record<string, string>) {
  const data = new FormData();
  data.set("projectId", "p1");
  data.set("maxReasoningCallsPerDay", "200");
  data.set("maxActiveIdeas", "20");
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue({ userId: "u1" });
  mocks.access.mockResolvedValue({ workspaceId: "w1", defaultBrandId: "b1" });
  mocks.findUnique.mockResolvedValue({ autopilotMode: "SUGGEST" });
  mocks.update.mockResolvedValue({});
  mocks.record.mockResolvedValue(undefined);
  mocks.entitlements.mockResolvedValue({
    unlimited: false,
    planKey: "starter",
  });
});

const saved = () => mocks.update.mock.calls[0]![1] as Record<string, unknown>;

describe("updateAutonomyPolicyAction and the plan", () => {
  it("keeps the daily budget under the plan's monthly AI budget", async () => {
    const result = await updateAutonomyPolicyAction(
      form({ dailyBudgetUsd: "500" }),
    );

    expect(result).toEqual({ ok: true });
    expect(saved().dailyBudgetUsd).toBe(3); // Starter: $3 of AI usage a month
  });

  it("keeps the approval size inside the plan's range, and blank means the plan's size", async () => {
    await updateAutonomyPolicyAction(form({ approveAboveUsd: "50" }));
    expect(saved().approveAboveUsd).toBe(2.5); // 5 x Starter's $0.50

    mocks.update.mockClear();
    await updateAutonomyPolicyAction(form({ approveAboveUsd: "0.02" }));
    expect(saved().approveAboveUsd).toBe(0.1);

    mocks.update.mockClear();
    await updateAutonomyPolicyAction(form({ approveAboveUsd: "" }));
    expect(saved().approveAboveUsd).toBeNull();
  });

  it("leaves a value inside the range alone", async () => {
    await updateAutonomyPolicyAction(
      form({ approveAboveUsd: "1.25", dailyBudgetUsd: "0.75" }),
    );
    expect(saved()).toMatchObject({
      approveAboveUsd: 1.25,
      dailyBudgetUsd: 0.75,
    });
  });

  it("without a plan (billing off or unlimited) only the absolute bounds apply", async () => {
    mocks.entitlements.mockResolvedValue({ unlimited: true, planKey: null });

    await updateAutonomyPolicyAction(
      form({ approveAboveUsd: "5000", dailyBudgetUsd: "500" }),
    );

    expect(saved()).toMatchObject({
      approveAboveUsd: 100,
      dailyBudgetUsd: 500,
    });
  });

  it("unlimited mode is still just the daily counters: it is saved, the plan is read as before", async () => {
    await updateAutonomyPolicyAction(
      form({ unlimitedMode: "on", dailyBudgetUsd: "500" }),
    );

    expect(saved()).toMatchObject({ unlimitedMode: true, dailyBudgetUsd: 3 });
  });

  it("refuses a value that is not a number", async () => {
    const result = await updateAutonomyPolicyAction(
      form({ approveAboveUsd: "lots" }),
    );
    expect(result.ok).toBe(false);
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
