import "server-only";

import { prisma } from "@/lib/prisma";
import { ReasoningService } from "@/server/reasoning/reasoning-service";
import {
  chatTurnDef,
  type ChatTurnOutput,
} from "@/server/reasoning/prompts/chat-turn";
import { CommandService } from "@/server/commands/command-service";
import {
  CommandRepository,
  type CommandAttachment,
  type CommandReplyStatus,
} from "@/server/repositories/command.repository";
import type { ParsedIntent } from "@/server/commands/intent-router";

export type ChatTurnInput = {
  workspaceId: string;
  projectId: string;
  userId: string;
  message: string;
  attachments?: CommandAttachment[];
  // Gemini'ye inlineData olarak giden gövdeler; attachments ile aynı sırada.
  // Ayrı taşınıyor çünkü base64 gövde Command satırına yazılmaz (JSON şişer),
  // yalnızca modele gösterilir.
  attachmentBodies?: { mimeType: string; data: string }[];
  // Bir fikrin kendi sohbet iş parçacığından mesaj gönderiliyorsa — hem
  // Command bu fikre etiketlenir hem de geçmiş bağlamı (buildContext)
  // proje-geneli yerine bu fikrin thread'iyle sınırlanır.
  ideaId?: string;
};

export type ChatTurnResult = {
  commandId: string;
  reply: string;
  status: CommandReplyStatus;
};

// Sohbet ekranının sunucu tarafı: her kullanıcı mesajında marka bağlamını
// toplar, LLM'e niyet + yanıt ürettirir, iş talebiyse CommandService'e
// devreder ve yanıtı Command satırına kaydeder — sayfa yenilendiğinde
// konuşma geçmişi veritabanından aynen geri gelir.
export const ChatService = {
  async turn(input: ChatTurnInput): Promise<ChatTurnResult> {
    const context = await buildContext(input.projectId, input.ideaId);

    let turn: ChatTurnOutput;
    try {
      const result = await ReasoningService.run(chatTurnDef, {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        brandId: context.brandId,
        attachments: input.attachmentBodies,
        context: {
          project: context.project,
          brand: context.brand,
          state: context.state,
          pending: context.pending,
          history: context.history,
          attachments: (input.attachments ?? []).map((attachment) => ({
            filename: attachment.filename,
            mimeType: attachment.mimeType,
          })),
          message: input.message,
        },
      });
      turn = result.output;
    } catch (error) {
      // LLM düşse bile mesaj kaybolmasın: komut yine kaydedilir, kural
      // tabanlı ayrıştırıcı devreye girer (eski davranış), yanıt olarak
      // dürüst bir hata metni yazılır. Gerçek sebep (geçersiz anahtar,
      // model bulunamadı, kota vb.) kullanıcıya gösterilmediği için burada
      // loglanmazsa tamamen kayboluyordu.
      console.error(
        "[chat-service] Gemini reasoning failed, falling back to rule-based intent:",
        error instanceof Error ? error.message : error,
      );
      const fallback = await CommandService.submit({
        workspaceId: input.workspaceId,
        source: "WEB",
        rawText: input.message,
        actorType: "USER",
        userId: input.userId,
        knownProjectId: input.projectId,
        ideaId: input.ideaId,
        attachments: input.attachments,
      });
      const reply =
        fallback.status === "PLANNED"
          ? "Talebinizi görev olarak aldım. (Yapay zekâ yanıtı şu an üretilemedi, iş yine de kuyruğa girdi.)"
          : `Şu anda yanıt üretemiyorum: ${error instanceof Error ? error.message : "bilinmeyen hata"}. Lütfen tekrar deneyin.`;
      const status: CommandReplyStatus =
        fallback.status === "PLANNED" ? "PLANNED" : "ERROR";
      await CommandRepository.recordReply(fallback.commandId, reply, status);
      return { commandId: fallback.commandId, reply, status };
    }

    // LLM'in kararını CommandService'in anladığı niyete çevir. TASK için
    // taskBrief kullanılır (sohbet bağlamı gömülü); yoksa ham mesaj.
    const intent = toParsedIntent(turn, input.message);

    const submission = await CommandService.submit({
      workspaceId: input.workspaceId,
      source: "WEB",
      rawText: input.message,
      actorType: "USER",
      userId: input.userId,
      knownProjectId: input.projectId,
      ideaId: input.ideaId,
      attachments: input.attachments,
      intent,
    });

    let reply = turn.reply.trim() || "Aldım.";
    let status: CommandReplyStatus;

    switch (submission.status) {
      case "PLANNED":
        status = "PLANNED";
        if (submission.requiresApproval) {
          reply += "\n\nBu iş kritik olduğu için önce onayınıza gelecek.";
        }
        break;
      case "APPROVAL_HANDLED":
        status = "APPROVAL_HANDLED";
        break;
      case "NEEDS_PROJECT":
        // knownProjectId her zaman verildiği için pratikte oluşmaz.
        status = "NEEDS_PROJECT";
        break;
      default:
        status = turn.intentKind === "UNCLEAR" ? "UNCLEAR" : "ANSWERED";
        break;
    }

    await CommandRepository.recordReply(submission.commandId, reply, status);
    return { commandId: submission.commandId, reply, status };
  },
};

function toParsedIntent(turn: ChatTurnOutput, message: string): ParsedIntent {
  if (turn.intentKind === "TASK" && turn.capability) {
    return {
      kind: "CAPABILITY",
      capability: turn.capability,
      targetPlatform: turn.platform,
      request: turn.taskBrief?.trim() || message,
    };
  }
  if (turn.intentKind === "APPROVAL" && turn.approvalDecision) {
    return {
      kind: "APPROVAL_DECISION",
      decision: turn.approvalDecision,
      note: turn.approvalDecision === "REVISE" ? message : undefined,
    };
  }
  // ANSWER ve UNCLEAR görev açmaz — CommandService komutu kaydeder ve
  // UNKNOWN_INTENT döner; yanıt zaten LLM'den geldi.
  return { kind: "UNKNOWN" };
}

const HISTORY_TURNS = 12;

async function buildContext(projectId: string, ideaId?: string) {
  const [project, dossier, constitution, dailyStat, pendingApprovals, recent] =
    await Promise.all([
      prisma.project.findUniqueOrThrow({
        where: { id: projectId },
        select: {
          name: true,
          domain: true,
          status: true,
          language: true,
          country: true,
          brands: { where: { isDefault: true }, select: { id: true }, take: 1 },
        },
      }),
      prisma.brandDossier.findFirst({
        where: { projectId },
        select: { summary: true, positioning: true, toneOfVoice: true },
      }),
      prisma.brandConstitution.findFirst({
        where: { projectId, status: "ACTIVE" },
        orderBy: { version: "desc" },
        select: { summary: true },
      }),
      latestDailyStat(projectId),
      prisma.approval.findMany({
        where: { projectId, status: "PENDING" },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: { type: true, entityType: true, createdAt: true },
      }),
      // Bir fikrin sohbet iş parçacığında geçmiş, o fikre ait TÜM
      // mesajlardır — kullanıcının yazdıkları (WEB) ve pipeline'ın
      // yazdığı sistem olayları (SYSTEM: konsey kararı, iş planı, görev/
      // kreatif tamamlanması). Böylece LLM az önce pipeline'ın ne
      // yaptığını bilerek yanıt verir. ideaId yoksa (proje-geneli sohbet)
      // eski davranış korunur: yalnızca WEB.
      prisma.command.findMany({
        where: ideaId
          ? { ideaId, source: { in: ["WEB", "SYSTEM"] } }
          : { projectId, source: "WEB" },
        orderBy: { createdAt: "desc" },
        take: HISTORY_TURNS,
        select: {
          source: true,
          rawText: true,
          replyText: true,
          attachments: true,
        },
      }),
    ]);

  const brandId = project.brands[0]?.id;
  if (!brandId) {
    throw new Error(`Project ${projectId} has no default brand`);
  }

  // En yeni kayıt en üstte geldi; sohbet kronolojik okunur. SYSTEM
  // kaynaklı satırların rawText'i boş (pipeline olayı, kullanıcı mesajı
  // değil) — "Client:" satırı atlanır, yalnızca olay notu yazılır.
  const history = recent
    .reverse()
    .flatMap((command) => {
      const attachmentNote = Array.isArray(command.attachments)
        ? ` [${(command.attachments as { filename?: string }[])
            .map((a) => a.filename ?? "dosya")
            .join(", ")} ekli]`
        : "";
      if (command.source === "SYSTEM") {
        return command.replyText ? [`System: ${command.replyText}`] : [];
      }
      const lines = [`Client: ${command.rawText}${attachmentNote}`];
      if (command.replyText) lines.push(`You: ${command.replyText}`);
      return lines;
    })
    .join("\n");

  return {
    brandId,
    project: {
      name: project.name,
      domain: project.domain,
      status: project.status,
      language: project.language,
      country: project.country,
    },
    brand: {
      summary: constitution?.summary ?? dossier?.summary,
      positioning: dossier?.positioning,
      toneOfVoice: dossier?.toneOfVoice,
    },
    state: dailyStat,
    pending: pendingApprovals.map((approval) => ({
      type: approval.type,
      entityType: approval.entityType,
      waitingSince: approval.createdAt.toISOString(),
    })),
    history,
  };
}

async function latestDailyStat(projectId: string) {
  const stat = await prisma.agencyDailyStat.findFirst({
    where: { projectId },
    orderBy: { date: "desc" },
    select: {
      date: true,
      signalsIngested: true,
      opportunitiesCreated: true,
      ideasCreated: true,
      tasksCreated: true,
    },
  });
  if (!stat) return null;
  return { ...stat, date: stat.date.toISOString().slice(0, 10) };
}
