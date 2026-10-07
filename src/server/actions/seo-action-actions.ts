"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";

import { isRateLimited } from "@/lib/rate-limit";
import { SeoActionFlags, seoActionsAllowedFor } from "@/lib/seo/action-flags";
import { isAgentelseError } from "@/server/security/errors";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import {
  fixFinding,
  trackHealthFix,
  type FixThisResult,
} from "@/server/seo/actions/fix-this";
import { requestCheckNow, transitionAction } from "@/server/seo/actions/store";
import { SeoActionVerifier } from "@/server/seo/actions/verify";

// "Actions & results" bölümünün ve "Fix this" / "I fixed this" düğmelerinin
// eylemleri (SC-F6, docs/search-actions.md "Arayüz"). Hepsi oturumu ve proje
// erişimini doğrular, SEO_ACTIONS + SEO_HEALTH + SEO_CRAWL ve açılış listesi
// dışında hiçbir iş yapmaz, dakikada sınırlıdır ve hiç fırlatmaz. Hata metni
// istemciye aynen gitmez; yalnız sabit İngilizce mesajlar döner. Denetim
// kaydını eylem deposu yazar (Google metni yok).

export type ActionResult =
  { ok: true; message?: string } | { ok: false; message: string };

export type FixOpportunityResult =
  | Extract<FixThisResult, { ok: true }>
  | {
      ok: false;
      message: string;
    };

const NOT_ON = "Tracking changes isn't turned on.";
const NOT_ALLOWED = "Tracking changes isn't set up for this project here.";
const INVALID = "Something is missing. Reload the page and try again.";
const RATE = "Slow down for a moment.";
const SIGN_IN_AGAIN = "Please sign in again.";
const PROJECT_UNAVAILABLE = "This project isn't available.";
const GONE = "This change is no longer tracked.";
const NOT_NOW = "This change can't be updated right now.";
const TOO_SOON = "We checked this a few minutes ago. Try again shortly.";
const CANT_CHECK = "This change can't be checked right now.";

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 10 * 60_000;

type Access = {
  userId: string;
  workspaceId: string;
  brandId: string;
  projectId: string;
};
type Gate = { ok: true; access: Access } | { ok: false; message: string };

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function idOf(value: unknown): string | null {
  return typeof value === "string" && ID_PATTERN.test(value) ? value : null;
}

// Oturum ve proje erişimi; bayraklar ve izin listesi yalnız ortamdan okunur.
async function gate(projectIdInput: unknown): Promise<Gate> {
  const projectId = idOf(projectIdInput);
  if (!projectId) return { ok: false, message: INVALID };
  const { userId } = await requireUser();
  const access = await requireProjectAccess(userId, projectId);
  if (!SeoActionFlags.loop()) return { ok: false, message: NOT_ON };
  if (!seoActionsAllowedFor(projectId)) {
    return { ok: false, message: NOT_ALLOWED };
  }
  if (isRateLimited(`seo-actions:${userId}`, RATE_LIMIT, RATE_WINDOW_MS)) {
    return { ok: false, message: RATE };
  }
  return {
    ok: true,
    access: {
      userId,
      workspaceId: access.workspaceId,
      brandId: access.defaultBrandId,
      projectId,
    },
  };
}

// Hata metni istemciye aynen gitmez: erişim hataları proje ve çalışma alanı
// kimliği, veritabanı hataları iç ayrıntı taşır.
function failure(
  error: unknown,
  fallback: string,
): { ok: false; message: string } {
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
    "[seo-actions] action failed:",
    error instanceof Error ? error.name : "unknown",
  );
  return { ok: false, message: fallback };
}

function revalidate(projectId: string): void {
  try {
    revalidatePath(`/projects/${projectId}/arama`);
  } catch (error) {
    console.error(
      "[seo-actions] revalidate failed:",
      error instanceof Error ? error.message : error,
    );
  }
}

// Yanıttan sonra tek bakış; hata günlüğe düşer, kullanıcıya yansımaz.
function verifyLater(actionId: string): void {
  try {
    after(async () => {
      try {
        await SeoActionVerifier.runAction(actionId);
      } catch (error) {
        console.error(
          "[seo-actions] verification failed:",
          error instanceof Error ? error.message : error,
        );
      }
    });
  } catch (error) {
    console.error(
      "[seo-actions] verification could not be scheduled:",
      error instanceof Error ? error.message : error,
    );
  }
}

// "Fix this": istemci doğrudan çağırır (form değil); sonuçtaki href'e gider.
export async function fixOpportunity(
  projectId: string,
  findingId: string,
): Promise<FixOpportunityResult> {
  try {
    const entry = await gate(projectId);
    if (!entry.ok) return entry;
    const id = idOf(findingId);
    if (!id) return { ok: false, message: INVALID };
    const { access } = entry;
    const result = await fixFinding({
      projectId: access.projectId,
      findingId: id,
      userId: access.userId,
      workspaceId: access.workspaceId,
      brandId: access.brandId,
    });
    if (!result.ok) return result;
    revalidate(access.projectId);
    return result;
  } catch (error) {
    return failure(error, "We couldn't start this fix. Try again.");
  }
}

type TransitionEvent = "APPLY" | "UNDO_APPLY" | "DISMISS" | "CONFIRM_LIVE";

const TRANSITION_MESSAGE: Readonly<Record<TransitionEvent, string>> = {
  APPLY: "Marked as done. We'll check your site.",
  UNDO_APPLY: "Moved back to your to-do list",
  DISMISS: "Dismissed",
  CONFIRM_LIVE: "Thanks. We'll start measuring.",
};

async function transition(
  formData: FormData,
  event: TransitionEvent,
): Promise<ActionResult> {
  try {
    const entry = await gate(field(formData, "projectId"));
    if (!entry.ok) return entry;
    const actionId = idOf(field(formData, "actionId"));
    if (!actionId) return { ok: false, message: INVALID };
    const { access } = entry;
    const result = await transitionAction({
      projectId: access.projectId,
      actionId,
      event,
      userId: access.userId,
    });
    if (!result.ok) {
      return {
        ok: false,
        message: result.reason === "not_found" ? GONE : NOT_NOW,
      };
    }
    if (event === "APPLY") verifyLater(actionId);
    revalidate(access.projectId);
    return { ok: true, message: TRANSITION_MESSAGE[event] };
  } catch (error) {
    return failure(error, "The change could not be updated");
  }
}

// "Mark as done": kullanıcı değişikliği yaptı; doğrulama hemen bir kez bakar.
export async function markActionAppliedAction(
  formData: FormData,
): Promise<ActionResult> {
  return transition(formData, "APPLY");
}

// "Not done yet": yanlış işaretlenen eylem yapılacaklara döner.
export async function undoActionAppliedAction(
  formData: FormData,
): Promise<ActionResult> {
  return transition(formData, "UNDO_APPLY");
}

export async function dismissActionAction(
  formData: FormData,
): Promise<ActionResult> {
  return transition(formData, "DISMISS");
}

// "It's live": tarayıcımız doğrulayamıyorsa kullanıcının beyanıyla ölçüm başlar.
export async function confirmActionLiveAction(
  formData: FormData,
): Promise<ActionResult> {
  return transition(formData, "CONFIRM_LIVE");
}

// "Check now": sıradaki doğrulama bakışı öne çekilir ve hemen bir kez koşar.
export async function checkActionNowAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const entry = await gate(field(formData, "projectId"));
    if (!entry.ok) return entry;
    const actionId = idOf(field(formData, "actionId"));
    if (!actionId) return { ok: false, message: INVALID };
    const { access } = entry;
    const queued = await requestCheckNow(access.projectId, actionId);
    if (queued === "too_soon") return { ok: false, message: TOO_SOON };
    if (queued === "not_found") return { ok: false, message: CANT_CHECK };
    verifyLater(actionId);
    revalidate(access.projectId);
    return { ok: true, message: "Checking your site now" };
  } catch (error) {
    return failure(error, "The check could not be started");
  }
}

// Sağlık sorununda "I fixed this": eylem APPLIED doğar ve bir kez bakılır.
export async function trackHealthFixAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const entry = await gate(field(formData, "projectId"));
    if (!entry.ok) return entry;
    const alertId = idOf(field(formData, "alertId"));
    if (!alertId) return { ok: false, message: INVALID };
    const { access } = entry;
    const result = await trackHealthFix({
      projectId: access.projectId,
      alertId,
      userId: access.userId,
      workspaceId: access.workspaceId,
    });
    if (!result.ok) return result;
    verifyLater(result.actionId);
    revalidate(access.projectId);
    return { ok: true, message: "Thanks. We'll check your site." };
  } catch (error) {
    return failure(error, "The issue could not be tracked");
  }
}
