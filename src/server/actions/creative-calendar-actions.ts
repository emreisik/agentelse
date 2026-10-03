"use server";

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/prisma";
import { zonedDateTimeToUtc } from "@/lib/timezone";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { CreativeRepository } from "@/server/repositories/creative.repository";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import type { ActionResult } from "@/server/actions/agency-config-actions";

const DATETIME_LOCAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

// The content calendar's only write path (spec: takvim) — assigns or
// clears which instant a creative is planned to publish at. Deliberately
// separate from creative-actions.ts (image generation/revision) and
// approval-actions.ts (approve/reject): this action never touches status,
// versions, or the approval pipeline, it only ever moves a creative
// between days/times (or back to "Unscheduled" when date is empty).
export async function assignCreativeDateAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const creativeId = String(formData.get("creativeId") ?? "");
    // A <input type="datetime-local"> value — a naive "YYYY-MM-DDTHH:mm"
    // wall-clock string with no timezone of its own (see timezone.ts's
    // module comment for why this can't just be `new Date(dateRaw)`).
    const dateRaw = String(formData.get("date") ?? "").trim();
    if (!creativeId) {
      return { ok: false, message: "Missing creative." };
    }
    if (dateRaw && !DATETIME_LOCAL_RE.test(dateRaw)) {
      return { ok: false, message: "Invalid date/time." };
    }

    const creative = await prisma.creative.findUnique({
      where: { id: creativeId },
      select: { projectId: true, workspaceId: true, brandId: true },
    });
    if (!creative) {
      return { ok: false, message: "Creative not found." };
    }

    const { userId } = await requireUser();
    await requireProjectAccess(userId, creative.projectId);

    // Same "read the project's Publishing-tab timezone, default
    // Europe/Istanbul" lookup as settings-panel.tsx and
    // approval-decisions.ts — no dedicated repository for this one-row
    // query, matching how those two already do it inline.
    const schedule = await prisma.projectSchedule.findFirst({
      where: { projectId: creative.projectId, capability: "INSTAGRAM_PUBLISH" },
      select: { timezone: true },
    });
    const timezone = schedule?.timezone ?? "Europe/Istanbul";

    const date = dateRaw ? zonedDateTimeToUtc(dateRaw, timezone) : null;
    const { count } = await CreativeRepository.setScheduledFor(
      creativeId,
      creative.projectId,
      date,
    );
    if (count === 0) {
      return { ok: false, message: "Creative not found in this project." };
    }

    await AuditLogRepository.record({
      workspaceId: creative.workspaceId,
      projectId: creative.projectId,
      brandId: creative.brandId,
      actorType: "USER",
      actorId: userId,
      action: date ? "creative.scheduled" : "creative.unscheduled",
      entityType: "Creative",
      entityId: creativeId,
    });

    revalidatePath(`/projects/${creative.projectId}/takvim`);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Operation failed",
    };
  }
}

export type RescheduleResult =
  | { ok: true; scheduledFor: string | null }
  | { ok: false; message: string };

// Sürükle-bırak yolu: bir parçanın yayın zamanını taşır ya da (localDateTime
// null ise) gününü kaldırır. assignCreativeDateAction'ın formundan farkı:
// düz argüman alır, hangi anın yazıldığını geri söyler ve (geri alma hariç)
// geçmişe taşımayı reddeder. Onaylı bir parça geçmiş bir zamana yazılırsa yayın
// kuyruğu onu hemen vadesi gelmiş sayıp paylaşır; yanlış bir sürükleme canlı
// hesaba anında gönderi atmamalı. `restore`: "Geri al" önceki değeri
// (geçmiş de olabilir) olduğu gibi yazar.
export async function rescheduleCreativeAction(input: {
  creativeId: string;
  localDateTime: string | null;
  restore?: boolean;
}): Promise<RescheduleResult> {
  try {
    const { creativeId, localDateTime } = input;
    if (!creativeId) return { ok: false, message: "Missing creative." };
    if (localDateTime !== null && !DATETIME_LOCAL_RE.test(localDateTime)) {
      return { ok: false, message: "Invalid date/time." };
    }

    // Birbirinden bağımsız okumalar paralel: uzak veritabanında her seri tur
    // yüzlerce ms. (Yazmadan önce hepsi bitmiş olur, erişim kontrolü dahil.)
    const [{ userId }, creative] = await Promise.all([
      requireUser(),
      prisma.creative.findUnique({
        where: { id: creativeId },
        select: {
          projectId: true,
          workspaceId: true,
          brandId: true,
          status: true,
        },
      }),
    ]);
    if (!creative) return { ok: false, message: "Creative not found." };

    const [, schedule] = await Promise.all([
      requireProjectAccess(userId, creative.projectId),
      prisma.projectSchedule.findFirst({
        where: {
          projectId: creative.projectId,
          capability: "INSTAGRAM_PUBLISH",
        },
        select: { timezone: true },
      }),
    ]);

    if (creative.status === "PUBLISHED") {
      return {
        ok: false,
        message: "This piece is already posted, so it can't be moved.",
      };
    }

    const timezone = schedule?.timezone ?? "Europe/Istanbul";

    const date = localDateTime
      ? zonedDateTimeToUtc(localDateTime, timezone)
      : null;
    // Bir dakikalık tolerans: sunucu ile istemci saati arasındaki fark.
    if (date && !input.restore && date.getTime() < Date.now() - 60_000) {
      return {
        ok: false,
        message: "Can't schedule in the past. Pick today or a later day.",
      };
    }

    const { count } = await CreativeRepository.setScheduledFor(
      creativeId,
      creative.projectId,
      date,
    );
    if (count === 0) {
      return { ok: false, message: "Creative not found in this project." };
    }

    await AuditLogRepository.record({
      workspaceId: creative.workspaceId,
      projectId: creative.projectId,
      brandId: creative.brandId,
      actorType: "USER",
      actorId: userId,
      action: date ? "creative.scheduled" : "creative.unscheduled",
      entityType: "Creative",
      entityId: creativeId,
    });

    // revalidatePath bilerek YOK: bu yazma yolu sayfayı komple yeniden render
    // ettirirdi (kenar çubuğu, journey snapshot... onlarca sorgu). Pano yeni
    // durumu kendisi türetir (src/lib/calendar/item.ts) ve hafif yoklama ucundan
    // doğrular.
    return { ok: true, scheduledFor: date ? date.toISOString() : null };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Operation failed",
    };
  }
}
