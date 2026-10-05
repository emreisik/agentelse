import "server-only";

import type { Prisma } from "@prisma/client";

// A post moves as one (docs/works.md "Posts"): its channel deliveries share one
// time. Moving one delivery moves the post's other deliveries that can still
// move, and the post's own time. Refused once part of the post (a delivery not
// left out of it) is posted: a post is never split across two times. A piece
// outside a post moves alone.
export type PostMove =
  | { ok: true; postId: string | null; moved: string[] }
  | { ok: false };

export async function movePostInTx(
  tx: Prisma.TransactionClient,
  input: {
    creativeId: string;
    projectId: string;
    scheduledFor: Date | null;
    // The statuses a delivery can be moved in.
    movable: readonly string[];
  },
): Promise<PostMove> {
  const creative = await tx.creative.findUnique({
    where: { id: input.creativeId },
    select: { postId: true },
  });
  const postId = creative?.postId ?? null;
  if (!postId) return { ok: true, postId: null, moved: [] };

  const siblings = await tx.creative.findMany({
    where: {
      postId,
      projectId: input.projectId,
      id: { not: input.creativeId },
    },
    select: { id: true, status: true, excludedAt: true },
  });
  if (
    siblings.some(
      (sibling) => !sibling.excludedAt && sibling.status === "PUBLISHED",
    )
  ) {
    return { ok: false };
  }
  const moved = siblings
    .filter((sibling) => input.movable.includes(sibling.status))
    .map((sibling) => sibling.id);
  if (moved.length > 0) {
    await tx.creative.updateMany({
      where: { id: { in: moved }, projectId: input.projectId },
      data: { scheduledFor: input.scheduledFor },
    });
  }
  await tx.post.update({
    where: { id: postId },
    data: { scheduledFor: input.scheduledFor },
  });
  return { ok: true, postId, moved };
}
