import "server-only";

import type { Prisma } from "@prisma/client";

import { isWorksEnabled } from "./flag";

export type ProductionGateResult = { ok: true } | { ok: false; message: string };

// Defensive Work gate for the plan and package production routes: the cards
// are only offered while a Work is open, but the routes are reachable by id, so
// they re-check it. With Works off this returns before any query, so the
// legacy path is untouched.
export async function worksProductionGate(
  db: Pick<Prisma.TransactionClient, "command" | "work">,
  input: {
    projectId: string;
    commandId: string;
  },
): Promise<ProductionGateResult> {
  if (!isWorksEnabled()) return { ok: true };

  const command = await db.command.findUnique({
    where: { id: input.commandId },
    select: { workId: true },
  });
  if (!command?.workId) return { ok: true };

  const work = await db.work.findFirst({
    where: { id: command.workId, projectId: input.projectId },
    select: { status: true },
  });
  if (!work || work.status !== "ACTIVE") {
    return { ok: false, message: "This Work is completed. Reopen it to continue." };
  }

  return { ok: true };
}
