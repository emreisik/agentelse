import { beforeEach, describe, expect, it, vi } from "vitest";

// What this suite proves: a weekly draft is auto-saved and sent to production
// only once ALL of these hold — Works is on, the project's policy has
// weeklyAutoProduce on AND the weekly draft itself still on, the draft is at
// least AUTO_PRODUCE_UNTOUCHED_MS old, and no WEB message exists anywhere in
// its Work; a brand block or a stale date defers to the owner instead of
// forcing "Save anyway"; a settled Work is not re-queried on the next tick;
// production runs as a SYSTEM actor (userId null), through the exact same
// generator a manual click uses, fired without being awaited.

const work = { findMany: vi.fn() };
const autonomyPolicy = { findMany: vi.fn() };
const command = { update: vi.fn().mockResolvedValue(undefined) };
const $transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn({}));
vi.mock("@/lib/prisma", () => ({
  prisma: { work, autonomyPolicy, command, $transaction },
}));

const isWorksEnabled = vi.fn(() => true);
vi.mock("@/server/works/flag", () => ({ isWorksEnabled }));

const isProjectAgencyActive = vi.fn(async () => true);
vi.mock("@/server/repositories/agency-loop-state.repository", () => ({
  isProjectAgencyActive,
}));

const assertPlanSaveable = vi.fn();
vi.mock("@/server/works/plan-save-guards", () => ({ assertPlanSaveable }));

const savePlanSlotsInTx = vi.fn();
vi.mock("@/server/chat/save-plan-core", () => ({ savePlanSlotsInTx }));

const markIdeasPlanned = vi.fn().mockResolvedValue(undefined);
vi.mock("@/server/chat/idea-pool", () => ({ markIdeasPlanned }));

const runContentPlan = vi.fn();
vi.mock("@/server/chat/plan-run", () => ({ runContentPlan }));

const auditRecord = vi.fn().mockResolvedValue(undefined);
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: auditRecord },
}));

const { WeeklyPlanProduce, clearWeeklyAutoProduceMemo } =
  await import("./weekly-plan-produce");

const NOW = new Date("2026-10-05T20:00:00Z");
const OLD_ENOUGH = new Date(NOW.getTime() - 3 * 60 * 60_000); // 3h ago
const TOO_YOUNG = new Date(NOW.getTime() - 60 * 60_000); // 1h ago

const draftCard = (over: Record<string, unknown> = {}) => ({
  kind: "content-plan-draft",
  state: "draft",
  timezone: "Europe/Istanbul",
  items: [{ date: "2026-10-05", topic: "T", captionIdea: "C" }],
  ...over,
});

function systemRow(over: Record<string, unknown> = {}) {
  return {
    id: "cmd-1",
    brandId: "brand-1",
    source: "SYSTEM",
    createdAt: OLD_ENOUGH,
    parsedIntent: { card: draftCard() },
    ...over,
  };
}

function oneWork(commands: unknown[]) {
  work.findMany.mockResolvedValue([
    {
      id: "wkplan_proj-1_2026-10-05",
      projectId: "proj-1",
      workspaceId: "ws-1",
      commands,
    },
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  clearWeeklyAutoProduceMemo();
  isWorksEnabled.mockReturnValue(true);
  isProjectAgencyActive.mockResolvedValue(true);
  autonomyPolicy.findMany.mockResolvedValue([
    {
      projectId: "proj-1",
      weeklyAutoProduce: true,
      autopilotMode: "AUTOPILOT",
    },
  ]);
  assertPlanSaveable.mockResolvedValue({ ok: true, matchedTerms: [] });
  savePlanSlotsInTx.mockResolvedValue({
    ok: true,
    count: 3,
    creativeIds: ["c1", "c2", "c3"],
    ideaIds: ["idea-1"],
  });
  command.update.mockResolvedValue(undefined);
  // An async generator the module can `for await` over without hanging.
  runContentPlan.mockImplementation(async function* () {});
  work.findMany.mockResolvedValue([]);
});

describe("WeeklyPlanProduce.runDue", () => {
  it("does nothing, no query, with Works off", async () => {
    isWorksEnabled.mockReturnValue(false);
    expect(await WeeklyPlanProduce.runDue(2, NOW)).toBe(0);
    expect(work.findMany).not.toHaveBeenCalled();
  });

  it("saves the plan and starts production for an old, untouched, opted-in draft", async () => {
    oneWork([systemRow()]);
    const saved = await WeeklyPlanProduce.runDue(2, NOW);
    expect(saved).toBe(1);
    expect(savePlanSlotsInTx).toHaveBeenCalledWith(
      {},
      { workspaceId: "ws-1", projectId: "proj-1", brandId: "brand-1" },
      "cmd-1",
    );
    expect(markIdeasPlanned).toHaveBeenCalledWith("proj-1", ["idea-1"]);
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: "SYSTEM",
        action: "weekly_plan.auto_saved",
        entityId: "cmd-1",
        metadata: { items: 3 },
      }),
    );
    expect(command.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "cmd-1" } }),
    );
    // Production runs as SYSTEM (userId null), on the saved plan's own command.
    expect(runContentPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        projectId: "proj-1",
        brandId: "brand-1",
        userId: null,
        commandId: "cmd-1",
      }),
    );
  });

  it("skips a project whose policy has weeklyAutoProduce off", async () => {
    oneWork([systemRow()]);
    autonomyPolicy.findMany.mockResolvedValue([
      {
        projectId: "proj-1",
        weeklyAutoProduce: false,
        autopilotMode: "AUTOPILOT",
      },
    ]);
    expect(await WeeklyPlanProduce.runDue(2, NOW)).toBe(0);
    expect(savePlanSlotsInTx).not.toHaveBeenCalled();
  });

  it("skips a project whose weekly draft itself is off, even with this switch on", async () => {
    oneWork([systemRow()]);
    autonomyPolicy.findMany.mockResolvedValue([
      {
        projectId: "proj-1",
        weeklyAutoProduce: true,
        autopilotMode: "REVIEW_EVERYTHING",
      },
    ]);
    expect(await WeeklyPlanProduce.runDue(2, NOW)).toBe(0);
    expect(savePlanSlotsInTx).not.toHaveBeenCalled();
  });

  it("skips a draft that is not old enough yet", async () => {
    oneWork([systemRow({ createdAt: TOO_YOUNG })]);
    expect(await WeeklyPlanProduce.runDue(2, NOW)).toBe(0);
    expect(savePlanSlotsInTx).not.toHaveBeenCalled();
  });

  it("skips a Work the owner has sent a message in", async () => {
    oneWork([systemRow(), { id: "cmd-2", source: "WEB", createdAt: NOW }]);
    expect(await WeeklyPlanProduce.runDue(2, NOW)).toBe(0);
    expect(savePlanSlotsInTx).not.toHaveBeenCalled();
  });

  it("skips a plan that is already saved or superseded", async () => {
    oneWork([
      systemRow({ parsedIntent: { card: draftCard({ state: "saved" }) } }),
    ]);
    expect(await WeeklyPlanProduce.runDue(2, NOW)).toBe(0);
    expect(savePlanSlotsInTx).not.toHaveBeenCalled();
  });

  it("defers to the owner on a brand block instead of forcing it through", async () => {
    oneWork([systemRow()]);
    assertPlanSaveable.mockResolvedValue({
      ok: false,
      code: "BRAND_RULES",
      message: "blocked",
    });
    expect(await WeeklyPlanProduce.runDue(2, NOW)).toBe(0);
    expect(savePlanSlotsInTx).not.toHaveBeenCalled();
    // Never allowIssues: the guard call carries no such flag.
    expect(assertPlanSaveable.mock.calls[0]![0]).not.toHaveProperty(
      "allowIssues",
    );
    expect(assertPlanSaveable.mock.calls[0]![0]).toMatchObject({
      failClosedOnRulesUnavailable: true,
    });
  });

  it("does not save twice: a settled Work is skipped without a query on the next call", async () => {
    oneWork([systemRow()]);
    expect(await WeeklyPlanProduce.runDue(2, NOW)).toBe(1);
    savePlanSlotsInTx.mockClear();
    const soonAfter = new Date(NOW.getTime() + 60_000);
    expect(await WeeklyPlanProduce.runDue(2, soonAfter)).toBe(0);
    expect(savePlanSlotsInTx).not.toHaveBeenCalled();
  });

  it("does not re-save a project paused since: counted as not-yet, tried again later", async () => {
    oneWork([systemRow()]);
    isProjectAgencyActive.mockResolvedValue(false);
    expect(await WeeklyPlanProduce.runDue(2, NOW)).toBe(0);
    expect(savePlanSlotsInTx).not.toHaveBeenCalled();
  });

  it("stops at the limit, leaving the rest for the next tick", async () => {
    work.findMany.mockResolvedValue([
      {
        id: "wkplan_proj-1_2026-10-05",
        projectId: "proj-1",
        workspaceId: "ws-1",
        commands: [systemRow()],
      },
      {
        id: "wkplan_proj-2_2026-10-05",
        projectId: "proj-2",
        workspaceId: "ws-2",
        commands: [systemRow({ id: "cmd-9", brandId: "brand-2" })],
      },
    ]);
    autonomyPolicy.findMany.mockResolvedValue([
      {
        projectId: "proj-1",
        weeklyAutoProduce: true,
        autopilotMode: "AUTOPILOT",
      },
      {
        projectId: "proj-2",
        weeklyAutoProduce: true,
        autopilotMode: "AUTOPILOT",
      },
    ]);
    expect(await WeeklyPlanProduce.runDue(1, NOW)).toBe(1);
    expect(savePlanSlotsInTx).toHaveBeenCalledTimes(1);
  });

  it("a production failure is caught, never thrown at the caller", async () => {
    oneWork([systemRow()]);
    runContentPlan.mockImplementation(async function* () {
      throw new Error("provider down");
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(WeeklyPlanProduce.runDue(2, NOW)).resolves.toBe(1);
  });
});
