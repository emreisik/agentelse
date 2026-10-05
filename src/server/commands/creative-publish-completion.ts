import "server-only";

import type { CapabilityKey } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { CreativeRepository } from "@/server/repositories/creative.repository";
import { recordPublishedIdeaLink } from "@/server/agency/learning/post-results";

const PUBLISH_CAPABILITIES: ReadonlySet<CapabilityKey> = new Set<CapabilityKey>(
  [
    "INSTAGRAM_PUBLISH",
    "TIKTOK_PUBLISH",
    "LINKEDIN_PUBLISH",
    "X_PUBLISH",
    "FACEBOOK_PUBLISH",
  ],
);

// Flips a Creative to PUBLISHED once its publish Task actually completes.
// The state machine has always allowed APPROVED -> PUBLISHED
// (state-machine/transitions.ts:135) but nothing ever called it — a publish
// Task never carried a `creativeId` back to its source Creative until
// publish-creative.ts started threading it through payloadExtra alongside
// this handler. Without it a Creative stays APPROVED forever even after a
// real, successful post — invisible in the DB, but also breaks anything
// that later checks `status === "PUBLISHED"` to avoid a duplicate publish.
//
// Must never throw: registered as a generic TASK_COMPLETED handler
// alongside several others with no per-handler isolation
// (continuous-agency-engine.ts) — an uncaught error here would retry (and
// re-run) every other handler for the same trigger up to 5 times.
export const CreativePublishCompletion = {
  async onTaskCompleted(taskId: string): Promise<void> {
    try {
      const task = await prisma.task.findUnique({ where: { id: taskId } });
      if (!task || task.status !== "COMPLETED") return;
      if (!PUBLISH_CAPABILITIES.has(task.capability)) return;

      const payload = (task.payload ?? {}) as Record<string, unknown>;
      // A Facebook share names its piece as `sharedCreativeId`
      // (facebook-share.ts). It is the piece's own publish only when the piece
      // IS a Facebook delivery; a cross-post of another channel's piece (an
      // Instagram post shared to the Page) must not mark it posted, or it
      // would drop out of its own channel's schedule.
      const facebook = task.capability === "FACEBOOK_PUBLISH";
      const key = facebook ? payload.sharedCreativeId : payload.creativeId;
      const creativeId = typeof key === "string" ? key : null;
      if (!creativeId) return;

      const creative = await prisma.creative.findUnique({
        where: { id: creativeId },
        select: { status: true, channel: true },
      });
      if (facebook && creative?.channel !== "facebook") return;
      // Only APPROVED -> PUBLISHED is legal (transitions.ts) — a Creative
      // already PUBLISHED (e.g. a second publish task for the same
      // creative, a different format) or in any other state is left
      // untouched rather than forced. An already PUBLISHED one still gets
      // its idea link if an earlier run could not write it (idempotent).
      if (creative?.status === "PUBLISHED") {
        await recordPublishedIdeaLink({
          workspaceId: task.workspaceId,
          projectId: task.projectId,
          creativeId,
          taskId: task.id,
        });
        return;
      }
      if (!creative || creative.status !== "APPROVED") return;

      await CreativeRepository.transition(
        creativeId,
        task.projectId,
        "PUBLISHED",
      );
      // The pool idea this piece was built from, recorded now: the owner's
      // later "Worked / Didn't work" must still find it if the plan's chat is
      // deleted meanwhile (post-results.ts). Never throws.
      await recordPublishedIdeaLink({
        workspaceId: task.workspaceId,
        projectId: task.projectId,
        creativeId,
        taskId: task.id,
      });
    } catch (error) {
      console.error(
        "[creative-publish-completion] onTaskCompleted failed:",
        error,
      );
    }
  },
};
