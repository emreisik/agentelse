import { beforeEach, describe, expect, it, vi } from "vitest";

// Otomatik pilotun orkestrasyonu (docs/meta-ads-plan.md §1.2, F7): seviye ve
// kapılar → görev yükü. Yük, yürütücünün (MetaApiProvider) beklediği
// alanlarla birebir eşleşmeli: aksi hâlde güvenlik eylemi reddedilir.

const db = vi.hoisted(() => ({
  policy: vi.fn(),
  account: vi.fn(),
  credential: vi.fn(),
  decisionCount: vi.fn(),
  decisionFindFirst: vi.fn(),
  decisionUpdate: vi.fn(),
  decisionCreate: vi.fn(),
  opFindFirst: vi.fn(),
  objectFindFirst: vi.fn(),
  approvalFindFirst: vi.fn(),
}));
const planner = vi.hoisted(() => ({ planForCapability: vi.fn() }));
const drive = vi.hoisted(() => ({ driveLaunchInline: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    autonomyPolicy: { findUnique: db.policy },
    adsAccount: { findUnique: db.account },
    integrationCredential: { findUnique: db.credential },
    adsDecision: {
      count: db.decisionCount,
      findFirst: db.decisionFindFirst,
      update: db.decisionUpdate,
      create: db.decisionCreate,
    },
    adsOperation: { findFirst: db.opFindFirst },
    adsObject: { findFirst: db.objectFindFirst },
    approval: { findFirst: db.approvalFindFirst },
  },
}));
vi.mock("@/server/commands/task-planner", () => ({ TaskPlanner: planner }));
vi.mock("@/server/ads/launch/drive", () => drive);
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("./decisions", async () => {
  const actual = await vi.importActual<typeof import("./decisions")>("./decisions");
  return { changeOf: actual.changeOf };
});

import type { AdsDecision } from "@prisma/client";

import { AdsAutopilot } from "./autopilot";

const NOW = new Date("2026-10-06T10:00:00Z");

const account = {
  id: "acc-1",
  externalId: "act_1",
  credentialId: "cred-1",
  currency: "TRY",
  timezoneName: "Europe/Istanbul",
  healthStatus: "OK",
  lastStructureAt: new Date(NOW.getTime() - 10 * 60_000),
  lastInsightsAt: new Date(NOW.getTime() - 10 * 60_000),
  accessTier: "development_access",
};

function decision(overrides: Partial<AdsDecision> = {}): AdsDecision {
  return {
    id: "dec-1",
    workspaceId: "ws-1",
    projectId: "p-1",
    adsAccountId: "acc-1",
    level: "ADSET",
    externalId: "adset-9",
    ruleKey: "O2_HIGH_CPA",
    ruleVersion: 1,
    kind: "BUDGET_DOWN",
    severity: "WARN",
    status: "PROPOSED",
    autonomy: "SUGGEST",
    evidence: {},
    explanation: "Lower the daily budget of Spring from 100 TRY to 75 TRY.",
    change: { field: "dailyBudgetMinor", from: 10_000, to: 7_500 },
    fingerprint: "O2_HIGH_CPA:adset-9:2026-W41",
    approvalId: null,
    taskId: null,
    expiresAt: null,
    appliedAt: null,
    verifiedAt: null,
    evaluateAfter: null,
    evaluatedAt: null,
    outcome: null,
    outcomeData: null,
    rollbackOfId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as AdsDecision;
}

describe("AdsAutopilot.tryDecision", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.META_ADS_AUTOPILOT = "true";
    db.policy.mockResolvedValue({ adsAutonomy: "GUARDED" });
    db.account.mockResolvedValue(account);
    db.credential.mockResolvedValue({ status: "ACTIVE", metadata: { tokenHealth: { isValid: true } } });
    db.decisionCount.mockResolvedValue(0);
    db.decisionFindFirst.mockResolvedValue(null);
    db.opFindFirst.mockResolvedValue(null);
    db.objectFindFirst.mockResolvedValue({ driftAt: null });
    db.decisionUpdate.mockResolvedValue({});
    planner.planForCapability.mockResolvedValue({
      task: { id: "task-1" },
      dispatched: true,
      job: { id: "job-1" },
    });
    drive.driveLaunchInline.mockResolvedValue(undefined);
  });

  it("does nothing on its own in Suggest only", async () => {
    db.policy.mockResolvedValue({ adsAutonomy: "SUGGEST" });
    expect(
      await AdsAutopilot.tryDecision(decision(), { brandId: "b-1", adAccountId: "act_1", now: NOW }),
    ).toBe(false);
    expect(planner.planForCapability).not.toHaveBeenCalled();
  });

  it("does nothing while the flag is off, whatever the project says", async () => {
    delete process.env.META_ADS_AUTOPILOT;
    expect(
      await AdsAutopilot.tryDecision(decision(), { brandId: "b-1", adAccountId: "act_1", now: NOW }),
    ).toBe(false);
    expect(db.policy).not.toHaveBeenCalled();
  });

  it("Guarded cuts the budget through a risk-reducing safety action and drives it at once", async () => {
    expect(
      await AdsAutopilot.tryDecision(decision(), { brandId: "b-1", adAccountId: "act_1", now: NOW }),
    ).toBe(true);
    const input = planner.planForCapability.mock.calls[0]![0];
    expect(input).toMatchObject({
      capability: "META_SAFETY_ACTION",
      createdByType: "SYSTEM",
      adsAutonomy: "GUARDED",
      riskReducing: true,
      payloadExtra: {
        action: "BUDGET_DOWN",
        targets: [{ level: "ADSET", id: "adset-9" }],
        adAccountId: "act_1",
        decisionId: "dec-1",
        expectedDailyBudgetCents: 10_000,
        toDailyBudgetCents: 7_500,
      },
    });
    expect(input.autoBudgetRaise).toBeUndefined();
    expect(db.decisionUpdate).toHaveBeenCalledWith({
      where: { id: "dec-1" },
      data: expect.objectContaining({ autonomy: "GUARDED", status: "APPLYING", taskId: "task-1" }),
    });
    expect(drive.driveLaunchInline).toHaveBeenCalledWith("job-1", expect.any(Number));
  });

  it("stops at five automatic actions a day and leaves the reason on the decision", async () => {
    db.decisionCount.mockResolvedValue(5);
    expect(
      await AdsAutopilot.tryDecision(decision(), { brandId: "b-1", adAccountId: "act_1", now: NOW }),
    ).toBe(false);
    expect(planner.planForCapability).not.toHaveBeenCalled();
    expect(db.decisionUpdate.mock.calls[0]![0].data.evidence).toMatchObject({
      autopilot: "daily_limit",
    });
  });

  it("never raises a budget in Guarded auto", async () => {
    expect(
      await AdsAutopilot.tryDecision(
        decision({
          ruleKey: "O3_SCALE",
          kind: "BUDGET_UP",
          change: { field: "dailyBudgetMinor", from: 10_000, to: 12_000 },
        }),
        { brandId: "b-1", adAccountId: "act_1", now: NOW },
      ),
    ).toBe(false);
    expect(planner.planForCapability).not.toHaveBeenCalled();
  });

  it("pauses only on-platform zero-result ad sets", async () => {
    const zero = decision({
      ruleKey: "G3_ZERO_RESULTS",
      kind: "PAUSE",
      change: { field: "status", from: "ACTIVE", to: "PAUSED" },
    });
    expect(
      await AdsAutopilot.tryDecision(zero, {
        brandId: "b-1",
        adAccountId: "act_1",
        onPlatformResult: false,
        now: NOW,
      }),
    ).toBe(false);
    expect(
      await AdsAutopilot.tryDecision(zero, {
        brandId: "b-1",
        adAccountId: "act_1",
        onPlatformResult: true,
        now: NOW,
      }),
    ).toBe(true);
    expect(planner.planForCapability.mock.calls[0]![0].payloadExtra).toMatchObject({
      action: "PAUSE",
      targets: [{ level: "ADSET", id: "adset-9" }],
    });
  });

  it("keeps the decision waiting for approval when a project override raises the level", async () => {
    planner.planForCapability.mockResolvedValue({ task: { id: "task-2" }, dispatched: false });
    db.approvalFindFirst.mockResolvedValue({ id: "ap-1", expiresAt: NOW });
    expect(
      await AdsAutopilot.tryDecision(decision(), { brandId: "b-1", adAccountId: "act_1", now: NOW }),
    ).toBe(true);
    expect(db.decisionUpdate).toHaveBeenCalledWith({
      where: { id: "dec-1" },
      data: expect.objectContaining({ status: "PROPOSED", taskId: "task-2", approvalId: "ap-1" }),
    });
    expect(drive.driveLaunchInline).not.toHaveBeenCalled();
  });
});

describe("AdsAutopilot.tryGuardPause", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.META_ADS_AUTOPILOT = "true";
    db.policy.mockResolvedValue({ adsAutonomy: "GUARDED" });
    db.credential.mockResolvedValue({ status: "ACTIVE", metadata: {} });
    db.decisionCount.mockResolvedValue(0);
    db.decisionFindFirst.mockResolvedValue(null);
    db.opFindFirst.mockResolvedValue(null);
    db.objectFindFirst.mockResolvedValue(null);
    db.decisionCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      decision({ ...(data as Partial<AdsDecision>), id: "dec-g1" }),
    );
    db.decisionUpdate.mockResolvedValue({});
    planner.planForCapability.mockResolvedValue({
      task: { id: "task-9" },
      dispatched: true,
      job: { id: "job-9" },
    });
  });

  it("records a runaway pause once a day and runs it", async () => {
    const ok = await AdsAutopilot.tryGuardPause({
      workspaceId: "ws-1",
      projectId: "p-1",
      brandId: "b-1",
      account: account as never,
      level: "CAMPAIGN",
      externalId: "camp-1",
      ruleKey: "G1_RUNAWAY",
      explanation: 'Paused "Spring": it spent 450 TRY today against a daily budget of 100 TRY.',
      evidence: { breach: "daily" },
      dayKey: "2026-10-06",
      now: NOW,
    });
    expect(ok).toBe(true);
    expect(db.decisionCreate.mock.calls[0]![0].data).toMatchObject({
      ruleKey: "G1_RUNAWAY",
      kind: "PAUSE",
      level: "CAMPAIGN",
      fingerprint: "G1_RUNAWAY:camp-1:2026-10-06",
      change: { field: "status", from: "ACTIVE", to: "PAUSED" },
    });
    expect(planner.planForCapability.mock.calls[0]![0]).toMatchObject({
      capability: "META_SAFETY_ACTION",
      riskReducing: true,
      payloadExtra: { action: "PAUSE", targets: [{ level: "CAMPAIGN", id: "camp-1" }] },
    });
  });

  it("writes nothing in Suggest only (the alert's Pause button stays)", async () => {
    db.policy.mockResolvedValue({ adsAutonomy: "SUGGEST" });
    const ok = await AdsAutopilot.tryGuardPause({
      workspaceId: "ws-1",
      projectId: "p-1",
      brandId: "b-1",
      account: account as never,
      level: "CAMPAIGN",
      externalId: "camp-1",
      ruleKey: "G1_RUNAWAY",
      explanation: "x",
      evidence: {},
      dayKey: "2026-10-06",
      now: NOW,
    });
    expect(ok).toBe(false);
    expect(db.decisionCreate).not.toHaveBeenCalled();
  });
});
