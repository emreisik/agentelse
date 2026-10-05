"use server";

import { prisma } from "@/lib/prisma";
import { isRateLimited } from "@/lib/rate-limit";
import { isPostVerdict } from "@/lib/post-results";
import { recordPostVerdict } from "@/server/agency/learning/post-results";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";

// The owner's verdict on a published post ("Worked" / "Didn't work"), from its
// card or the "See results" dialog. The post is looked up first and access is
// checked against ITS project, like the post rating.

const RATE = { key: "post-result", max: 60, windowMs: 10 * 60_000 };
const MAX_NOTE_CHARS = 200;
const FAILED = "That didn't work. Try again.";

export type PostVerdictResult =
  { ok: true; ideaLearned: boolean } | { ok: false; message: string };

export async function recordPostVerdictAction(input: {
  creativeId: string;
  verdict: string;
  note?: string;
}): Promise<PostVerdictResult> {
  try {
    if (!isPostVerdict(input?.verdict)) return { ok: false, message: FAILED };
    const creativeId = input.creativeId;
    if (
      typeof creativeId !== "string" ||
      !creativeId ||
      creativeId.length > 64
    ) {
      return { ok: false, message: "That post isn't available." };
    }
    const creative = await prisma.creative.findUnique({
      where: { id: creativeId },
      select: { projectId: true },
    });
    if (!creative) return { ok: false, message: "That post isn't available." };
    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, creative.projectId);
    if (isRateLimited(`${RATE.key}:${userId}`, RATE.max, RATE.windowMs)) {
      return { ok: false, message: "Slow down for a moment." };
    }
    const note =
      typeof input.note === "string"
        ? input.note.replace(/\s+/g, " ").trim().slice(0, MAX_NOTE_CHARS) ||
          undefined
        : undefined;

    const result = await recordPostVerdict({
      workspaceId: access.workspaceId,
      projectId: creative.projectId,
      brandId: access.defaultBrandId,
      userId,
      creativeId,
      verdict: input.verdict,
      note,
    });
    if (!result.ok) {
      return {
        ok: false,
        message:
          result.reason === "NOT_PUBLISHED"
            ? "Results can be marked once the post is published."
            : "That post isn't available.",
      };
    }
    // No revalidatePath: re-rendering the chat page while the results dialog
    // is open would remount it. The views refresh the page themselves when it
    // is safe (post-result.tsx onRecorded).
    return { ok: true, ideaLearned: result.ideaLearned };
  } catch (error) {
    console.error(
      "[post-result] failed:",
      error instanceof Error ? error.message : error,
    );
    return { ok: false, message: FAILED };
  }
}
