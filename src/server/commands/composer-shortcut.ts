import "server-only";

import type { CapabilityKey, SocialPlatform } from "@prisma/client";

import { CommandService } from "@/server/commands/command-service";
import { CommandRepository } from "@/server/repositories/command.repository";
import type { ChatMessageResult } from "@/server/actions/command-actions";

// The composer "+" menu's capability shortcuts (see
// src/lib/composer-shortcuts.ts) — the "already know the intent precisely"
// bypass documented on SubmitCommandInput.intent in command-service.ts,
// generalized from quick-action.ts's single-capability version to any
// capability the menu offers.
export async function submitComposerShortcut(input: {
  capability: CapabilityKey;
  request: string;
  targetPlatform?: SocialPlatform;
  workspaceId: string;
  projectId: string;
  ideaId?: string;
  actorUserId: string;
}): Promise<ChatMessageResult> {
  const submission = await CommandService.submit({
    workspaceId: input.workspaceId,
    source: "WEB",
    rawText: input.request,
    actorType: "USER",
    userId: input.actorUserId,
    knownProjectId: input.projectId,
    ideaId: input.ideaId,
    intent: {
      kind: "CAPABILITY",
      capability: input.capability,
      targetPlatform: input.targetPlatform,
      request: input.request,
    },
  });

  if (submission.status !== "PLANNED") {
    const message =
      "Couldn't start this — please try describing it in chat instead.";
    await CommandRepository.recordReply(submission.commandId, message, "ERROR");
    return { ok: false, message };
  }

  // No card posted here — for creative capabilities the "loading" card
  // appears through the normal task-dispatch flow (execution-service.ts,
  // ExecutionPolicy.isCreative), same as the LLM chat path; non-creative
  // capabilities get their result card the same way any other task does.
  const reply = submission.requiresApproval
    ? "Sent for approval."
    : "On it — I'll post the result here.";
  await CommandRepository.recordReply(submission.commandId, reply, "PLANNED");
  return {
    ok: true,
    commandId: submission.commandId,
    reply,
    attachments: [],
  };
}
