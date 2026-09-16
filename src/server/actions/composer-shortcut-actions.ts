"use server";

import type { CapabilityKey, SocialPlatform } from "@prisma/client";

import {
  requireUser,
  requireProjectAccess,
} from "@/server/security/tenant-context";
import { submitComposerShortcut } from "@/server/commands/composer-shortcut";
import type { ChatMessageResult } from "@/server/actions/command-actions";

// The chat composer's "+" menu (see composer-plus-menu.tsx /
// src/lib/composer-shortcuts.ts) — same auth shape as
// publish-actions.ts/quick-action-actions.ts, generalized to any capability
// the menu offers instead of one hardcoded capability.
export async function submitComposerShortcutAction(
  projectId: string,
  capability: CapabilityKey,
  request: string,
  targetPlatform?: SocialPlatform,
  ideaId?: string,
): Promise<ChatMessageResult> {
  const { userId } = await requireUser();
  const access = await requireProjectAccess(userId, projectId);

  return submitComposerShortcut({
    capability,
    request,
    targetPlatform,
    workspaceId: access.workspaceId,
    projectId,
    ideaId,
    actorUserId: userId,
  });
}
