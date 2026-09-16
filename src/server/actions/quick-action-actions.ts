"use server";

import {
  requireUser,
  requireProjectAccess,
} from "@/server/security/tenant-context";
import {
  submitCreateSocialCreativeQuickAction,
  type QuickActionPlatform,
} from "@/server/commands/quick-action";
import type { ChatMessageResult } from "@/server/actions/command-actions";

export type { QuickActionPlatform };

// The chat composer's quick-action buttons (see chat-quick-actions.tsx) —
// same auth shape as publish-actions.ts's publishCreativeToInstagramAction,
// but for starting a new creative rather than publishing an existing one.
export async function submitCreateSocialCreativeQuickActionAction(
  projectId: string,
  platform: QuickActionPlatform,
  ideaId?: string,
): Promise<ChatMessageResult> {
  const { userId } = await requireUser();
  const access = await requireProjectAccess(userId, projectId);

  return submitCreateSocialCreativeQuickAction({
    platform,
    workspaceId: access.workspaceId,
    projectId,
    ideaId,
    actorUserId: userId,
  });
}
