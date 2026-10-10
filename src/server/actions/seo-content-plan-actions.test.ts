import { beforeEach, describe, expect, it, vi } from "vitest";

import { EMPTY_COPY } from "@/lib/seo/content-plan/copy";

// Bu dosyanın kanıtladığı (SC-F7 arayüz eylemleri): oturumsuz ve başka
// projeye erişimsiz istek reddedilir; bayrak kapalıyken planlayıcıya hiç
// gidilmez; her planlayıcı sonucu sabit İngilizce mesaja çevrilir; ayar
// kaydı 0 / 13 / bozuk değeri sıkıştırır; Move bozuk tarihi reddeder.

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  revalidatePath: vi.fn(),
  primaryGscLink: vi.fn(),
  projectTimezone: vi.fn(),
  createMonthlyPlan: vi.fn(),
  regenerateContentPlan: vi.fn(),
  skipSlot: vi.fn(),
  moveSlot: vi.fn(),
  currentLocalMonth: vi.fn(),
  savePlanSettings: vi.fn(),
  // billing/budget-stop.ts: the daily-counter sentence unless the PLAN is what ran out.
  budgetMessage: vi.fn(async (_projectId: string, daily: string) => daily),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/server/security/tenant-context", () => ({
  requireUser: mocks.requireUser,
  requireProjectAccess: mocks.requireProjectAccess,
}));
vi.mock("@/server/billing/budget-stop", () => ({
  budgetMessageForProject: mocks.budgetMessage,
}));
vi.mock("@/server/seo/store", () => ({ primaryGscLink: mocks.primaryGscLink }));
vi.mock("@/server/seo/content-plan/planner", () => ({
  createMonthlyPlan: mocks.createMonthlyPlan,
  regenerateContentPlan: mocks.regenerateContentPlan,
  skipSlot: mocks.skipSlot,
  moveSlot: mocks.moveSlot,
}));
vi.mock("@/server/seo/content-plan/store", () => ({
  currentLocalMonth: mocks.currentLocalMonth,
  projectTimezone: mocks.projectTimezone,
  savePlanSettings: mocks.savePlanSettings,
}));

const actions = await import("./seo-content-plan-actions");
const { AgentelseError } = await import("@/server/security/errors");

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const BASE = { projectId: "p1" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.stubEnv("SEO_CONTENT_PLAN", "true");
  vi.stubEnv("GSC_SYNC", "true");
  vi.stubEnv("SEO_INSIGHTS", "on");
  vi.stubEnv("GSC_SEARCH_PAGE", "true");
  vi.stubEnv("GSC_ROLLOUT_PROJECTS", "");
  mocks.requireUser.mockResolvedValue({ userId: "u1" });
  mocks.requireProjectAccess.mockResolvedValue({
    workspaceId: "w1",
    projectId: "p1",
    defaultBrandId: "b1",
  });
  mocks.primaryGscLink.mockResolvedValue({ id: "link1" });
  mocks.projectTimezone.mockResolvedValue("UTC");
  mocks.currentLocalMonth.mockResolvedValue("2026-10");
  mocks.savePlanSettings.mockResolvedValue(undefined);
});

describe("kapılar", () => {
  it("oturum yoksa istek reddedilir ve planlayıcıya gidilmez", async () => {
    mocks.requireUser.mockRejectedValue(
      new AgentelseError("LOGIN_REQUIRED", "no session"),
    );
    const result = await actions.refreshPlanAction(form(BASE));
    expect(result).toEqual({ ok: false, message: "Please sign in again." });
    expect(mocks.regenerateContentPlan).not.toHaveBeenCalled();
  });

  it("başka projeye erişim yoksa sabit mesaj döner (kimlik sızmaz)", async () => {
    mocks.requireProjectAccess.mockRejectedValue(
      new AgentelseError("PROJECT_MISMATCH", "project p1 not in workspace"),
    );
    const result = await actions.skipSlotAction(form({ ...BASE, slotId: "s1" }));
    expect(result).toEqual({
      ok: false,
      message: "This project isn't available.",
    });
    expect(mocks.skipSlot).not.toHaveBeenCalled();
  });

  it("bayrak kapalıyken hata verir ve planlayıcıyı çağırmaz", async () => {
    vi.stubEnv("SEO_CONTENT_PLAN", "false");
    const results = [
      await actions.planThisMonthAction(form(BASE)),
      await actions.refreshPlanAction(form(BASE)),
      await actions.skipSlotAction(form({ ...BASE, slotId: "s1" })),
      await actions.replaceSlotAction(form({ ...BASE, slotId: "s1" })),
      await actions.moveSlotAction(
        form({ ...BASE, slotId: "s1", date: "2026-10-20" }),
      ),
      await actions.savePlanSettingsAction(form({ ...BASE, monthlyCap: "4" })),
    ];
    for (const result of results) expect(result.ok).toBe(false);
    expect(mocks.createMonthlyPlan).not.toHaveBeenCalled();
    expect(mocks.regenerateContentPlan).not.toHaveBeenCalled();
    expect(mocks.skipSlot).not.toHaveBeenCalled();
    expect(mocks.moveSlot).not.toHaveBeenCalled();
    expect(mocks.savePlanSettings).not.toHaveBeenCalled();
  });

  it("izin listesi dışındaki projede de reddeder", async () => {
    vi.stubEnv("GSC_ROLLOUT_PROJECTS", "other");
    const result = await actions.refreshPlanAction(form(BASE));
    expect(result.ok).toBe(false);
    expect(mocks.regenerateContentPlan).not.toHaveBeenCalled();
  });

  it("bozuk proje kimliğini reddeder", async () => {
    const result = await actions.refreshPlanAction(form({ projectId: "a b" }));
    expect(result.ok).toBe(false);
    expect(mocks.requireUser).not.toHaveBeenCalled();
  });
});

describe("planThisMonthAction", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-07T10:00:00.000Z"));
  });

  it("oluşturulan planı sabit mesajla bildirir ve sayfayı tazeler", async () => {
    mocks.createMonthlyPlan.mockResolvedValue({
      status: "created",
      planId: "x",
      slots: 3,
    });
    const result = await actions.planThisMonthAction(form(BASE));
    expect(result).toEqual({ ok: true, message: "This month's plan is ready." });
    expect(mocks.createMonthlyPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        month: "2026-10",
        timezone: "UTC",
        trigger: "manual",
        userId: "u1",
      }),
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/projects/p1/arama");
  });

  it("boş sonucu nedenin sabit metniyle döndürür", async () => {
    mocks.createMonthlyPlan.mockResolvedValue({
      status: "empty",
      reason: "NO_GAPS",
    });
    const result = await actions.planThisMonthAction(form(BASE));
    expect(result).toEqual({ ok: false, message: EMPTY_COPY.NO_GAPS });
  });

  it("yeniden deneme sonuçlarını eşler (behind, bütçe, meşgul)", async () => {
    mocks.createMonthlyPlan.mockResolvedValueOnce({
      status: "retry",
      reason: "ENGINE_BEHIND",
    });
    expect(await actions.planThisMonthAction(form(BASE))).toEqual({
      ok: false,
      message:
        "The plan could not use the newest search data yet. Try again later.",
    });
    mocks.createMonthlyPlan.mockResolvedValueOnce({
      status: "retry",
      reason: "BUDGET",
    });
    expect(await actions.planThisMonthAction(form(BASE))).toEqual({
      ok: false,
      message: EMPTY_COPY.AI_LIMIT,
    });
    mocks.createMonthlyPlan.mockResolvedValueOnce({
      status: "retry",
      reason: "BUSY",
    });
    const busy = await actions.planThisMonthAction(form(BASE));
    expect(busy.ok).toBe(false);
  });

  it("yapay zekâ sınırı: günlük sayaç ise günlük cümle, plan hakkı bittiyse planın cümlesi (planla ve yenile)", async () => {
    const PLAN = "Your plan's AI usage for this period is used up.";
    mocks.budgetMessage.mockResolvedValue(PLAN);
    mocks.createMonthlyPlan.mockResolvedValueOnce({
      status: "retry",
      reason: "BUDGET",
    });
    expect(await actions.planThisMonthAction(form(BASE))).toEqual({
      ok: false,
      message: PLAN,
    });
    mocks.regenerateContentPlan.mockResolvedValueOnce({
      ok: false,
      reason: "budget",
    });
    expect(await actions.refreshPlanAction(form(BASE))).toEqual({
      ok: false,
      message: PLAN,
    });
    // The surface's own sentence is what the helper is given to fall back on.
    expect(mocks.budgetMessage).toHaveBeenCalledWith("p1", EMPTY_COPY.AI_LIMIT);
    expect(mocks.budgetMessage).toHaveBeenCalledTimes(2);
    mocks.budgetMessage.mockImplementation(async (_projectId, daily) => daily);
  });

  it("bağlı Search Console yoksa planlayıcıya gitmez", async () => {
    mocks.primaryGscLink.mockResolvedValue(null);
    const result = await actions.planThisMonthAction(form(BASE));
    expect(result.ok).toBe(false);
    expect(mocks.createMonthlyPlan).not.toHaveBeenCalled();
  });

  it("ayın son günlerinde elle planı reddeder", async () => {
    vi.setSystemTime(new Date("2026-10-30T10:00:00.000Z"));
    const result = await actions.planThisMonthAction(form(BASE));
    expect(result).toEqual({ ok: false, message: EMPTY_COPY.NO_ROOM });
    expect(mocks.createMonthlyPlan).not.toHaveBeenCalled();
  });
});

describe("refresh, replace, skip", () => {
  it("refresh sınır dolunca sabit mesaj verir", async () => {
    mocks.regenerateContentPlan.mockResolvedValue({ ok: false, reason: "limit" });
    expect(await actions.refreshPlanAction(form(BASE))).toEqual({
      ok: false,
      message: "You can refresh the plan up to 3 times.",
    });
  });

  it("refresh behind sonucunu sabit mesaja çevirir", async () => {
    mocks.regenerateContentPlan.mockResolvedValue({
      ok: false,
      reason: "behind",
    });
    expect(await actions.refreshPlanAction(form(BASE))).toEqual({
      ok: false,
      message:
        "The plan could not use the newest search data yet. Try again later.",
    });
  });

  it("refresh başarısında yalnız kullanıcıyı ve projeyi geçirir", async () => {
    mocks.regenerateContentPlan.mockResolvedValue({
      ok: true,
      replaced: 2,
      kept: 1,
    });
    const result = await actions.refreshPlanAction(form(BASE));
    expect(result.ok).toBe(true);
    expect(mocks.regenerateContentPlan).toHaveBeenCalledWith({
      projectId: "p1",
      userId: "u1",
      trigger: "manual",
    });
  });

  it("replace slot kimliğiyle çağrılır; bozuk kimlik reddedilir", async () => {
    mocks.regenerateContentPlan.mockResolvedValue({
      ok: true,
      replaced: 1,
      kept: 3,
    });
    const ok = await actions.replaceSlotAction(form({ ...BASE, slotId: "s2" }));
    expect(ok.ok).toBe(true);
    expect(mocks.regenerateContentPlan).toHaveBeenCalledWith(
      expect.objectContaining({ slotId: "s2" }),
    );
    mocks.regenerateContentPlan.mockClear();
    const bad = await actions.replaceSlotAction(
      form({ ...BASE, slotId: "../x" }),
    );
    expect(bad.ok).toBe(false);
    expect(mocks.regenerateContentPlan).not.toHaveBeenCalled();
  });

  it("skip yazılmış makaleyi sabit mesajla korur", async () => {
    mocks.skipSlot.mockResolvedValue({ ok: false, reason: "written" });
    expect(
      await actions.skipSlotAction(form({ ...BASE, slotId: "s1" })),
    ).toEqual({
      ok: false,
      message: "That article is already written, so it stays.",
    });
  });

  it("skip başarıyı bildirir", async () => {
    mocks.skipSlot.mockResolvedValue({ ok: true });
    const result = await actions.skipSlotAction(form({ ...BASE, slotId: "s1" }));
    expect(result.ok).toBe(true);
    expect(mocks.skipSlot).toHaveBeenCalledWith({
      projectId: "p1",
      slotId: "s1",
      userId: "u1",
    });
  });
});

describe("moveSlotAction", () => {
  it.each(["", "2026-13-01", "2026-02-31", "20261020", "tomorrow", "2026-10-2"])(
    "bozuk tarihi (%s) reddeder",
    async (date) => {
      const result = await actions.moveSlotAction(
        form({ ...BASE, slotId: "s1", date }),
      );
      expect(result).toEqual({
        ok: false,
        message: "Something is missing. Reload the page and try again.",
      });
      expect(mocks.moveSlot).not.toHaveBeenCalled();
    },
  );

  it("geçmiş ve başka ay için aynı sabit mesajı verir", async () => {
    mocks.moveSlot.mockResolvedValueOnce({ ok: false, reason: "past" });
    mocks.moveSlot.mockResolvedValueOnce({ ok: false, reason: "other_month" });
    const input = form({ ...BASE, slotId: "s1", date: "2026-10-20" });
    const past = await actions.moveSlotAction(input);
    const other = await actions.moveSlotAction(input);
    expect(past).toEqual({
      ok: false,
      message: "Pick a day later in this month.",
    });
    expect(other).toEqual(past);
  });

  it("geçerli tarihi planlayıcıya aktarır", async () => {
    mocks.moveSlot.mockResolvedValue({ ok: true });
    const result = await actions.moveSlotAction(
      form({ ...BASE, slotId: "s3", date: "2026-10-20" }),
    );
    expect(result.ok).toBe(true);
    expect(mocks.moveSlot).toHaveBeenCalledWith({
      projectId: "p1",
      slotId: "s3",
      date: "2026-10-20",
      userId: "u1",
    });
  });
});

describe("savePlanSettingsAction", () => {
  async function save(fields: Record<string, string>) {
    mocks.savePlanSettings.mockClear();
    await actions.savePlanSettingsAction(form({ ...BASE, ...fields }));
    return mocks.savePlanSettings.mock.calls[0]?.[0] as
      | { monthlyCap: number; autoPlan: boolean; workspaceId: string }
      | undefined;
  }

  it("sınırı 1..12 aralığına sıkıştırır, bozuk değeri varsayılana düşürür", async () => {
    expect((await save({ monthlyCap: "0" }))?.monthlyCap).toBe(1);
    expect((await save({ monthlyCap: "13" }))?.monthlyCap).toBe(12);
    expect((await save({ monthlyCap: "-5" }))?.monthlyCap).toBe(1);
    expect((await save({ monthlyCap: "garbage" }))?.monthlyCap).toBe(4);
    expect((await save({ monthlyCap: "6" }))?.monthlyCap).toBe(6);
  });

  it("otomatik plan anahtarını okur", async () => {
    expect((await save({ monthlyCap: "4", autoPlan: "true" }))?.autoPlan).toBe(
      true,
    );
    expect((await save({ monthlyCap: "4", autoPlan: "false" }))?.autoPlan).toBe(
      false,
    );
    expect((await save({ monthlyCap: "4" }))?.autoPlan).toBe(false);
  });

  it("çalışma alanını erişim denetiminden alır", async () => {
    expect((await save({ monthlyCap: "4" }))?.workspaceId).toBe("w1");
  });
});
