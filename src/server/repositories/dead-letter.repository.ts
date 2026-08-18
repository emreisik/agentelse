import "server-only";

import { prisma } from "@/lib/prisma";
import {
  classifyError,
  isAutoRecoverable,
} from "@/server/observability/error-classifier";
import { sendTelegramMessage } from "@/server/notifications/telegram.service";

// Telegram'ın HTML parse_mode'u için: mesaj içeriği sağlayıcı hata
// metinlerinden geliyor, kaçırılmazsa `<`/`>` içeren bir hata mesajı
// bozuk/parse edilemeyen bir bildirime yol açar.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export const DeadLetterRepository = {
  async create(input: {
    executionJobId?: string;
    reason: string;
    payload: unknown;
    attempts: number;
    lastError?: string;
  }) {
    const entry = await prisma.deadLetterJob.create({
      data: {
        executionJobId: input.executionJobId,
        reason: input.reason,
        payload: input.payload as never,
        attempts: input.attempts,
        lastError: input.lastError,
      },
    });

    // Geçici hatalar (RETRY/RETRY_AFTER_COOLDOWN) SelfHealingService
    // tarafından sessizce çözülür — sadece insan müdahalesi gerektirenler
    // Telegram'a düşer, aksi halde her yeniden deneme spam üretir.
    const classification = classifyError(input.lastError);
    if (!isAutoRecoverable(classification)) {
      void sendTelegramMessage(
        [
          `<b>⚠️ Dead letter: ${escapeHtml(input.reason)}</b>`,
          `Kategori: ${classification.category} (${classification.strategy})`,
          classification.summary,
          input.lastError
            ? `Hata: <code>${escapeHtml(input.lastError)}</code>`
            : null,
          input.executionJobId
            ? `ExecutionJob: <code>${input.executionJobId}</code>`
            : null,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }

    return entry;
  },

  listUnresolved() {
    return prisma.deadLetterJob.findMany({
      where: { resolvedAt: null },
      orderBy: { createdAt: "desc" },
    });
  },

  resolve(id: string) {
    return prisma.deadLetterJob.update({
      where: { id },
      data: { resolvedAt: new Date() },
    });
  },
};
