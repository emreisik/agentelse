import "server-only";

import type { IntegrationCredential } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { decryptSecret } from "@/server/security/crypto";
import {
  telegramGetUpdates,
  telegramAnswerCallbackQuery,
  telegramEditMessageReplyMarkup,
} from "@/server/integrations/telegram-client";
import { applyApprovalDecision } from "@/server/commands/approval-decisions";
import { publishCreativeCore } from "@/server/commands/publish-creative";
import { isAgentelseError } from "@/server/security/errors";

type TelegramCredentialMetadata = {
  chatId?: string;
  allowedApproverIds?: string[];
  telegramUpdateOffset?: number;
};

const CALLBACK_DATA_RE = /^(approve|reject|pubfeed|pubstory|pubskip):(.+)$/;
const PUBLISH_ACTIONS = new Set(["pubfeed", "pubstory", "pubskip"]);

async function processCredential(
  credential: IntegrationCredential,
): Promise<void> {
  const metadata = (credential.metadata ?? {}) as TelegramCredentialMetadata;
  const allowedApproverIds = metadata.allowedApproverIds ?? [];
  const token = decryptSecret(credential.encryptedSecret);

  const updates = await telegramGetUpdates(
    token,
    metadata.telegramUpdateOffset,
    0,
  );
  if (updates.length === 0) return;

  for (const update of updates) {
    const cq = update.callback_query;
    if (!cq?.data) continue;

    const match = CALLBACK_DATA_RE.exec(cq.data);
    if (!match) continue;
    const [, action, id] = match;
    if (!action || !id) continue;

    if (!allowedApproverIds.includes(String(cq.from.id))) {
      await telegramAnswerCallbackQuery(token, cq.id, {
        text: "You are not authorized for this action",
        showAlert: true,
      }).catch(() => {});
      continue;
    }

    // The "Would you like to share on social media?" question — not tied
    // to a real Approval row (see sendPublishPromptToTelegram), `id` here
    // is the creativeId. Handled separately from approve/reject because,
    // after the decision, it TRIGGERS an INSTAGRAM_PUBLISH task that
    // doesn't exist yet, rather than deciding an existing one.
    if (PUBLISH_ACTIONS.has(action)) {
      const clearKeyboard = () =>
        cq.message
          ? telegramEditMessageReplyMarkup(
              token,
              String(cq.message.chat.id),
              cq.message.message_id,
              null,
            ).catch(() => {})
          : Promise.resolve();

      if (action === "pubskip") {
        await clearKeyboard();
        await telegramAnswerCallbackQuery(token, cq.id, {
          text: "OK, it will not be shared",
        }).catch(() => {});
        continue;
      }

      try {
        const result = await publishCreativeCore({
          creativeId: id,
          format: action === "pubfeed" ? "FEED" : "STORIES",
          workspaceId: credential.workspaceId,
          projectId: credential.projectId,
          actorUserId: `telegram:${cq.from.id}`,
        });
        await clearKeyboard();
        await telegramAnswerCallbackQuery(token, cq.id, {
          text: result.message,
          showAlert: !result.ok,
        }).catch(() => {});
      } catch (error) {
        await telegramAnswerCallbackQuery(token, cq.id, {
          text: error instanceof Error ? error.message : "The action failed",
          showAlert: true,
        }).catch(() => {});
      }
      continue;
    }

    try {
      const approval = await prisma.approval.findFirst({
        where: { id, projectId: credential.projectId },
      });
      if (!approval) {
        await telegramAnswerCallbackQuery(token, cq.id, {
          text: "This approval was not found",
          showAlert: true,
        }).catch(() => {});
        continue;
      }

      await applyApprovalDecision({
        approval,
        to: action === "approve" ? "APPROVED" : "REJECTED",
        reviewedByUserId: `telegram:${cq.from.id}`,
        actorType: "USER",
      });

      await telegramAnswerCallbackQuery(token, cq.id, {
        text: action === "approve" ? "✅ Approved" : "❌ Rejected",
      }).catch(() => {});
    } catch (error) {
      // INVALID_INPUT carries its own plain-language reason (the task cannot
      // run as written); every other AgentelseError here means the approval
      // was already decided.
      // PERMISSION_DENIED: a spending (L4) approval is given in Agentelse by
      // a workspace owner or admin, never from Telegram (docs/meta-ads-plan.md
      // F0b); an expired one says so itself.
      const message = isAgentelseError(error)
        ? error.code === "INVALID_INPUT" ||
          error.code === "PERMISSION_DENIED" ||
          /expired/i.test(error.message)
          ? error.code === "PERMISSION_DENIED"
            ? "Spending is approved in Agentelse by a workspace owner or admin. Open the app to review it."
            : error.message
          : "This approval can no longer be decided (it has probably already been decided)"
        : "The action failed";
      await telegramAnswerCallbackQuery(token, cq.id, {
        text: message,
        showAlert: true,
      }).catch(() => {});
    }
  }

  const maxUpdateId = Math.max(...updates.map((u) => u.update_id));
  await prisma.integrationCredential.update({
    where: { id: credential.id },
    data: {
      metadata: { ...metadata, telegramUpdateOffset: maxUpdateId + 1 },
    },
  });
}

// A step that "free-rides" on the 3s tick in agency-wiring.ts: makes a
// short (non-blocking) `getUpdates` call for every ACTIVE Telegram
// connection and processes the "✅ Approve"/"❌ Reject" callbacks. Each
// credential is processed inside its own try/catch so an error on one
// doesn't affect the others.
export async function pollTelegramApprovals(): Promise<void> {
  const credentials = await prisma.integrationCredential.findMany({
    where: { provider: "telegram", status: "ACTIVE" },
  });

  for (const credential of credentials) {
    try {
      // One process at a time per bot: during a deploy overlap two processes
      // would read the same getUpdates batch and handle each tap twice
      // (docs/meta-ads-plan.md F1).
      if (!(await claimPollLease(credential.id))) continue;
      await processCredential(credential);
    } catch (error) {
      console.error(
        `Telegram approval polling error (credential ${credential.id}):`,
        error,
      );
    }
  }
}

// A 30 s lease on the bot's metadata (compare-and-swap in one statement):
// true when this process may poll now.
const POLL_LEASE_MS = 30_000;

export async function claimPollLease(
  credentialId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const until = new Date(now.getTime() + POLL_LEASE_MS).toISOString();
  const claimed = await prisma.$executeRaw`UPDATE "IntegrationCredential" SET metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{telegramPollLeaseUntil}', to_jsonb(${until}::text)) WHERE id = ${credentialId} AND (metadata->>'telegramPollLeaseUntil' IS NULL OR (metadata->>'telegramPollLeaseUntil')::timestamptz < ${now.toISOString()}::timestamptz)`;
  return claimed === 1;
}
