import "server-only";

import { getBillingConfig } from "./config";
import { estimateChatRoundMicros } from "./cost-estimate";
import { beginOperation, type Operation } from "./operation";

// Plan allowance gate for ONE model round of a chat turn. A turn is several
// rounds (the model answers, calls tools, answers again); each round reserves its
// own maximum, runs, and is charged what it actually cost, so a person who runs
// out mid-turn stops at a round boundary with everything the earlier rounds did
// already saved, not in the middle of a reply.
//
// Returns undefined while billing is off (nothing is computed, nothing is read).
// Throws QuotaExceededError / NoPlanError when the plan cannot pay for the round:
// the chat shows the allowance card (limit-notice.ts).
export async function beginChatRound(input: {
  workspaceId: string;
  projectId: string;
  userId: string;
  // One per turn, shared by its rounds (groups their UsageEntry rows).
  operationId: string;
  round: number;
  model: string;
  instructions: string;
  conversation: unknown;
  maxOutputTokens: number;
  webSearch: boolean;
}): Promise<Operation | undefined> {
  if (getBillingConfig().mode === "off") return undefined;
  return beginOperation({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    userId: input.userId,
    module: "CHAT",
    source: "chat",
    purpose: "chat.turn",
    operationId: input.operationId,
    attemptToken: `round${input.round}`,
    reserve: {
      AI_MICROS: estimateChatRoundMicros({
        model: input.model,
        instructions: input.instructions,
        conversation: input.conversation,
        maxOutputTokens: input.maxOutputTokens,
        webSearch: input.webSearch,
      }),
    },
    requireAccess: true,
  });
}
