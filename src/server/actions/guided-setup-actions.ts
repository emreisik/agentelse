"use server";

import { randomBytes } from "node:crypto";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { RATE, type ApplyResult } from "@/lib/guided-setup/contract";
import { isRateLimited } from "@/lib/rate-limit";
import { applyGuidedSetup } from "@/server/guided-setup/apply";
import { isGuidedSetupEnabled } from "@/server/guided-setup/flag";
import { resolveGoalMode } from "@/server/guided-setup/goal-mode";
import { getChannelConnections } from "@/server/integrations/channel-connections";
import { ensureProjectActive } from "@/server/projects/activation";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";

// Approve: the ONLY Server Action of guided setup (spec 7.3). Every export of a
// "use server" file is a public endpoint, so this file exports exactly one
// function (guard G67) and no type. It accepts no answer text at all: what gets
// saved is the plan built from the stored session, at the revision the person
// reviewed.

// A Server Action argument arrives in an RSC payload and can be any type (the
// body limit is 100 MB): check the shape before anything is read.
const ArgsSchema = z.object({
  projectId: z.string().min(1).max(64),
  expectedRev: z.string().min(6).max(32),
});

const MESSAGE = {
  failed: "Couldn't save your setup. Try again.",
  disabled: "Guided setup isn't available.",
  rate: "You've saved this setup many times today. Try again tomorrow.",
} as const;

function refuse(
  code: "FAILED" | "DISABLED" | "RATE",
  message: string,
): ApplyResult {
  return { ok: false, code, message, saved: [], failed: [] };
}

export async function applyGuidedSetupAction(
  projectId: string,
  expectedRev: string,
): Promise<ApplyResult> {
  const args = ArgsSchema.safeParse({ projectId, expectedRev });
  if (!args.success) return refuse("FAILED", MESSAGE.failed);

  try {
    // A public POST: the flag is re-checked here, hiding the button is not a
    // security boundary.
    if (!isGuidedSetupEnabled()) return refuse("DISABLED", MESSAGE.disabled);

    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, args.data.projectId);

    // In-memory and per instance; the durable per-project cap is in the saga.
    if (
      isRateLimited(
        `guided-apply:${userId}:${args.data.projectId}`,
        RATE.applyPerMinute,
        60_000,
      )
    ) {
      return refuse("RATE", MESSAGE.rate);
    }

    const result = await applyGuidedSetup(
      {
        access: {
          userId,
          workspaceId: access.workspaceId,
          projectId: args.data.projectId,
          ...(access.defaultBrandId
            ? { defaultBrandId: access.defaultBrandId }
            : {}),
        },
        userId,
        expectedRev: args.data.expectedRev,
      },
      {
        nowMs: () => Date.now(),
        // One per Approve call: identifies THIS run in the session row.
        token: randomBytes(6).toString("hex"),
        // Injected so the saga's imports (and write surface) stay enumerable.
        ensureActive: ensureProjectActive,
        channelConnections: getChannelConnections,
        goalMode: async (id) => (await resolveGoalMode(id)).mode,
      },
    );

    if (result.ok) {
      // The setup is saved either way: a failing cache purge must not turn it
      // into an error the person would retry.
      try {
        revalidatePath(`/projects/${args.data.projectId}`);
      } catch (error) {
        console.error(
          "[guided-setup] revalidate failed:",
          error instanceof Error ? error.message : error,
        );
      }
    }
    return result;
  } catch (error) {
    // Not found, signed out or an unexpected throw: one generic answer, the
    // message stays in the server log.
    console.error(
      "[guided-setup] apply action failed:",
      error instanceof Error ? error.message : error,
    );
    return refuse("FAILED", MESSAGE.failed);
  }
}
