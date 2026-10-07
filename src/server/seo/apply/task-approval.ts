import "server-only";

import { buildSeoApplyPayload } from "@/lib/seo/apply/approval-details";
import { SEO_CHANGE_TASK_TITLE } from "@/lib/seo/apply/copy";
import type { SeoChangeKind } from "@/lib/seo/apply/types";
import { ExecutionPolicy } from "@/server/execution/execution-policy";
import { approvalCategory } from "@/server/execution/approval-details";
import { ApprovalRepository } from "@/server/repositories/approval.repository";
import { IdeaChatRepository } from "@/server/repositories/idea-chat.repository";
import { TaskRepository } from "@/server/repositories/task.repository";

// Bir WordPress değişikliği için Task + Approval çifti (GA-F7 deseni). Hiçbir
// ExecutionJob ya da sağlayıcı yoktur; onaylanınca TaskPlanner.dispatchApprovedTask
// araya girer (approval-hook.ts). Task ve kart başlıkları SABİTTİR: sayfa yolu,
// URL ve makale başlığı yalnız payload.details satırlarında durur (Disconnect'te
// cleanup.ts bu satırları siler).

const TASK_DESCRIPTION =
  "Nothing changes on your website until an owner or admin approves this.";

export async function createSeoApplyTaskApproval(input: {
  workspaceId: string;
  projectId: string;
  brandId: string;
  userId: string;
  changeId: string;
  kind: SeoChangeKind;
  details: { label: string; value: string }[];
  // SeoChange.expiresAt ile AYNI değer (propose tek kez hesaplar).
  expiresAt: Date;
  now: Date;
}): Promise<{ taskId: string; approvalId: string }> {
  const title = SEO_CHANGE_TASK_TITLE[input.kind];
  const riskLevel = ExecutionPolicy.defaultRiskLevel("WEBSITE_UPDATE");

  const task = await TaskRepository.create({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    brandId: input.brandId,
    capability: "WEBSITE_UPDATE",
    title,
    description: TASK_DESCRIPTION,
    payload: buildSeoApplyPayload({
      changeId: input.changeId,
      kind: input.kind,
      details: input.details,
    }),
    riskLevel,
    requiresApproval: true,
    createdByType: "USER",
    createdByUserId: input.userId,
    departmentKey: "SEO",
  });

  try {
    await TaskRepository.transition(task.id, input.projectId, "WAITING_APPROVAL");

    // notify:false Telegram'daki istek mesajını kapatır: sayfa içeriği Telegram'a
    // gitmez. Sohbetteki düz "evet" de bu onayı vermez (command-service paylaşılan
    // düzenlemesi: CRITICAL_CHANGE_APPROVAL onay kartına yönlendirir).
    const approval = await ApprovalRepository.create({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      brandId: input.brandId,
      taskId: task.id,
      entityType: "Task",
      entityId: task.id,
      type: "CRITICAL_CHANGE_APPROVAL",
      level: "LEVEL_3_CLIENT",
      requestedByType: "USER",
      requestedById: input.userId,
      expiresAt: input.expiresAt,
      notify: false,
    });

    // Sohbet kartı en iyi çabayla; kart metni Command satırında durur ve
    // Disconnect'te cleanup.ts sabit başlıkla ezer.
    try {
      await IdeaChatRepository.postApprovalRequestCard({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        taskId: task.id,
        approvalId: approval.id,
        title,
        riskLevel,
        departmentKey: "SEO",
        category: approvalCategory("CRITICAL_CHANGE_APPROVAL", "LEVEL_3_CLIENT"),
        details: input.details,
      });
    } catch (error) {
      console.error(
        "[seo-apply] approval card could not be posted:",
        error instanceof Error ? error.name : "unknown",
      );
    }

    return { taskId: task.id, approvalId: approval.id };
  } catch (error) {
    // Onay kurulamadıysa Task bekleyen iş olarak kalmasın.
    await TaskRepository.transition(task.id, input.projectId, "CANCELLED", {
      failureReason: "The WordPress change could not be requested",
    }).catch(() => undefined);
    throw error;
  }
}
