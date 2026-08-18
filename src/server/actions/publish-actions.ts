"use server";

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/prisma";
import {
  requireUser,
  requireProjectAccess,
} from "@/server/security/tenant-context";
import {
  publishCreativeCore,
  type PublishQuickActionResult,
} from "@/server/commands/publish-creative";
import {
  getPublishTargets,
  type PublishTarget,
} from "@/server/integrations/meta-connection-status";

export type { PublishQuickActionResult };

// Onaylanmış kreatif kartındaki "Sosyal Hesaplarda Paylaş" bölümünün
// (bkz. creative-card.tsx) hangi hesapları listeyeceğini döner. Kart yalnızca
// creativeId biliyor — approveApprovalAction/rejectApprovalAction'ın
// approvalId'den self-contained çalışması gibi, burada da projectId
// Creative satırından çözülüyor, çağıran taraf ideaId/projectId taşımak
// zorunda kalmıyor.
export async function getCreativePublishTargetsAction(
  creativeId: string,
): Promise<PublishTarget[]> {
  const { userId } = await requireUser();
  const creative = await prisma.creative.findUnique({
    where: { id: creativeId },
    select: { projectId: true },
  });
  if (!creative) return [];
  await requireProjectAccess(userId, creative.projectId);
  return getPublishTargets(creative.projectId);
}

// Kartın "Paylaş" düğmesi — bu kreatifin GÜNCEL versiyonunu bağlı Instagram
// hesabına INSTAGRAM_PUBLISH capability'siyle (CommandService üzerinden,
// LLM'i atlayıp doğrudan pre-resolved bir intent'le) gönderir.
// INSTAGRAM_PUBLISH onay gerektiren bir capability (execution-policy.ts) —
// bu yüzden sonuç ANINDA yayın değil, onaya gönderilmiş bir görevdir.
// Asıl mantık publish-creative.ts'te — Telegram callback'i de (oturumsuz)
// aynı çekirdeği çağırıyor, burada sadece web oturumu doğrulanıyor.
export async function publishCreativeToInstagramAction(
  creativeId: string,
  format: "FEED" | "STORIES" = "FEED",
): Promise<PublishQuickActionResult> {
  const { userId } = await requireUser();

  const creative = await prisma.creative.findUnique({
    where: { id: creativeId },
    select: { projectId: true },
  });
  if (!creative) return { ok: false, message: "Kreatif bulunamadı." };

  const access = await requireProjectAccess(userId, creative.projectId);

  const result = await publishCreativeCore({
    creativeId,
    format,
    workspaceId: access.workspaceId,
    projectId: creative.projectId,
    actorUserId: userId,
  });

  revalidatePath(`/projects/${creative.projectId}`);
  return result;
}
