import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı (SC-F5 hedef eylemleri): bayrak kapalıyken hiçbir
// yazma yok; geçersiz ölçüt (seo.traffic dahil) ve hedef için sabit mesajlar;
// yüzde 120 reddedilir; geçerli hedef önce upsert sonra yenileme, Google verisi
// taşımayan denetim kaydı ve revalidatePath ile kaydedilir; bilinmeyen hedefi
// arşivlemek "Goal not found."; erişim hatası kimlik sızdırmaz.

const mocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  requireUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  record: vi.fn(),
  upsertSeoGoal: vi.fn(),
  refreshSeoGoals: vi.fn(),
  archiveSeoGoal: vi.fn(),
  listSeoGoals: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/server/security/tenant-context", () => ({
  requireUser: mocks.requireUser,
  requireProjectAccess: mocks.requireProjectAccess,
}));
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: mocks.record },
}));
vi.mock("@/server/seo/reports/goals", () => ({
  upsertSeoGoal: mocks.upsertSeoGoal,
  refreshSeoGoals: mocks.refreshSeoGoals,
  archiveSeoGoal: mocks.archiveSeoGoal,
  listSeoGoals: mocks.listSeoGoals,
}));

const { createSeoGoalAction, archiveSeoGoalAction } = await import(
  "./seo-report-actions"
);
const { AgentelseError } = await import("@/server/security/errors");

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

const createForm = (extra: Record<string, string> = {}) =>
  form({
    projectId: "proj-1",
    metricKey: "gsc.nonBrandClicks",
    target: "1200",
    ...extra,
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("GSC_SYNC", "true");
  vi.stubEnv("SEO_REPORTS", "true");
  vi.stubEnv("GSC_ROLLOUT_PROJECTS", "");
  mocks.requireUser.mockResolvedValue({ userId: "user-1" });
  mocks.requireProjectAccess.mockResolvedValue({
    workspaceId: "ws-1",
    projectId: "proj-1",
    defaultBrandId: "brand-1",
  });
  mocks.upsertSeoGoal.mockResolvedValue({ goalId: "goal-1", created: true });
  mocks.refreshSeoGoals.mockResolvedValue(1);
  mocks.archiveSeoGoal.mockResolvedValue(true);
  mocks.listSeoGoals.mockResolvedValue([
    { goalId: "goal-1", metricKey: "gsc.clicks" },
  ]);
});

describe("createSeoGoalAction", () => {
  it("bayrak kapalıyken yazmaz", async () => {
    vi.stubEnv("SEO_REPORTS", "false");
    const result = await createSeoGoalAction(createForm());
    expect(result).toEqual({ ok: false, message: "SEO reports are turned off." });
    expect(mocks.upsertSeoGoal).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("izin listesi dışındaki projede yazmaz", async () => {
    vi.stubEnv("GSC_ROLLOUT_PROJECTS", "other");
    const result = await createSeoGoalAction(createForm());
    expect(result.ok).toBe(false);
    expect(mocks.upsertSeoGoal).not.toHaveBeenCalled();
  });

  it("tanımsız ölçütü (seo.traffic dahil) reddeder", async () => {
    for (const metricKey of ["seo.traffic", "gsc.", "web.sessions", "nope"]) {
      const result = await createSeoGoalAction(createForm({ metricKey }));
      expect(result).toEqual({ ok: false, message: "Choose a goal." });
    }
    expect(mocks.upsertSeoGoal).not.toHaveBeenCalled();
  });

  it("geçersiz hedefi reddeder", async () => {
    for (const target of ["0", "-5", "abc", "", "NaN", "12.5"]) {
      const result = await createSeoGoalAction(createForm({ target }));
      expect(result.ok).toBe(false);
    }
    const bad = await createSeoGoalAction(createForm({ target: "0" }));
    expect(bad).toEqual({
      ok: false,
      message: "Enter a target above zero (percent goals up to 100).",
    });
    expect(mocks.upsertSeoGoal).not.toHaveBeenCalled();
  });

  it("yüzde 120'yi reddeder, yüzde 90'ı kabul eder", async () => {
    const over = await createSeoGoalAction(
      createForm({ metricKey: "seo.indexedShare", target: "120" }),
    );
    expect(over).toEqual({
      ok: false,
      message: "Enter a target above zero (percent goals up to 100).",
    });
    expect(mocks.upsertSeoGoal).not.toHaveBeenCalled();

    const ok = await createSeoGoalAction(
      createForm({ metricKey: "seo.indexedShare", target: "90" }),
    );
    expect(ok).toEqual({ ok: true });
  });

  it("geçerli hedefi önce yazar, sonra yeniler, denetler ve sayfayı tazeler", async () => {
    const order: string[] = [];
    mocks.upsertSeoGoal.mockImplementation(async () => {
      order.push("upsert");
      return { goalId: "goal-1", created: true };
    });
    mocks.refreshSeoGoals.mockImplementation(async () => {
      order.push("refresh");
      return 1;
    });
    const result = await createSeoGoalAction(createForm());
    expect(result).toEqual({ ok: true });
    expect(order).toEqual(["upsert", "refresh"]);
    expect(mocks.upsertSeoGoal).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      projectId: "proj-1",
      brandId: "brand-1",
      userId: "user-1",
      metricKey: "gsc.nonBrandClicks",
      target: 1200,
    });
    expect(mocks.refreshSeoGoals).toHaveBeenCalledWith("proj-1");
    // denetim kaydı yalnız ölçüt anahtarı ve hedef sayısı taşır
    expect(mocks.record).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      projectId: "proj-1",
      actorType: "USER",
      actorId: "user-1",
      action: "seo_goal.saved",
      entityType: "ProjectGoal",
      entityId: "goal-1",
      metadata: { metricKey: "gsc.nonBrandClicks", target: 1200 },
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/projects/proj-1/arama");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/projects/proj-1");
  });

  it("yenileme başarısız olsa da hedef kaydedilir", async () => {
    mocks.refreshSeoGoals.mockRejectedValue(new Error("boom"));
    const result = await createSeoGoalAction(createForm());
    expect(result).toEqual({ ok: true });
    expect(mocks.record).toHaveBeenCalledTimes(1);
  });

  it("erişim hatasında kimlik sızdırmaz", async () => {
    mocks.requireProjectAccess.mockRejectedValue(
      new AgentelseError("PERMISSION_DENIED", "workspace ws-secret"),
    );
    const result = await createSeoGoalAction(createForm());
    expect(result).toEqual({
      ok: false,
      message: "This project isn't available.",
    });
    expect(mocks.upsertSeoGoal).not.toHaveBeenCalled();
  });

  it("beklenmeyen hatada sabit mesaj verir", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.upsertSeoGoal.mockRejectedValue(new Error("db password leaked"));
    const result = await createSeoGoalAction(createForm());
    expect(result).toEqual({
      ok: false,
      message: "The goal could not be saved.",
    });
  });
});

describe("archiveSeoGoalAction", () => {
  it("bayrak kapalıyken arşivlemez", async () => {
    vi.stubEnv("SEO_REPORTS", "false");
    const result = await archiveSeoGoalAction(
      form({ projectId: "proj-1", goalId: "goal-1" }),
    );
    expect(result).toEqual({ ok: false, message: "SEO reports are turned off." });
    expect(mocks.archiveSeoGoal).not.toHaveBeenCalled();
  });

  it("bilinmeyen hedefte Goal not found. verir ve denetlemez", async () => {
    mocks.archiveSeoGoal.mockResolvedValue(false);
    const result = await archiveSeoGoalAction(
      form({ projectId: "proj-1", goalId: "missing" }),
    );
    expect(result).toEqual({ ok: false, message: "Goal not found." });
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("hedefi arşivler, ölçüt anahtarıyla denetler ve sayfayı tazeler", async () => {
    const result = await archiveSeoGoalAction(
      form({ projectId: "proj-1", goalId: "goal-1" }),
    );
    expect(result).toEqual({ ok: true });
    expect(mocks.archiveSeoGoal).toHaveBeenCalledWith("proj-1", "goal-1");
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "seo_goal.archived",
        entityType: "ProjectGoal",
        entityId: "goal-1",
        metadata: { metricKey: "gsc.clicks" },
      }),
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/projects/proj-1/arama");
  });

  it("goalId yoksa eksik alan mesajı verir", async () => {
    const result = await archiveSeoGoalAction(form({ projectId: "proj-1" }));
    expect(result.ok).toBe(false);
    expect(mocks.archiveSeoGoal).not.toHaveBeenCalled();
  });
});
