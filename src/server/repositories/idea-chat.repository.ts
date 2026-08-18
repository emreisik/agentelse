import "server-only";

import type { DepartmentKey, RiskLevel } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import type { CommandAttachment } from "./command.repository";
import type { CreativeCardData } from "@/types/creative-card";
import type { IdeaEventCardData } from "@/types/idea-event-card";

// Ajans pipeline'ının (konsey değerlendirmesi, iş planına dönüşüm, görev/
// kreatif tamamlanması) bir fikrin sohbet iş parçacığına yazdığı sistem
// mesajları — kullanıcının o fikirle ilgili yazdığı gerçek mesajlarla
// (source: WEB) AYNI ideaId altında birikir, tek bir sohbet akışı
// oluşturur (bkz. Command.ideaId). Çağıranlar bu yazmayı try/catch ile
// sarmalı: bir sohbet mesajının yazılamaması, altındaki asıl iş mantığını
// (fikir/konsey/iş planı/görev) ASLA durdurmamalı.
export const IdeaChatRepository = {
  postSystemMessage(input: {
    workspaceId: string;
    projectId: string;
    ideaId: string;
    text: string;
    attachments?: CommandAttachment[];
    card?: IdeaEventCardData;
    // Yalnızca TEK bir departmana bağlı olayları (görev/kreatif) işaretler
    // — sohbet ekranında departman renginde bir kenar şeridi olarak
    // gösterilir (bkz. project-chat.tsx, assistant-ui/thread.tsx).
    // Konsey/iş-planı gibi çoklu-departman olaylarında verilmez.
    departmentKey?: DepartmentKey;
    // Köken zinciri (Sinyal/Bulgu/İçgörü-Fırsat) geriye dönük yazılırken
    // her adımın KENDİ gerçek oluşturulma anıyla görünmesi için — verilmezse
    // Command.createdAt'in @default(now()) davranışı korunur.
    createdAt?: Date;
  }) {
    const parsedIntent =
      input.card || input.departmentKey
        ? { card: input.card, departmentKey: input.departmentKey }
        : undefined;
    return prisma.command.create({
      data: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        ideaId: input.ideaId,
        source: "SYSTEM",
        rawText: "",
        replyText: input.text,
        replyStatus: "ANSWERED",
        attachments: (input.attachments?.length
          ? input.attachments
          : undefined) as never,
        parsedIntent: parsedIntent as never,
        ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      },
    });
  },

  // Bir kreatif üretimi başladığında sohbete "yükleniyor" kartı düşer
  // (ChatGPT'nin görsel üretirken gösterdiği bekleme durumu gibi). Fikre
  // bağlanamayan görevlerde (ideaId çözülemezse) sessizce atlanır.
  async postCreativeLoadingCard(input: {
    workspaceId: string;
    projectId: string;
    taskId: string;
    title: string;
    departmentKey?: DepartmentKey;
  }): Promise<void> {
    const ideaId = await IdeaChatRepository.resolveIdeaIdForTask(input.taskId);
    if (!ideaId) return;
    await IdeaChatRepository.postSystemMessage({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      ideaId,
      text: `🎨 Görsel oluşturuluyor: ${input.title}`,
      card: {
        kind: "creative-loading",
        taskId: input.taskId,
        title: input.title,
      },
      departmentKey: input.departmentKey,
    });
  },

  // Bir kreatif üretimi bitince (başarılı ya da başarısız) o task için
  // AYNI yükleniyor kartını sonuca günceller — sayfa yenilendiğinde/yeniden
  // ziyaret edildiğinde "yükleniyor" hiç kalıcı olarak takılı kalmaz.
  // Karşılık gelen yükleniyor kartı bulunamazsa (ör. postCreativeLoadingCard
  // o an başarısız olduysa) yeni bir satır olarak düşer — best-effort.
  async resolveCreativeCard(input: {
    workspaceId: string;
    projectId: string;
    taskId: string;
    text: string;
    card: CreativeCardData;
    attachments?: CommandAttachment[];
    departmentKey?: DepartmentKey;
  }): Promise<void> {
    const ideaId = await IdeaChatRepository.resolveIdeaIdForTask(input.taskId);
    if (!ideaId) return;

    const existing = await prisma.command.findFirst({
      where: {
        ideaId,
        source: "SYSTEM",
        parsedIntent: { path: ["card", "taskId"], equals: input.taskId },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });

    if (existing) {
      await prisma.command.update({
        where: { id: existing.id },
        data: {
          replyText: input.text,
          parsedIntent: {
            card: input.card,
            departmentKey: input.departmentKey,
          } as never,
          attachments: (input.attachments?.length
            ? input.attachments
            : undefined) as never,
        },
      });
      return;
    }

    await IdeaChatRepository.postSystemMessage({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      ideaId,
      text: input.text,
      card: input.card,
      attachments: input.attachments,
      departmentKey: input.departmentKey,
    });
  },

  // Kreatif-dışı bir görev RUNNING'e geçtiğinde sohbete "çalışıyor" kartı
  // düşer — kreatif üretimindeki yükleniyor kartıyla aynı görsel dil
  // (bkz. postCreativeLoadingCard), ama TÜM görev tiplerinde: artık
  // "başladı" anı sadece kreatiflerde değil her yerde görünür.
  async postTaskRunningCard(input: {
    workspaceId: string;
    projectId: string;
    taskId: string;
    title: string;
    departmentKey?: DepartmentKey;
  }): Promise<void> {
    const ideaId = await IdeaChatRepository.resolveIdeaIdForTask(input.taskId);
    if (!ideaId) return;
    await IdeaChatRepository.postSystemMessage({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      ideaId,
      text: `⏳ Görev başladı: ${input.title}`,
      card: {
        kind: "task-running",
        taskId: input.taskId,
        title: input.title,
        department: input.departmentKey ?? undefined,
      },
      departmentKey: input.departmentKey,
    });
  },

  // Bir görev tamamlanınca/başarısız/iptal olunca, o görev için AÇIK olan
  // "çalışıyor" kartını (postTaskRunningCard) AYNI satırda sonuca günceller
  // — resolveCreativeCard'ın kreatifler için yaptığının görev-sonucu
  // karşılığı. Karşılık gelen çalışıyor kartı bulunamazsa (ör. hiç
  // RUNNING'e geçmeden tamamlanan/iptal edilen görev) yeni satır düşer.
  async resolveTaskResultCard(input: {
    workspaceId: string;
    projectId: string;
    taskId: string;
    text: string;
    card: Extract<IdeaEventCardData, { kind: "task-result" }>;
    departmentKey?: DepartmentKey;
  }): Promise<void> {
    const ideaId = await IdeaChatRepository.resolveIdeaIdForTask(input.taskId);
    if (!ideaId) return;

    const existing = await prisma.command.findFirst({
      where: {
        ideaId,
        source: "SYSTEM",
        parsedIntent: { path: ["card", "taskId"], equals: input.taskId },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });

    if (existing) {
      await prisma.command.update({
        where: { id: existing.id },
        data: {
          replyText: input.text,
          parsedIntent: {
            card: input.card,
            departmentKey: input.departmentKey,
          } as never,
        },
      });
      return;
    }

    await IdeaChatRepository.postSystemMessage({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      ideaId,
      text: input.text,
      card: input.card,
      departmentKey: input.departmentKey,
    });
  },

  // resolveTaskResultCard'ın yayın (INSTAGRAM_PUBLISH vb.) görevleri için
  // karşılığı — aynı "çalışıyor" kartını sonuca (postId/hata) günceller.
  async resolvePublishResultCard(input: {
    workspaceId: string;
    projectId: string;
    taskId: string;
    text: string;
    card: Extract<IdeaEventCardData, { kind: "publish-result" }>;
    departmentKey?: DepartmentKey;
  }): Promise<void> {
    const ideaId = await IdeaChatRepository.resolveIdeaIdForTask(input.taskId);
    if (!ideaId) return;

    const existing = await prisma.command.findFirst({
      where: {
        ideaId,
        source: "SYSTEM",
        parsedIntent: { path: ["card", "taskId"], equals: input.taskId },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });

    if (existing) {
      await prisma.command.update({
        where: { id: existing.id },
        data: {
          replyText: input.text,
          parsedIntent: {
            card: input.card,
            departmentKey: input.departmentKey,
          } as never,
        },
      });
      return;
    }

    await IdeaChatRepository.postSystemMessage({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      ideaId,
      text: input.text,
      card: input.card,
      departmentKey: input.departmentKey,
    });
  },

  // Bir görev onay gerektirdiği için WAITING_APPROVAL'a düşünce (bkz.
  // TaskPlanner.planForCapability) sohbete Onayla/Reddet düğmeli bir kart
  // düşer — ekran görüntüsündeki tasarımla aynı: "Onay bekliyor" + risk
  // rozeti + açıklama + iki buton (bkz. idea-event-card.tsx
  // ApprovalRequestCard). Karar verilince AYNI satır resolveApprovalDecisionCard
  // ile sonuca güncellenir, düğmeler kaybolur.
  async postApprovalRequestCard(input: {
    workspaceId: string;
    projectId: string;
    taskId: string;
    approvalId: string;
    title: string;
    riskLevel: RiskLevel;
    departmentKey?: DepartmentKey;
  }): Promise<void> {
    const ideaId = await IdeaChatRepository.resolveIdeaIdForTask(input.taskId);
    if (!ideaId) return;
    await IdeaChatRepository.postSystemMessage({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      ideaId,
      text: `⏸️ Onay bekliyor: ${input.title}`,
      card: {
        kind: "approval-request",
        approvalId: input.approvalId,
        taskId: input.taskId,
        title: input.title,
        riskLevel: input.riskLevel,
        department: input.departmentKey ?? undefined,
      },
      departmentKey: input.departmentKey,
    });
  },

  // Bir onay kararı verilince (approve/reject) sohbetteki AÇIK
  // "approval-request" kartını (postApprovalRequestCard) AYNI satırda
  // sonuca günceller — buton çiftinin karardan sonra da orada kalıp tekrar
  // tıklanabilir görünmesini önler. Karşılık gelen istek kartı bulunamazsa
  // (ör. Telegram'dan gelen ya da sohbet dışı bir onay) yeni satır düşer.
  async resolveApprovalDecisionCard(input: {
    workspaceId: string;
    projectId: string;
    ideaId: string;
    approvalId: string;
    text: string;
    card: Extract<IdeaEventCardData, { kind: "approval-decision" }>;
    departmentKey?: DepartmentKey;
  }): Promise<void> {
    const existing = await prisma.command.findFirst({
      where: {
        ideaId: input.ideaId,
        source: "SYSTEM",
        parsedIntent: {
          path: ["card", "approvalId"],
          equals: input.approvalId,
        },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });

    if (existing) {
      await prisma.command.update({
        where: { id: existing.id },
        data: {
          replyText: input.text,
          parsedIntent: {
            card: input.card,
            departmentKey: input.departmentKey,
          } as never,
        },
      });
      return;
    }

    await IdeaChatRepository.postSystemMessage({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      ideaId: input.ideaId,
      text: input.text,
      card: input.card,
      departmentKey: input.departmentKey,
    });
  },

  // Bir kreatif onaylanınca/reddedilince — Task onaylarının aksine — kartı
  // genel bir "approval-decision" kartına ÇEVİRMİYORUZ, çünkü creative-ready
  // kartı zaten görseli/başlığı taşıyor: onu kaybetmemek için AYNI kartın
  // sadece `status` alanı (IN_REVIEW -> APPROVED/REJECTED) güncellenir, kart
  // biçimi (görsel, caption, copy) olduğu gibi kalır. Sohbette karşılık
  // gelen bir creative-ready kartı yoksa (ör. sohbet dışı elle oluşturulmuş
  // kreatif) sessizce atlanır.
  async resolveCreativeApprovalDecision(input: {
    ideaId: string;
    creativeId: string;
    status: "APPROVED" | "REJECTED";
  }): Promise<void> {
    const existing = await prisma.command.findFirst({
      where: {
        ideaId: input.ideaId,
        source: "SYSTEM",
        parsedIntent: {
          path: ["card", "creativeId"],
          equals: input.creativeId,
        },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, parsedIntent: true },
    });
    if (!existing) return;

    const parsed = existing.parsedIntent as {
      card?: { kind?: string; [key: string]: unknown };
      departmentKey?: DepartmentKey;
    } | null;
    if (!parsed?.card || parsed.card.kind !== "creative-ready") return;

    await prisma.command.update({
      where: { id: existing.id },
      data: {
        parsedIntent: {
          card: { ...parsed.card, status: input.status },
          departmentKey: parsed.departmentKey,
        } as never,
      },
    });
  },

  // WorkPlan/Task, fikirsiz akışlarda (elle oluşturma, isMock) ideaId'siz
  // kalabilir — bu durumda null döner, çağıran sohbet mesajı yazmayı/idea
  // sohbetine yönlendirmeyi atlamalı.
  async resolveIdeaIdForWorkPlan(workPlanId: string): Promise<string | null> {
    const workPlan = await prisma.workPlan.findUnique({
      where: { id: workPlanId },
      select: { ideaId: true },
    });
    return workPlan?.ideaId ?? null;
  },

  // Bir görev iki yoldan bir fikre bağlı olabilir: (1) bir iş planının
  // parçasıysa workPlanId -> WorkPlan.ideaId, (2) doğrudan bir fikrin
  // sohbetinden komutla istenmişse (workPlanId yok) commandId ->
  // Command.ideaId. Önce commandId denenir — kullanıcı o fikrin
  // thread'inden yazdıysa görevin "gerçek" bağlamı odur; iş planı
  // zincirine sadece o yol yoksa düşülür.
  async resolveIdeaIdForTask(taskId: string): Promise<string | null> {
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      select: { workPlanId: true, commandId: true },
    });
    if (!task) return null;

    if (task.commandId) {
      const command = await prisma.command.findUnique({
        where: { id: task.commandId },
        select: { ideaId: true },
      });
      if (command?.ideaId) return command.ideaId;
    }

    if (!task.workPlanId) return null;
    return IdeaChatRepository.resolveIdeaIdForWorkPlan(task.workPlanId);
  },
};
