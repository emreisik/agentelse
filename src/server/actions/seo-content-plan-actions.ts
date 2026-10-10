"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { clampCap } from "@/lib/seo/content-plan/cap";
import { EMPTY_COPY } from "@/lib/seo/content-plan/copy";
import { seoContentPlanActiveFor } from "@/lib/seo/content-plan/flags";
import { manualPlanAllowed } from "@/lib/seo/content-plan/schedule";
import { utcToZonedDateTimeLocal } from "@/lib/timezone";
import { budgetMessageForProject } from "@/server/billing/budget-stop";
import { isAgentelseError } from "@/server/security/errors";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import {
  createMonthlyPlan,
  moveSlot,
  regenerateContentPlan,
  skipSlot,
} from "@/server/seo/content-plan/planner";
import {
  currentLocalMonth,
  projectTimezone,
  savePlanSettings,
} from "@/server/seo/content-plan/store";
import { primaryGscLink } from "@/server/seo/store";

// Search sayfasındaki "This month's articles" bölümünün eylemleri (SC-F7,
// docs/search-content-plan.md): Plan this month, Refresh plan, Skip, Replace,
// Move ve aylık sınır / otomatik plan ayarı. Hepsi oturumu ve proje erişimini
// doğrular, SEO_CONTENT_PLAN kapısını yeniden kontrol eder ve planlayıcı
// sonuçlarını sabit İngilizce mesajlara çevirir. Mesajlar Google metni
// taşımaz; hata ayrıntısı istemciye gitmez.

export type ActionResult =
  { ok: true; message?: string } | { ok: false; message: string };

const NOT_ON = "The monthly article plan isn't turned on.";
const INVALID = "Something is missing. Reload the page and try again.";
const SIGN_IN_AGAIN = "Please sign in again.";
const PROJECT_UNAVAILABLE = "This project isn't available.";
const NOT_CONNECTED = "Search Console isn't connected for this project.";
const NO_PLAN = "There is no plan for this month yet.";
const NOT_FOUND = "That article is no longer in the plan.";
const WRITTEN = "That article is already written, so it stays.";
const PICK_LATER = "Pick a day later in this month.";
const REFRESH_LIMIT = "You can refresh the plan up to 3 times.";
const BEHIND =
  "The plan could not use the newest search data yet. Try again later.";
const BUSY = "Another change is in progress. Try again in a moment.";
const NOTHING_TO_REPLACE =
  "Every article in the plan is already in progress, so there is nothing to replace.";
const REFRESH_FAILED = "The plan could not be refreshed. Try again later.";
const PLAN_READY = "This month's plan is ready.";

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const slotIdSchema = z.string().regex(/^s\d{1,3}$/);
const dayPattern = /^(\d{4})-(\d{2})-(\d{2})$/;

type Access = { userId: string; workspaceId: string; projectId: string };
type Gate = { ok: true; access: Access } | { ok: false; message: string };

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}

// Oturum + proje erişimi; bayrak ve izin listesi yalnız ortamdan okunur.
async function gate(formData: FormData): Promise<Gate> {
  const projectId = field(formData, "projectId");
  if (!idSchema.safeParse(projectId).success) {
    return { ok: false, message: INVALID };
  }
  const { userId } = await requireUser();
  const { workspaceId } = await requireProjectAccess(userId, projectId);
  if (!seoContentPlanActiveFor(projectId)) {
    return { ok: false, message: NOT_ON };
  }
  return { ok: true, access: { userId, workspaceId, projectId } };
}

// Hata metni istemciye aynen gitmez: yalnız sabit İngilizce mesaj.
function failure(error: unknown, fallback: string): ActionResult {
  if (isAgentelseError(error)) {
    if (error.code === "LOGIN_REQUIRED" || error.code === "SESSION_EXPIRED") {
      return { ok: false, message: SIGN_IN_AGAIN };
    }
    if (
      error.code === "PERMISSION_DENIED" ||
      error.code === "NOT_FOUND" ||
      error.code === "PROJECT_MISMATCH"
    ) {
      return { ok: false, message: PROJECT_UNAVAILABLE };
    }
  }
  console.error(
    "[seo-content-plan] action failed:",
    error instanceof Error ? error.name : "unknown",
  );
  return { ok: false, message: fallback };
}

function revalidateSearch(projectId: string) {
  revalidatePath(`/projects/${projectId}/arama`);
}

function slotIdOf(formData: FormData): string | null {
  const parsed = slotIdSchema.safeParse(field(formData, "slotId"));
  return parsed.success ? parsed.data : null;
}

// "YYYY-MM-DD" ve gerçek bir takvim günü (2026-02-31 reddedilir).
function dayOf(formData: FormData): string | null {
  const value = field(formData, "date");
  const match = dayPattern.exec(value);
  if (!match) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== Number(match[1]) ||
    date.getUTCMonth() + 1 !== Number(match[2]) ||
    date.getUTCDate() !== Number(match[3])
  ) {
    return null;
  }
  return value;
}

// "Plan this month": elle plan; pencere ayın son günlerine yaklaşmışsa
// planlayıcıya hiç gidilmez.
export async function planThisMonthAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const checked = await gate(formData);
    if (!checked.ok) return checked;
    const { userId, projectId } = checked.access;
    const link = await primaryGscLink(projectId);
    if (!link) return { ok: false, message: NOT_CONNECTED };
    const now = new Date();
    const timezone = await projectTimezone(projectId);
    if (!manualPlanAllowed(utcToZonedDateTimeLocal(now, timezone))) {
      return { ok: false, message: EMPTY_COPY.NO_ROOM };
    }
    const month = await currentLocalMonth(projectId, now);
    const outcome = await createMonthlyPlan({
      link,
      month,
      timezone,
      now,
      trigger: "manual",
      userId,
    });
    revalidateSearch(projectId);
    switch (outcome.status) {
      case "created":
        return { ok: true, message: PLAN_READY };
      case "exists":
        return { ok: true, message: "This month's plan already exists." };
      case "empty":
        return { ok: false, message: EMPTY_COPY[outcome.reason] };
      case "retry":
        if (outcome.reason === "BUDGET") {
          // Daily counter or a used-up plan allowance: the wording differs (budget-stop.ts).
          return {
            ok: false,
            message: await budgetMessageForProject(
              projectId,
              EMPTY_COPY.AI_LIMIT,
            ),
          };
        }
        return {
          ok: false,
          message: outcome.reason === "ENGINE_BEHIND" ? BEHIND : BUSY,
        };
      case "off":
        return { ok: false, message: NOT_ON };
    }
  } catch (error) {
    return failure(error, "The plan could not be created. Try again later.");
  }
}

type RegenerateResult = Awaited<ReturnType<typeof regenerateContentPlan>>;

async function regenerateMessage(
  projectId: string,
  result: RegenerateResult,
): Promise<ActionResult> {
  if (result.ok) {
    return {
      ok: true,
      message:
        result.replaced === 0
          ? "Nothing needed to change."
          : "The plan was refreshed.",
    };
  }
  switch (result.reason) {
    case "off":
      return { ok: false, message: NOT_ON };
    case "no_plan":
      return { ok: false, message: NO_PLAN };
    case "limit":
      return { ok: false, message: REFRESH_LIMIT };
    case "busy":
      return { ok: false, message: BUSY };
    case "nothing_to_replace":
      return { ok: false, message: NOTHING_TO_REPLACE };
    case "budget":
      return {
        ok: false,
        message: await budgetMessageForProject(projectId, EMPTY_COPY.AI_LIMIT),
      };
    case "behind":
      return { ok: false, message: BEHIND };
    case "failed":
      return { ok: false, message: REFRESH_FAILED };
  }
}

// "Refresh plan": açılmamış slotları yeni veriyle yeniden dağıtır (en çok 3).
export async function refreshPlanAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const checked = await gate(formData);
    if (!checked.ok) return checked;
    const { userId, projectId } = checked.access;
    const result = await regenerateContentPlan({
      projectId,
      userId,
      trigger: "manual",
    });
    revalidateSearch(projectId);
    return regenerateMessage(projectId, result);
  } catch (error) {
    return failure(error, REFRESH_FAILED);
  }
}

// "Replace": tek slotu atlar, yerine kalan adaylardan bir yenisini koyar.
export async function replaceSlotAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const checked = await gate(formData);
    if (!checked.ok) return checked;
    const { userId, projectId } = checked.access;
    const slotId = slotIdOf(formData);
    if (!slotId) return { ok: false, message: INVALID };
    const result = await regenerateContentPlan({
      projectId,
      userId,
      slotId,
      trigger: "manual",
    });
    revalidateSearch(projectId);
    if (!result.ok && result.reason === "nothing_to_replace") {
      return { ok: false, message: WRITTEN };
    }
    return regenerateMessage(projectId, result);
  } catch (error) {
    return failure(error, REFRESH_FAILED);
  }
}

// "Skip": slot kalkar, konu önümüzdeki 3 ay planlanmaz.
export async function skipSlotAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const checked = await gate(formData);
    if (!checked.ok) return checked;
    const { userId, projectId } = checked.access;
    const slotId = slotIdOf(formData);
    if (!slotId) return { ok: false, message: INVALID };
    const result = await skipSlot({ projectId, slotId, userId });
    revalidateSearch(projectId);
    if (result.ok) return { ok: true, message: "Skipped" };
    switch (result.reason) {
      case "off":
        return { ok: false, message: NOT_ON };
      case "written":
        return { ok: false, message: WRITTEN };
      case "not_found":
        return { ok: false, message: NOT_FOUND };
    }
  } catch (error) {
    return failure(error, "The article could not be skipped.");
  }
}

// "Move": aynı ay içinde, geçmişe değil.
export async function moveSlotAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const checked = await gate(formData);
    if (!checked.ok) return checked;
    const { userId, projectId } = checked.access;
    const slotId = slotIdOf(formData);
    const date = dayOf(formData);
    if (!slotId || !date) return { ok: false, message: INVALID };
    const result = await moveSlot({ projectId, slotId, date, userId });
    revalidateSearch(projectId);
    if (result.ok) return { ok: true, message: "Moved" };
    switch (result.reason) {
      case "off":
        return { ok: false, message: NOT_ON };
      case "written":
        return { ok: false, message: WRITTEN };
      case "not_found":
        return { ok: false, message: NOT_FOUND };
      case "past":
      case "other_month":
        return { ok: false, message: PICK_LATER };
    }
  } catch (error) {
    return failure(error, "The article could not be moved.");
  }
}

// Aylık sınır (1..12) ve otomatik plan anahtarı. Sınır bozuksa varsayılana
// düşer, aralık dışı değer kenara sıkıştırılır (clampCap).
export async function savePlanSettingsAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const checked = await gate(formData);
    if (!checked.ok) return checked;
    const { userId, workspaceId, projectId } = checked.access;
    const rawAuto = field(formData, "autoPlan");
    await savePlanSettings({
      workspaceId,
      projectId,
      userId,
      monthlyCap: clampCap(field(formData, "monthlyCap")),
      autoPlan: rawAuto === "on" || rawAuto === "true",
    });
    revalidateSearch(projectId);
    return { ok: true, message: "Saved" };
  } catch (error) {
    return failure(error, "The settings could not be saved.");
  }
}
