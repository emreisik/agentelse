"use server";

import { revalidatePath } from "next/cache";

import { isRateLimited } from "@/lib/rate-limit";
import { SEO_CHANGE_ERROR_MESSAGES } from "@/lib/seo/apply/copy";
import { seoApplyEnabledFor } from "@/lib/seo/apply/flags";
import {
  connectWordPress,
  disconnectWordPress,
  testWordPress,
} from "@/server/integrations/wordpress/connect";
import { isAgentelseError } from "@/server/security/errors";
import {
  isWorkspaceManager,
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";

// WordPress bağlantısının eylemleri (SC-F8): bağla, sına / yeniden denetle,
// kopar. Bağlamak ve koparmak yalnız OWNER/ADMIN'e açıktır (siteye yazma
// yetkisi veren bir şifre); sınamak her üyeye açıktır, "Re-check the site"
// (rebind) yalnız yöneticilerde dikkate alınır. Hiç fırlatmaz.

export type ActionResult = { ok: true } | { ok: false; message: string };

const MANAGERS_ONLY = "Only a workspace owner or admin can do this.";
const SIGN_IN_AGAIN = "Please sign in again.";
const PROJECT_UNAVAILABLE = "This project isn't available.";
const TOO_MANY = "Too many attempts. Try again in a few minutes.";
const TEN_MINUTES_MS = 10 * 60_000;

// Hata metni istemciye aynen gitmez: erişim hataları proje ve çalışma alanı
// kimliği, veritabanı hataları iç ayrıntı taşır.
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
    "[wordpress] action failed:",
    error instanceof Error ? error.name : "unknown",
  );
  return { ok: false, message: fallback };
}

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

function revalidate(projectId: string) {
  revalidatePath(`/projects/${projectId}/integrations`);
  revalidatePath(`/projects/${projectId}/arama`);
}

export async function connectWordPressAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = field(formData, "projectId");
    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);
    if (!(await isWorkspaceManager(userId, access.workspaceId))) {
      return { ok: false, message: MANAGERS_ONLY };
    }
    if (!seoApplyEnabledFor(projectId)) {
      return { ok: false, message: SEO_CHANGE_ERROR_MESSAGES.not_enabled };
    }
    // Şifre denemesi sınırlı: kaba kuvvetle WordPress şifresi aranamasın.
    if (isRateLimited(`wordpress-connect:${userId}:${projectId}`, 8, TEN_MINUTES_MS)) {
      return { ok: false, message: TOO_MANY };
    }
    const result = await connectWordPress({
      projectId,
      workspaceId: access.workspaceId,
      brandId: access.defaultBrandId,
      userId,
      siteUrl: field(formData, "siteUrl"),
      username: field(formData, "username"),
      appPassword: field(formData, "appPassword"),
    });
    if (!result.ok) return { ok: false, message: result.message };
    revalidate(projectId);
    return { ok: true };
  } catch (error) {
    return failure(error, "WordPress could not be connected");
  }
}

export async function testWordPressAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = field(formData, "projectId");
    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);
    // Bayrak kapalıyken ya da izin listesi dışında müşteri sitesine istek atılmaz.
    if (!seoApplyEnabledFor(projectId)) {
      return { ok: false, message: SEO_CHANGE_ERROR_MESSAGES.not_enabled };
    }
    if (isRateLimited(`wordpress-test:${userId}:${projectId}`, 20, TEN_MINUTES_MS)) {
      return { ok: false, message: TOO_MANY };
    }
    const manager = await isWorkspaceManager(userId, access.workspaceId);
    const result = await testWordPress(projectId, {
      userId,
      isManager: manager,
      // Yeniden bağlama yalnız yöneticide dikkate alınır.
      rebind: manager && field(formData, "rebind") === "1",
    });
    revalidate(projectId);
    if (!result.ok) return { ok: false, message: result.message };
    return { ok: true };
  } catch (error) {
    return failure(error, "WordPress could not be checked");
  }
}

export async function disconnectWordPressAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = field(formData, "projectId");
    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);
    if (!(await isWorkspaceManager(userId, access.workspaceId))) {
      return { ok: false, message: MANAGERS_ONLY };
    }
    const result = await disconnectWordPress({
      projectId,
      workspaceId: access.workspaceId,
      userId,
    });
    if (!result.ok) return { ok: false, message: result.message };
    revalidate(projectId);
    return { ok: true };
  } catch (error) {
    return failure(error, "WordPress could not be disconnected");
  }
}
