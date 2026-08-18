import "server-only";

import { prisma } from "@/lib/prisma";
import { CommandService } from "@/server/commands/command-service";
import { CommandRepository } from "@/server/repositories/command.repository";
import { IdeaChatRepository } from "@/server/repositories/idea-chat.repository";
import { buildAssetPublicUrl } from "@/server/security/asset-public-link";
import { getPublishTargets } from "@/server/integrations/meta-connection-status";

export type PublishQuickActionResult =
  { ok: true; message: string } | { ok: false; message: string };

// publishCreativeToInstagramAction'ın (src/server/actions/publish-actions.ts,
// web/session tabanlı) VE Telegram callback'inin (telegram-approval-poller.ts,
// oturumsuz arka plan bağlamı) paylaştığı asıl mantık. Bilerek "use server"
// İŞARETLİ DEĞİL — bu bir Server Action değil, düz bir sunucu-taraf fonksiyonu;
// requireUser() burada YOK, çağıran taraf (web action ya da poller) kendi
// yetkilendirmesini kendisi yapıp workspaceId/projectId/actorUserId'yi
// zaten doğrulanmış olarak geçiriyor. applyApprovalDecision'ın
// reviewedByUserId için "telegram:<id>" sözde-kullanıcı deseniyle aynı
// mantık burada da actorUserId için geçerli.
export async function publishCreativeCore(input: {
  creativeId: string;
  format: "FEED" | "STORIES";
  workspaceId: string;
  projectId: string;
  actorUserId: string;
}): Promise<PublishQuickActionResult> {
  const { creativeId, format, workspaceId, projectId, actorUserId } = input;

  const creative = await prisma.creative.findUnique({
    where: { id: creativeId },
    include: { versions: { orderBy: { version: "desc" }, take: 1 } },
  });
  if (!creative) return { ok: false, message: "Kreatif bulunamadı." };

  const targets = await getPublishTargets(projectId);
  if (targets.length === 0) {
    return {
      ok: false,
      message: "Bağlı ve Instagram hesabına sahip bir Meta sayfası yok.",
    };
  }

  const version = creative.versions[0];
  if (!version?.assetId) {
    return {
      ok: false,
      message: "Bu kreatif için paylaşılacak bir görsel yok.",
    };
  }

  const ideaId = creative.createdByTaskId
    ? await IdeaChatRepository.resolveIdeaIdForTask(creative.createdByTaskId)
    : null;

  const imageUrl = buildAssetPublicUrl(version.assetId);
  const caption = version.caption || version.copy || "";
  const title = creative.title ?? "Kreatif";
  const formatLabel = format === "STORIES" ? "story" : "gönderi";

  const submission = await CommandService.submit({
    workspaceId,
    source: "WEB",
    rawText: `Instagram'da paylaş (${formatLabel}): ${title}`,
    actorType: "USER",
    userId: actorUserId,
    knownProjectId: projectId,
    ideaId: ideaId ?? undefined,
    departmentKey: "SOCIAL_MEDIA",
    intent: {
      kind: "CAPABILITY",
      capability: "INSTAGRAM_PUBLISH",
      targetPlatform: "INSTAGRAM",
      request: `${title} — Instagram ${formatLabel} paylaşımı`,
    },
    payloadExtra: {
      imageUrl,
      caption,
      targetFormat: format === "STORIES" ? "STORIES" : undefined,
    },
  });

  const reply =
    submission.status === "PLANNED"
      ? submission.requiresApproval
        ? `📤 Instagram ${formatLabel} paylaşımı onaya gönderildi.`
        : `📤 Instagram ${formatLabel} paylaşımı kuyruğa alındı.`
      : "Paylaşım isteği oluşturulamadı.";
  await CommandRepository.recordReply(
    submission.commandId,
    reply,
    submission.status === "PLANNED" ? "PLANNED" : "ERROR",
  );

  if (submission.status !== "PLANNED") {
    return { ok: false, message: "Paylaşım isteği oluşturulamadı." };
  }
  return { ok: true, message: reply };
}
