import "server-only";

import { prisma } from "@/lib/prisma";

// Is this creative Work-owned, i.e. under the Works publish rules (hold rule,
// queue skip)? A creative belongs to a Work through the plan Command that
// created it (Creative.planId -> Command.workId).
//
// Fail closed: deleting a Work deletes its plan Commands, so a missing Command
// must keep the piece under the Works rules. Returning "not owned" there would
// silently turn the hold off and "approved + no time" would go back to
// "publish now". A Command without a workId is a legacy plan: not owned.
export async function workOwnershipOf(
  creativeId: string,
): Promise<{ owned: boolean; workId: string | null }> {
  const creative = await prisma.creative.findUnique({
    where: { id: creativeId },
    select: { planId: true },
  });
  if (!creative?.planId) return { owned: false, workId: null };

  const command = await prisma.command.findUnique({
    where: { id: creative.planId },
    select: { workId: true },
  });
  if (!command) return { owned: true, workId: null };
  if (command.workId) return { owned: true, workId: command.workId };
  return { owned: false, workId: null };
}

// The same decision for many plan ids in ONE query (the publish queue). The
// result holds the ids that are Work-owned; a plan id with no Command row is
// owned (fail closed), a Command without a workId is not.
export async function ownedPlanIds(
  planIds: readonly string[],
): Promise<Set<string>> {
  const unique = [...new Set(planIds)];
  if (unique.length === 0) return new Set();
  const rows = await prisma.command.findMany({
    where: { id: { in: unique } },
    select: { id: true, workId: true },
  });
  const legacy = new Set(
    rows.filter((row) => row.workId === null).map((row) => row.id),
  );
  return new Set(unique.filter((id) => !legacy.has(id)));
}
