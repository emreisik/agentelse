import "server-only";

import type { SocialPlatform } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { ApprovalRepository } from "@/server/repositories/approval.repository";

// A saved content plan leaves one empty DRAFT Creative per calendar slot
// (saveContentPlanAction). Producing a slot (plan-run.ts) sends the job's
// Task.payload.planCreativeId; when the job finishes, the result lands IN that
// slot instead of spawning a second Creative, so the calendar entry, its
// channel, goal, plan and planned time all stay on the piece that was made.
// Anything else (a plain generate_image, a package item) has no planCreativeId
// and goes the ordinary way.

export function planCreativeIdOf(payload: unknown): string | undefined {
  const id = (payload as { planCreativeId?: unknown } | null)?.planCreativeId;
  return typeof id === "string" && id !== "" ? id : undefined;
}

// Takes the slot for this job: only an empty DRAFT of the same project can be
// taken, and the conditional update makes it atomic, so a slot can never be
// filled twice (a retry, or a second job that raced). null = no slot to fill;
// the caller creates a Creative as usual.
export async function claimPlanCreative(input: {
  taskId: string;
  projectId: string;
}): Promise<{
  id: string;
  platform: SocialPlatform | null;
  postId: string | null;
} | null> {
  const task = await prisma.task.findUnique({
    where: { id: input.taskId },
    select: { payload: true },
  });
  const creativeId = planCreativeIdOf(task?.payload);
  if (!creativeId) return null;

  const claimed = await prisma.creative.updateMany({
    where: {
      id: creativeId,
      projectId: input.projectId,
      status: "DRAFT",
      currentVersionId: null,
    },
    data: { status: "IN_REVIEW", createdByTaskId: input.taskId },
  });
  if (claimed.count !== 1) return null;

  return prisma.creative.findUnique({
    where: { id: creativeId },
    select: { id: true, platform: true, postId: true },
  });
}

// Puts the slot back when what should have filled it could not be written, so
// it shows as a failed/empty slot again instead of "in review" with nothing in
// it.
export async function releasePlanCreative(creativeId: string): Promise<void> {
  await prisma.creative.updateMany({
    where: { id: creativeId, status: "IN_REVIEW", currentVersionId: null },
    data: { status: "DRAFT", createdByTaskId: null },
  });
}

// A finished text job (Reel/TikTok script, LinkedIn or X post, article, ad
// copy) fills its slot with the text as the first version and opens the same
// approval every creative gets, so the piece goes through review, approval and
// publishing like the image ones. Returns whether a slot was filled.
export async function fillPlanCreativeWithText(input: {
  taskId: string;
  projectId: string;
  text: string;
}): Promise<boolean> {
  const text = input.text.trim();
  if (!text) return false;
  const slot = await claimPlanCreative(input);
  if (!slot) return false;

  try {
    const [creative, task] = await Promise.all([
      prisma.creative.findUniqueOrThrow({
        where: { id: slot.id },
        select: { workspaceId: true, projectId: true, brandId: true },
      }),
      prisma.task.findUnique({
        where: { id: input.taskId },
        select: { createdByType: true },
      }),
    ]);
    const version = await prisma.creativeVersion.create({
      data: {
        creativeId: slot.id,
        version: 1,
        copy: text,
        generationProvider: "plan-run",
        generationMetadata: { taskId: input.taskId } as never,
      },
    });
    await prisma.creative.update({
      where: { id: slot.id },
      data: { currentVersionId: version.id },
    });
    await ApprovalRepository.create({
      workspaceId: creative.workspaceId,
      projectId: creative.projectId,
      brandId: creative.brandId,
      taskId: input.taskId,
      entityType: "Creative",
      entityId: slot.id,
      type: "CREATIVE_APPROVAL",
      requestedByType: "AI",
      notify: task?.createdByType !== "SYSTEM",
    });
    return true;
  } catch (error) {
    await releasePlanCreative(slot.id).catch(() => undefined);
    throw error;
  }
}
