import "server-only";

import { prisma } from "@/lib/prisma";
import {
  classifyError,
  isAutoRecoverable,
} from "@/server/observability/error-classifier";
import { sendTelegramMessage } from "@/server/notifications/telegram.service";

// For Telegram's HTML parse_mode: message content comes from provider
// error text, and without escaping, an error message containing `<`/`>`
// would produce a broken/unparseable notification.
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

    // Transient errors (RETRY/RETRY_AFTER_COOLDOWN) are resolved silently by
    // SelfHealingService — only ones requiring human intervention are sent
    // to Telegram, otherwise every retry would generate spam.
    const classification = classifyError(input.lastError);
    if (!isAutoRecoverable(classification)) {
      void sendTelegramMessage(
        [
          `<b>⚠️ Dead letter: ${escapeHtml(input.reason)}</b>`,
          `Category: ${classification.category} (${classification.strategy})`,
          classification.summary,
          input.lastError
            ? `Error: <code>${escapeHtml(input.lastError)}</code>`
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
