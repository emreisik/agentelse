import "server-only";

import type { ActorType, Approval } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { ApprovalRepository } from "@/server/repositories/approval.repository";
import { CreativeRepository } from "@/server/repositories/creative.repository";
import { TaskRepository } from "@/server/repositories/task.repository";
import { TaskPlanner } from "@/server/commands/task-planner";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { IdeaChatRepository } from "@/server/repositories/idea-chat.repository";
import { sendPublishPromptToTelegram } from "@/server/notifications/telegram-approval-notifier";

// Bir onay kararının (Task ya da Creative) hangi fikrin sohbetine ait
// olduğunu ve kartta gösterilecek başlığı bulur — Task için doğrudan
// (resolveIdeaIdForTask), Creative için önce onu üreten görev üzerinden
// (Creative.createdByTaskId), oradan da aynı yoldan. İkisi de yoksa (ör.
// fikirsiz elle oluşturulmuş görev/kreatif) null döner — sessizce atlanır.
async function resolveApprovalChatTarget(
  approval: Approval,
): Promise<{ ideaId: string; title: string } | null> {
  if (approval.entityType === "Task" && approval.taskId) {
    const [ideaId, task] = await Promise.all([
      IdeaChatRepository.resolveIdeaIdForTask(approval.taskId),
      prisma.task.findUnique({
        where: { id: approval.taskId },
        select: { title: true },
      }),
    ]);
    if (!ideaId || !task) return null;
    return { ideaId, title: task.title };
  }

  if (approval.entityType === "Creative") {
    const creative = await prisma.creative.findUnique({
      where: { id: approval.entityId },
      select: { createdByTaskId: true },
    });
    if (!creative?.createdByTaskId) return null;
    const [ideaId, task] = await Promise.all([
      IdeaChatRepository.resolveIdeaIdForTask(creative.createdByTaskId),
      prisma.task.findUnique({
        where: { id: creative.createdByTaskId },
        select: { title: true },
      }),
    ]);
    if (!ideaId) return null;
    return { ideaId, title: task?.title ?? "Kreatif" };
  }

  return null;
}

// approveApprovalAction/rejectApprovalAction (web, src/server/actions/
// approval-actions.ts) VE Telegram onay poller'ı (src/server/integrations/
// telegram-approval-poller.ts) ortak bu fonksiyonu kullanır. Session/tenant
// kontrolü ve revalidatePath bilinçli olarak DIŞARIDA bırakıldı — poller'da
// ne oturum var ne de bir Next.js sayfa cache'i revalidate edilecek bir
// istek bağlamı.
export async function applyApprovalDecision(input: {
  approval: Approval;
  to: "APPROVED" | "REJECTED";
  reviewedByUserId: string;
  actorType: ActorType;
}): Promise<void> {
  const { approval, to, reviewedByUserId, actorType } = input;

  await ApprovalRepository.decide(
    approval.id,
    approval.projectId,
    to,
    reviewedByUserId,
  );

  if (approval.entityType === "Task" && approval.taskId) {
    if (to === "APPROVED") {
      await TaskPlanner.dispatchApprovedTask(
        approval.taskId,
        approval.projectId,
      );
    } else {
      await TaskRepository.transition(
        approval.taskId,
        approval.projectId,
        "CANCELLED",
      );
    }
  }
  if (approval.entityType === "Creative") {
    await CreativeRepository.transition(
      approval.entityId,
      approval.projectId,
      to === "APPROVED" ? "APPROVED" : "REJECTED",
    );
  }

  // Onay kararı da "altın kural"a tabi: fikrin sohbetinde ayrı bir panele
  // gitmeden, kimin neyi onayladığı/reddettiği burada görünsün. Best-effort
  // — fikre bağlanamıyorsa (fikirsiz görev/kreatif) sessizce atlanır.
  try {
    const target = await resolveApprovalChatTarget(approval);
    if (target) {
      if (approval.entityType === "Creative") {
        // Task'ın aksine kartı genel bir "approval-decision" kartına
        // ÇEVİRMİYORUZ — creative-ready kartı zaten görseli/başlığı
        // taşıyor, kaybetmemek için sadece status alanı güncellenir (bkz.
        // resolveCreativeApprovalDecision).
        await IdeaChatRepository.resolveCreativeApprovalDecision({
          ideaId: target.ideaId,
          creativeId: approval.entityId,
          status: to,
        });

        // Onaylandıysa, aynı satırı güncellemek yerine sohbete AYRI bir
        // soru turu düşer — "Sosyal Hesaplarda Paylaş" bölümü zaten
        // creative-ready kartında var ama sessiz kalıyordu, kullanıcı
        // fark etmiyordu. Bu, aynı seçenekleri (PublishSection) ayrı,
        // gözden kaçmayan bir kartta tekrar sunuyor.
        if (to === "APPROVED") {
          await IdeaChatRepository.postSystemMessage({
            workspaceId: approval.workspaceId,
            projectId: approval.projectId,
            ideaId: target.ideaId,
            text: `📤 ${target.title} onaylandı — sosyal medyada paylaşmak ister misiniz?`,
            card: {
              kind: "publish-prompt",
              creativeId: approval.entityId,
              title: target.title,
            },
          });
          // Aynı soru Telegram'a da gitsin — kullanıcı web'i açmadan
          // doğrudan Telegram'dan "Gönderi"/"Story"/"Hayır" seçebilsin
          // (bkz. telegram-approval-poller.ts pubfeed/pubstory/pubskip).
          await sendPublishPromptToTelegram({
            projectId: approval.projectId,
            creativeId: approval.entityId,
            title: target.title,
          });
        }
      } else {
        // Task için sohbette zaten AÇIK bir "approval-request" kartı varsa
        // (bkz. TaskPlanner.planForCapability -> postApprovalRequestCard)
        // AYNI satır sonuca güncellenir — Onayla/Reddet düğmeleri kararla
        // birlikte kaybolur, ikinci bir kart belirmez.
        await IdeaChatRepository.resolveApprovalDecisionCard({
          workspaceId: approval.workspaceId,
          projectId: approval.projectId,
          ideaId: target.ideaId,
          approvalId: approval.id,
          text:
            to === "APPROVED"
              ? `✅ Onaylandı: ${target.title}`
              : `❌ Reddedildi: ${target.title}`,
          card: {
            kind: "approval-decision",
            title: target.title,
            entityType: approval.entityType as "Task" | "Creative",
            decision: to,
          },
        });
      }
    }
  } catch (error) {
    console.error(
      "[approval-decisions] approval-decision card yazılamadı:",
      error,
    );
  }

  await AuditLogRepository.record({
    workspaceId: approval.workspaceId,
    projectId: approval.projectId,
    brandId: approval.brandId,
    actorType,
    actorId: reviewedByUserId,
    action: to === "APPROVED" ? "approval.approved" : "approval.rejected",
    entityType: "Approval",
    entityId: approval.id,
  });
}
