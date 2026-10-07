import "server-only";

import { prisma } from "@/lib/prisma";
import { GA_FIX_CATALOG } from "@/lib/website-analytics/fixes/catalog";
import type { GaFixKind, GaFixParams } from "@/lib/website-analytics/fixes/types";
import { IdeaChatRepository } from "@/server/repositories/idea-chat.repository";
import { ApprovalRepository } from "@/server/repositories/approval.repository";
import { TaskRepository } from "@/server/repositories/task.repository";
import { AgentelseError } from "@/server/security/errors";

import type { ProposeInput } from "./types";

// Bir GA düzeltmesi için Task + Approval çifti kurar. Hiçbir ExecutionJob ya
// da sağlayıcı yoktur; onaylanınca TaskPlanner.dispatchApprovedTask araya girer
// (approval-hook.ts). Onay kartında ve Task metninde mülk adı YOKTUR: bu
// satırlar GaPropertyLink cascade'ine bağlı değildir, Disconnect'te ayrıca
// temizlenir (cleanup.ts).
export async function createGaFixApproval(input: {
  workspaceId: string;
  projectId: string;
  changeId: string;
  kind: GaFixKind;
  params: GaFixParams;
  title: string;
  actor: ProposeInput["actor"];
  expiresAt: Date;
}): Promise<{ taskId: string; approvalId: string }> {
  const entry = GA_FIX_CATALOG[input.kind];
  const title = input.title.slice(0, 80);
  const details = entry.approvalRows(input.params);
  const userId = input.actor.type === "USER" ? input.actor.userId : undefined;

  // requireProjectAccess ile aynı sorgu; tenant-context içe aktarılmaz (auth
  // grafiği işçi sürecine girmesin).
  const brand = await prisma.brand.findFirst({
    where: { projectId: input.projectId, isDefault: true },
    select: { id: true },
  });
  if (!brand) {
    throw new AgentelseError("NOT_FOUND", "Project has no default brand");
  }

  const task = await TaskRepository.create({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    brandId: brand.id,
    capability: "ANALYTICS_EDIT",
    title,
    description: entry.effect(input.params),
    payload: {
      request: title,
      gaConfigChangeId: input.changeId,
      kind: input.kind,
      details,
    },
    riskLevel: "MEDIUM",
    createdByType: input.actor.type,
    createdByUserId: userId,
    requiresApproval: true,
    requiresVerification: false,
    departmentKey: "DATA_ANALYTICS",
  });

  try {
    await TaskRepository.transition(task.id, input.projectId, "WAITING_APPROVAL");

    // notify:false Telegram'daki istek mesajını kapatır; karar ve tamamlanma
    // bildirimleri paylaşılan iki korumayla kapalıdır (no-telegram.test.ts).
    const approval = await ApprovalRepository.create({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      brandId: brand.id,
      taskId: task.id,
      entityType: "Task",
      entityId: task.id,
      type: "CRITICAL_CHANGE_APPROVAL",
      level: "LEVEL_3_CLIENT",
      requestedByType: input.actor.type,
      requestedById: userId,
      expiresAt: input.expiresAt,
      notify: false,
    });

    // Sohbet kartı en iyi çabayla: kart metni Command satırında
    // (replyText + parsedIntent.card) saklanır; Disconnect'te cleanup.ts
    // aynı satırı sabit başlıkla ezer.
    try {
      await IdeaChatRepository.postApprovalRequestCard({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        taskId: task.id,
        approvalId: approval.id,
        title,
        riskLevel: "MEDIUM",
        departmentKey: "DATA_ANALYTICS",
        details,
        category: "action",
      });
    } catch (error) {
      console.error(
        "[ga-fixes] approval card could not be posted:",
        error instanceof Error ? error.name : "unknown",
      );
    }

    return { taskId: task.id, approvalId: approval.id };
  } catch (error) {
    // Onay kurulamadıysa Task bekleyen iş olarak kalmasın.
    await TaskRepository.transition(task.id, input.projectId, "CANCELLED", {
      failureReason: "Google Analytics change could not be requested",
    }).catch(() => undefined);
    throw error;
  }
}
