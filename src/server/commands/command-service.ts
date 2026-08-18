import "server-only";

import type { ActorType, CommandSource, DepartmentKey } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { HubConnectError } from "@/server/security/errors";
import {
  CommandRepository,
  type CommandAttachment,
} from "@/server/repositories/command.repository";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { ApprovalRepository } from "@/server/repositories/approval.repository";
import {
  parseIntent,
  type ParsedIntent,
} from "@/server/commands/intent-router";
import { resolveProjectFromText } from "@/server/commands/project-resolver";
import { TaskPlanner } from "@/server/commands/task-planner";

export type SubmitCommandInput = {
  workspaceId: string;
  source: CommandSource;
  rawText: string;
  actorType: ActorType;
  userId?: string;
  // When the caller (e.g. a project page) already knows the project — skips
  // ProjectResolver so a fuzzy text match can't misroute a follow-up message
  // to the wrong brand.
  knownProjectId?: string;
  // Bir fikrin kendi sohbet iş parçacığından gönderiliyorsa — Command bu
  // fikre etiketlenir (bkz. Command.ideaId).
  ideaId?: string;
  // Sohbet yüzeyinden gelen dosyalar. Komutun kendisine kaydedilir ve
  // oluşan görevin payload'ına asset id'leri olarak taşınır.
  attachments?: CommandAttachment[];
  // Verildiğinde kural tabanlı parseIntent atlanır. Sohbet yüzeyi niyeti
  // LLM ile çözüyor; kural tabanlı ayrıştırıcı serbest metnin çoğuna
  // UNKNOWN dönüyor ve mesaj sessizce düşüyordu.
  intent?: ParsedIntent;
  // Composer'daki entegrasyon quick-action'ları (ör. "+" menüsünden
  // Instagram'da paylaş) gibi, niyeti ZATEN tam olarak bilen çağıranlar
  // için — TaskPlanner.planForCapability'ye olduğu gibi geçirilir (ör.
  // INSTAGRAM_PUBLISH için { imageUrl, caption }). Ek dosyalardan türeyen
  // attachmentAssetIds ile birleştirilir (çakışırsa bu alan üstün gelir).
  payloadExtra?: Record<string, unknown>;
  // Belirtilirse görev doğrudan bu departmana etiketlenir — sohbet
  // kartlarında departman adı/ikonu bu alandan gösterilir (bkz.
  // idea-event-card.tsx).
  departmentKey?: DepartmentKey;
};

export type SubmitCommandResult =
  | {
      status: "PLANNED";
      commandId: string;
      taskId: string;
      dispatched: boolean;
      requiresApproval: boolean;
    }
  | {
      status: "NEEDS_PROJECT";
      commandId: string;
      candidates?: { projectId: string; name: string }[];
    }
  | { status: "APPROVAL_HANDLED"; commandId: string; approvalId: string }
  | { status: "UNKNOWN_INTENT"; commandId: string };

// Single entry point for turning natural-language input into work,
// regardless of where it came from (spec section 72 — Web, API, System,
// Schedule all flow through here so business logic is never duplicated per
// channel).
export const CommandService = {
  async submit(input: SubmitCommandInput): Promise<SubmitCommandResult> {
    const command = await CommandRepository.create({
      workspaceId: input.workspaceId,
      source: input.source,
      rawText: input.rawText,
      createdByUserId: input.userId,
      projectId: input.knownProjectId,
      ideaId: input.ideaId,
      attachments: input.attachments,
    });

    const intent = input.intent ?? parseIntent(input.rawText);

    await AuditLogRepository.record({
      workspaceId: input.workspaceId,
      projectId: input.knownProjectId,
      actorType: input.actorType,
      actorId: input.userId,
      action: "command.received",
      entityType: "Command",
      entityId: command.id,
      metadata: { source: input.source, intentKind: intent.kind },
    });

    if (intent.kind === "APPROVAL_DECISION") {
      const approval = await findLatestPendingApproval(
        input.workspaceId,
        input.knownProjectId,
      );
      if (!approval) {
        return { status: "UNKNOWN_INTENT", commandId: command.id };
      }

      if (!input.userId) {
        throw new HubConnectError(
          "PERMISSION_DENIED",
          "Approval decisions require an authenticated user",
        );
      }

      if (intent.decision === "APPROVE") {
        await ApprovalRepository.decide(
          approval.id,
          approval.projectId,
          "APPROVED",
          input.userId,
        );
        if (approval.taskId) {
          await TaskPlanner.dispatchApprovedTask(
            approval.taskId,
            approval.projectId,
          );
        }
      } else if (intent.decision === "REJECT") {
        await ApprovalRepository.decide(
          approval.id,
          approval.projectId,
          "REJECTED",
          input.userId,
        );
      } else {
        await ApprovalRepository.decide(
          approval.id,
          approval.projectId,
          "REVISION_REQUESTED",
          input.userId,
          intent.note,
        );
      }

      return {
        status: "APPROVAL_HANDLED",
        commandId: command.id,
        approvalId: approval.id,
      };
    }

    if (intent.kind !== "CAPABILITY") {
      return { status: "UNKNOWN_INTENT", commandId: command.id };
    }

    let projectId = input.knownProjectId;
    let brandId: string | undefined;

    if (!projectId) {
      const resolution = await resolveProjectFromText(
        input.workspaceId,
        input.rawText,
      );
      if (resolution.status !== "RESOLVED") {
        if (resolution.status === "AMBIGUOUS") {
          return {
            status: "NEEDS_PROJECT",
            commandId: command.id,
            candidates: resolution.candidates,
          };
        }
        return { status: "NEEDS_PROJECT", commandId: command.id };
      }
      projectId = resolution.projectId;
      brandId = resolution.brandId;
    } else {
      const brand = await prisma.brand.findFirst({
        where: { projectId, isDefault: true },
      });
      if (!brand)
        throw new HubConnectError(
          "NOT_FOUND",
          `Project ${projectId} has no default brand`,
        );
      brandId = brand.id;
    }

    await CommandRepository.attachParsedIntent(
      command.id,
      intent,
      projectId,
      brandId,
    );

    const attachmentPayloadExtra = input.attachments?.length
      ? { attachmentAssetIds: input.attachments.map((a) => a.assetId) }
      : undefined;

    const plan = await TaskPlanner.planForCapability({
      workspaceId: input.workspaceId,
      projectId,
      brandId,
      commandId: command.id,
      capability: intent.capability,
      targetPlatform: intent.targetPlatform,
      request: intent.request,
      createdByType: input.actorType,
      createdByUserId: input.userId,
      departmentKey: input.departmentKey,
      // Ekler görevin payload'ına taşınır: yürütücü sağlayıcı (örn. kreatif
      // görsel üretimi) kullanıcının referans görselini burada bulur.
      payloadExtra:
        attachmentPayloadExtra || input.payloadExtra
          ? { ...attachmentPayloadExtra, ...input.payloadExtra }
          : undefined,
    });

    return {
      status: "PLANNED",
      commandId: command.id,
      taskId: plan.task.id,
      dispatched: plan.dispatched,
      requiresApproval: !plan.dispatched && !("deferred" in plan),
    };
  },
};

async function findLatestPendingApproval(
  workspaceId: string,
  projectId?: string,
) {
  return prisma.approval.findFirst({
    where: {
      workspaceId,
      status: "PENDING",
      ...(projectId ? { projectId } : {}),
    },
    orderBy: { createdAt: "desc" },
  });
}
