import "server-only";

import type { CommandSource } from "@prisma/client";

import { prisma } from "@/lib/prisma";

// Bir sohbet turuna iliştirilen dosya. Asset satırına yumuşak referans:
// gerçek FK yok, çünkü Command çok kiracılı ve ekler proje silinirken
// Asset temizliğiyle birlikte gidiyor.
export type CommandAttachment = {
  assetId: string;
  filename: string;
  mimeType: string;
  size: number;
};

// Asistanın bir tura verdiği yanıtın sonucu.
export type CommandReplyStatus =
  | "PLANNED" // görev oluşturuldu
  | "ANSWERED" // soruya yanıt verildi, iş açılmadı
  | "APPROVAL_HANDLED" // bekleyen onay bu mesajla karara bağlandı
  | "NEEDS_PROJECT" // proje çözülemedi (sohbet yüzeyinde oluşmaz)
  | "UNCLEAR" // niyet anlaşılamadı, soru soruldu
  | "ERROR"; // yanıt üretilirken hata

export const CommandRepository = {
  create(input: {
    workspaceId: string;
    projectId?: string;
    brandId?: string;
    ideaId?: string;
    source: CommandSource;
    rawText: string;
    parsedIntent?: unknown;
    createdByUserId?: string;
    attachments?: CommandAttachment[];
  }) {
    const { attachments, parsedIntent, ...rest } = input;
    return prisma.command.create({
      data: {
        ...rest,
        parsedIntent: parsedIntent as never,
        attachments: (attachments?.length ? attachments : undefined) as never,
      },
    });
  },

  attachParsedIntent(
    id: string,
    parsedIntent: unknown,
    projectId?: string,
    brandId?: string,
  ) {
    return prisma.command.update({
      where: { id },
      data: { parsedIntent: parsedIntent as never, projectId, brandId },
    });
  },

  recordReply(id: string, replyText: string, replyStatus: CommandReplyStatus) {
    return prisma.command.update({
      where: { id },
      data: { replyText, replyStatus },
    });
  },
};
