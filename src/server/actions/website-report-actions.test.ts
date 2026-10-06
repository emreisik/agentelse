import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WebsiteReportCardData } from "@/lib/website-analytics/reports/types";

// Bu dosyanın kanıtladığı: ayarlar ayrıştırılan değerlerle kaydedilir ve
// denetim kaydı yazılır; bayrak kapalıyken eylem yazmaz; "Use these targets"
// hedefleri yalnız saklı karttaki önerilerden yazar (istemci değerleri yok
// sayılır), tanımsız metricKey elenir, plan olmayan ya da başka projenin
// komutu "Plan not found.", geçmiş ayın planı reddedilir.

const mocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  requireUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  record: vi.fn(),
  saveGaReportSettings: vi.fn(),
  commandFindFirst: vi.fn(),
  getProjectTimezone: vi.fn(),
  primaryGaLink: vi.fn(),
  applyPlanTargets: vi.fn(),
  refreshProject: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/server/security/tenant-context", () => ({
  requireUser: mocks.requireUser,
  requireProjectAccess: mocks.requireProjectAccess,
}));
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: mocks.record },
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { command: { findFirst: mocks.commandFindFirst } },
}));
vi.mock("@/server/chat/content-plan", () => ({
  getProjectTimezone: mocks.getProjectTimezone,
}));
vi.mock("@/server/website-analytics/store", () => ({
  primaryGaLink: mocks.primaryGaLink,
}));
vi.mock("@/server/website-analytics/reports/settings", () => ({
  saveGaReportSettings: mocks.saveGaReportSettings,
}));
vi.mock("@/server/website-analytics/reports/goals", () => ({
  GaGoals: {
    applyPlanTargets: mocks.applyPlanTargets,
    refreshProject: mocks.refreshProject,
  },
}));

const {
  sampleMonthlyCard,
  samplePlanCard,
} = await import("@/lib/website-analytics/reports/test-fixtures");
const { updateGaReportSettingsAction, applyGaPlanTargetsAction } =
  await import("./website-report-actions");

function settingsForm(extra: Record<string, string> = {}): FormData {
  const data = new FormData();
  data.set("projectId", "proj-1");
  data.set("weeklyEnabled", "on");
  data.set("weeklyWeekday", "3");
  data.set("monthlyDay", "5");
  data.set("pulse", "off");
  data.set("alertTelegram", "on");
  for (const [key, value] of Object.entries(extra)) data.set(key, value);
  return data;
}

function planForm(
  metricKeys: string[],
  extra: Record<string, string> = {},
): FormData {
  const data = new FormData();
  data.set("projectId", "proj-1");
  data.set("commandId", "garep_plan_proj-1_2099-01");
  for (const key of metricKeys) data.append("metricKey", key);
  for (const [key, value] of Object.entries(extra)) data.set(key, value);
  return data;
}

function planCard(month: string): WebsiteReportCardData {
  const card = samplePlanCard();
  if (card.body.variant !== "plan") throw new Error("fixture is not a plan");
  return { ...card, body: { ...card.body, month } };
}

function storedPlan(month = "2099-01"): { parsedIntent: unknown } {
  return { parsedIntent: { card: planCard(month) } };
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("GA_REPORTS", "true");
  vi.stubEnv("GA_SYNC", "true");
  vi.stubEnv("NODE_ENV", "production");
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.requireUser.mockResolvedValue({ userId: "user-1" });
  mocks.requireProjectAccess.mockResolvedValue({ workspaceId: "ws-1" });
  mocks.record.mockResolvedValue(undefined);
  mocks.saveGaReportSettings.mockResolvedValue(undefined);
  mocks.getProjectTimezone.mockResolvedValue("UTC");
  mocks.primaryGaLink.mockResolvedValue({ isMock: false });
  mocks.applyPlanTargets.mockResolvedValue({ created: 1, updated: 0 });
  mocks.refreshProject.mockResolvedValue(1);
  mocks.commandFindFirst.mockResolvedValue(storedPlan());
});

describe("updateGaReportSettingsAction", () => {
  it("saves the parsed values, audits and revalidates", async () => {
    expect(await updateGaReportSettingsAction(settingsForm())).toEqual({
      ok: true,
    });
    expect(mocks.requireProjectAccess).toHaveBeenCalledWith("user-1", "proj-1");
    expect(mocks.saveGaReportSettings).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      projectId: "proj-1",
      userId: "user-1",
      value: {
        weeklyEnabled: true,
        weeklyWeekday: 3,
        monthlyEnabled: false,
        monthlyDay: 5,
        pulse: "off",
        alertChat: false,
        alertTelegram: true,
      },
    });
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "website_report_settings.updated",
        projectId: "proj-1",
        actorId: "user-1",
      }),
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/projects/proj-1");
  });

  it("refuses with the flag-off message and writes nothing", async () => {
    vi.stubEnv("GA_REPORTS", "false");
    expect(await updateGaReportSettingsAction(settingsForm())).toEqual({
      ok: false,
      message: "Website reports are off.",
    });
    expect(mocks.saveGaReportSettings).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("returns the parser message for an invalid day", async () => {
    expect(
      await updateGaReportSettingsAction(settingsForm({ monthlyDay: "40" })),
    ).toEqual({ ok: false, message: "Pick a valid day." });
    expect(mocks.saveGaReportSettings).not.toHaveBeenCalled();
  });

  it("does not leak error text from a failed access check", async () => {
    mocks.requireProjectAccess.mockRejectedValue(new Error("secret detail"));
    const result = await updateGaReportSettingsAction(settingsForm());
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("secret detail");
    expect(mocks.saveGaReportSettings).not.toHaveBeenCalled();
  });
});

describe("applyGaPlanTargetsAction", () => {
  it("writes targets from the stored proposals, never from client values", async () => {
    const stored = planCard("2099-01");
    const proposals =
      stored.body.variant === "plan" ? stored.body.proposals : [];
    expect(proposals.length).toBeGreaterThan(0);
    const keys = proposals.map((proposal) => proposal.metricKey);

    const result = await applyGaPlanTargetsAction(
      planForm(keys, {
        suggested: "999999999",
        target: "1",
        proposals: "[]",
      }),
    );

    expect(result).toEqual({ ok: true });
    expect(mocks.commandFindFirst).toHaveBeenCalledWith({
      where: { id: "garep_plan_proj-1_2099-01", projectId: "proj-1" },
      select: { parsedIntent: true },
    });
    const call = mocks.applyPlanTargets.mock.calls[0]?.[0];
    expect(call.proposals).toEqual(proposals);
    expect(call.metricKeys).toEqual(keys);
    expect(call).toMatchObject({
      projectId: "proj-1",
      workspaceId: "ws-1",
      userId: "user-1",
      isMock: false,
    });
    expect(JSON.stringify(call)).not.toContain("999999999");
    expect(mocks.refreshProject).toHaveBeenCalledWith("proj-1");
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "website_goals.applied" }),
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/projects/proj-1");
  });

  it("filters out unknown metric keys", async () => {
    const stored = planCard("2099-01");
    const first =
      stored.body.variant === "plan" ? stored.body.proposals[0] : undefined;
    expect(first).toBeDefined();
    const result = await applyGaPlanTargetsAction(
      planForm([first?.metricKey ?? "", "web.bogus", "ga.sessions"]),
    );
    expect(result).toEqual({ ok: true });
    expect(mocks.applyPlanTargets.mock.calls[0]?.[0].metricKeys).toEqual([
      first?.metricKey,
    ]);
  });

  it("asks for at least one target when nothing valid is selected", async () => {
    expect(await applyGaPlanTargetsAction(planForm(["web.bogus"]))).toEqual({
      ok: false,
      message: "Pick at least one target.",
    });
    expect(await applyGaPlanTargetsAction(planForm([]))).toEqual({
      ok: false,
      message: "Pick at least one target.",
    });
    expect(mocks.applyPlanTargets).not.toHaveBeenCalled();
  });

  it("refuses a command that is not a plan card", async () => {
    mocks.commandFindFirst.mockResolvedValue({
      parsedIntent: { card: sampleMonthlyCard() },
    });
    expect(await applyGaPlanTargetsAction(planForm(["web.sessions"]))).toEqual({
      ok: false,
      message: "Plan not found.",
    });
    expect(mocks.applyPlanTargets).not.toHaveBeenCalled();
  });

  it("refuses a command id from another project", async () => {
    mocks.commandFindFirst.mockResolvedValue(null);
    expect(await applyGaPlanTargetsAction(planForm(["web.sessions"]))).toEqual({
      ok: false,
      message: "Plan not found.",
    });
    expect(mocks.applyPlanTargets).not.toHaveBeenCalled();
  });

  it("refuses a malformed stored card", async () => {
    mocks.commandFindFirst.mockResolvedValue({ parsedIntent: { card: { kind: "website-report" } } });
    expect(await applyGaPlanTargetsAction(planForm(["web.sessions"]))).toEqual({
      ok: false,
      message: "Plan not found.",
    });
  });

  it("refuses a plan for a past month", async () => {
    mocks.commandFindFirst.mockResolvedValue(storedPlan("2000-01"));
    expect(await applyGaPlanTargetsAction(planForm(["web.sessions"]))).toEqual({
      ok: false,
      message: "This plan is for a past month.",
    });
    expect(mocks.applyPlanTargets).not.toHaveBeenCalled();
  });

  it("is off when the flag is off", async () => {
    vi.stubEnv("GA_REPORTS", "");
    expect(await applyGaPlanTargetsAction(planForm(["web.sessions"]))).toEqual({
      ok: false,
      message: "Website reports are off.",
    });
    expect(mocks.commandFindFirst).not.toHaveBeenCalled();
  });

  it("still succeeds when the goal refresh fails", async () => {
    mocks.refreshProject.mockRejectedValue(new Error("boom"));
    const stored = planCard("2099-01");
    const key =
      stored.body.variant === "plan"
        ? stored.body.proposals[0]?.metricKey
        : undefined;
    expect(await applyGaPlanTargetsAction(planForm([key ?? ""]))).toEqual({
      ok: true,
    });
  });
});
