import "server-only";

import type { CapabilityKey } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { CreativeRepository } from "@/server/repositories/creative.repository";

const PUBLISH_CAPABILITIES: ReadonlySet<CapabilityKey> = new Set<CapabilityKey>(
  ["INSTAGRAM_PUBLISH", "TIKTOK_PUBLISH", "LINKEDIN_PUBLISH", "X_PUBLISH"],
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
      const creativeId =
        typeof payload.creativeId === "string" ? payload.creativeId : null;
      if (!creativeId) return;

      const creative = await prisma.creative.findUnique({
        where: { id: creativeId },
        select: { status: true },
      });
      // Only APPROVED -> PUBLISHED is legal (transitions.ts) — a Creative
      // already PUBLISHED (e.g. a second publish task for the same
      // creative, a different format) or in any other state is left
      // untouched rather than forced.
      if (!creative || creative.status !== "APPROVED") return;

      await CreativeRepository.transition(
        creativeId,
        task.projectId,
        "PUBLISHED",
      );
    } catch (error) {
      console.error(
        "[creative-publish-completion] onTaskCompleted failed:",
        error,
      );
    }
  },
};
