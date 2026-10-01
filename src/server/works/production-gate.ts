import "server-only";

import type { Prisma } from "@prisma/client";

import { channelListText, parseChannelKeys } from "@/lib/works/work";

import { isWorksEnabled } from "./flag";

// allowedChannels: the Work's channels when it has chosen any (so a caller can
// skip the slots outside them instead of refusing a whole plan).
export type ProductionGateResult =
  | { ok: true; allowedChannels?: readonly string[] }
  | { ok: false; message: string };

export function outsideChannelsMessage(
  allowed: readonly string[],
  outside: readonly string[],
): string {
  return `This Work is for ${channelListText(parseChannelKeys(allowed))}; this plan has pieces on ${outside.join(", ")}.`;
}

// Defensive Work gate for the plan and package production routes: the cards
// are only offered while a Work is open, but the routes are reachable by id, so
// they re-check it. With Works off this returns before any query, so the
// legacy path is untouched.
export async function worksProductionGate(
  db: Pick<Prisma.TransactionClient, "command" | "work">,
  input: {
    projectId: string;
    commandId: string;
    slotChannels?: readonly string[];
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
    select: { status: true, channels: true },
  });
  if (!work || work.status !== "ACTIVE") {
    return { ok: false, message: "This Work is completed. Reopen it to continue." };
  }

  const allowed = parseChannelKeys(work.channels);
  // A Work with no channel chosen yet has nothing to compare against.
  if (input.slotChannels && allowed.length > 0) {
    const outside = input.slotChannels.filter(
      (channel) => !(allowed as readonly string[]).includes(channel),
    );
    if (outside.length > 0) {
      return { ok: false, message: outsideChannelsMessage(allowed, outside) };
    }
  }
  return allowed.length > 0 ? { ok: true, allowedChannels: allowed } : { ok: true };
}
