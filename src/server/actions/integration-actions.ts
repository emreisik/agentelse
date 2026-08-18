"use server";

import { revalidatePath } from "next/cache";
import type { BrowserProfilePurpose } from "@prisma/client";

import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { BrowserProfileRepository } from "@/server/repositories/browser-profile.repository";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";

export type ActionResult = { ok: true } | { ok: false; message: string };

function fail(error: unknown): ActionResult {
  return {
    ok: false,
    message: error instanceof Error ? error.message : "İşlem başarısız",
  };
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function audit(
  workspaceId: string,
  projectId: string,
  userId: string,
  action: string,
  entityId: string,
) {
  await AuditLogRepository.record({
    workspaceId,
    projectId,
    actorType: "USER",
    actorId: userId,
    action,
    entityType: "BrowserProfile",
    entityId,
  });
}

// Yeni bir kanal/entegrasyon satırı açar — bu bir OAuth akışı DEĞİL, sadece
// "bu kanalı takip etmek istiyorum" kaydını oluşturur. Satır kasıtlı olarak
// LOGIN_REQUIRED ile başlar: gerçekten bağlı değil, bir operatörün OpenClaw
// üzerinden manuel giriş yapıp `markIntegrationConnectedAction` ile
// işaretlemesi gerekiyor.
export async function addIntegrationAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const purpose = String(formData.get("purpose")) as BrowserProfilePurpose;
    const name = String(formData.get("name") ?? "").trim();
    if (!name) return { ok: false, message: "İsim gerekli" };

    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);

    let baseSlug = slugify(name);
    if (!baseSlug) baseSlug = purpose.toLowerCase();
    let slug = baseSlug;
    let attempt = 0;
    let profile;
    for (;;) {
      try {
        profile = await BrowserProfileRepository.create({
          workspaceId: access.workspaceId,
          projectId,
          brandId: access.defaultBrandId,
          name,
          slug,
          purpose,
          status: "LOGIN_REQUIRED",
        });
        break;
      } catch (error) {
        attempt += 1;
        if (attempt > 5) throw error;
        slug = `${baseSlug}-${attempt}`;
      }
    }

    await audit(
      access.workspaceId,
      projectId,
      userId,
      "browser_profile.added",
      profile.id,
    );
    revalidatePath(`/projects/${projectId}/entegrasyonlar`);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

// Bir operatör OpenClaw üzerinden manuel giriş yaptıktan sonra ("bu kanal
// artık gerçekten bağlı") ya da devre dışı bırakılmış bir entegrasyonu
// yeniden etkinleştirirken kullanılır — ikisi de aynı READY hedefine gider.
export async function markIntegrationConnectedAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const profileId = String(formData.get("profileId"));
    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);

    await BrowserProfileRepository.transition(profileId, projectId, "READY");
    await audit(
      access.workspaceId,
      projectId,
      userId,
      "browser_profile.marked_connected",
      profileId,
    );
    revalidatePath(`/projects/${projectId}/entegrasyonlar`);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

export async function disableIntegrationAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const profileId = String(formData.get("profileId"));
    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);

    await BrowserProfileRepository.transition(profileId, projectId, "DISABLED");
    await audit(
      access.workspaceId,
      projectId,
      userId,
      "browser_profile.disabled",
      profileId,
    );
    revalidatePath(`/projects/${projectId}/entegrasyonlar`);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}
