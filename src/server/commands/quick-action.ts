import "server-only";

import type { SocialPlatform } from "@prisma/client";

import { CommandService } from "@/server/commands/command-service";
import { CommandRepository } from "@/server/repositories/command.repository";
import type { ChatMessageResult } from "@/server/actions/command-actions";

export type QuickActionPlatform = "instagram" | "linkedin" | "x";

// The exact chat message text for each platform — kept as a lookup rather
// than a generic "Create a {label} post" template because "a"/"an" differs
// per platform (Instagram, X). project-chat.tsx's QUICK_ACTION_REQUEST_TEXT
// mirrors this exactly for the optimistic local bubble; kept in sync by
// hand since a server-only module's runtime values can't be imported into
// a client component.
const REQUEST_TEXT: Record<QuickActionPlatform, string> = {
  instagram: "Create an Instagram post",
  linkedin: "Create a LinkedIn post",
  x: "Create an X post",
};

const PLATFORM_LABEL: Record<QuickActionPlatform, string> = {
  instagram: "Instagram",
  linkedin: "LinkedIn",
  x: "X",
};

const TARGET_PLATFORM: Record<QuickActionPlatform, SocialPlatform> = {
  instagram: "INSTAGRAM",
  linkedin: "LINKEDIN",
  x: "X",
};

// The composer's integration quick-action shortcuts (see the "+" menu
// comment on SubmitCommandInput.intent in command-service.ts) — same
// "already know the intent precisely, skip the LLM" pattern as
// publish-creative.ts's publishCreativeCore/publishCreativeToSocialCore,
// but for STARTING a new creative instead of publishing an existing one.
// TikTok is deliberately not offered here (see chat-quick-actions.tsx):
// CREATE_SOCIAL_CREATIVE only produces an image, but TIKTOK_PUBLISH
// requires a video asset.
export async function submitCreateSocialCreativeQuickAction(input: {
  platform: QuickActionPlatform;
  workspaceId: string;
  projectId: string;
  ideaId?: string;
  actorUserId: string;
}): Promise<ChatMessageResult> {
  const label = PLATFORM_LABEL[input.platform];
  const request = REQUEST_TEXT[input.platform];

  const submission = await CommandService.submit({
    workspaceId: input.workspaceId,
    source: "WEB",
    rawText: request,
    actorType: "USER",
    userId: input.actorUserId,
    knownProjectId: input.projectId,
    ideaId: input.ideaId,
    departmentKey: "SOCIAL_MEDIA",
    intent: {
      kind: "CAPABILITY",
      capability: "CREATE_SOCIAL_CREATIVE",
      targetPlatform: TARGET_PLATFORM[input.platform],
      request,
    },
  });

  if (submission.status !== "PLANNED") {
    const message = "Couldn't start creative generation.";
    await CommandRepository.recordReply(submission.commandId, message, "ERROR");
    return { ok: false, message };
  }

  // No card is posted here — the creative pipeline's own "loading" card
  // (execution-service.ts, ExecutionPolicy.isCreative) appears through the
  // normal task-dispatch flow, identical to when the LLM chat path selects
  // this same capability. Adding one here would show it twice (see
  // task.repository.ts's isCreative-skip comment for the same reasoning).
  const reply = `Creating your ${label} post now.`;
  await CommandRepository.recordReply(submission.commandId, reply, "PLANNED");
  return {
    ok: true,
    commandId: submission.commandId,
    reply,
    attachments: [],
  };
}
