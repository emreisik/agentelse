import "server-only";

import { prisma } from "@/lib/prisma";

// Card kinds of a chat row whose work is still in flight (the chat polls while
// one is on screen, see package-run.ts needsProgressPoll).
export const IN_FLIGHT_CARD_KINDS: ReadonlySet<string> = new Set([
  "creative-loading",
  "task-running",
]);

// Upper bound on the in-flight rows one poll may ask about.
export const MAX_PROGRESS_IDS = 50;

// The timestamps come from two clocks (the app's for @updatedAt, the
// database's for createdAt): a change this close to the render counts as after
// it, at worst one extra refresh.
const CLOCK_SKEW_MS = 2_000;

function cardKindOf(parsedIntent: unknown): string | undefined {
  if (!parsedIntent || typeof parsedIntent !== "object") return undefined;
  const card = (parsedIntent as { card?: unknown }).card;
  if (!card || typeof card !== "object") return undefined;
  const kind = (card as { kind?: unknown }).kind;
  return typeof kind === "string" ? kind : undefined;
}

// Whether the chat page rendered at `since` is out of date: a task or a
// creative of the project changed after it, a chat row was posted after it, or
// one of the rows it showed in flight has settled (those are rewritten in place
// and carry no update time, so the page names them). Reads ids only: the chat
// polls this instead of re-rendering the whole page every few seconds.
export async function hasChatProgressSince(
  projectId: string,
  since: Date,
  inFlightCommandIds: readonly string[],
): Promise<boolean> {
  const after = new Date(since.getTime() - CLOCK_SKEW_MS);
  const ids = [...new Set(inFlightCommandIds)].slice(0, MAX_PROGRESS_IDS);
  const [task, creative, command, inFlight] = await Promise.all([
    prisma.task.findFirst({
      where: { projectId, updatedAt: { gt: after } },
      select: { id: true },
    }),
    prisma.creative.findFirst({
      where: { projectId, updatedAt: { gt: after } },
      select: { id: true },
    }),
    prisma.command.findFirst({
      where: { projectId, createdAt: { gt: after } },
      select: { id: true },
    }),
    ids.length > 0
      ? prisma.command.findMany({
          where: { id: { in: ids }, projectId },
          select: { parsedIntent: true },
        })
      : Promise.resolve([]),
  ]);
  if (task || creative || command) return true;
  // A row that is gone (its Work deleted) or is no longer in flight.
  if (inFlight.length < ids.length) return true;
  return inFlight.some(
    (row) => !IN_FLIGHT_CARD_KINDS.has(cardKindOf(row.parsedIntent) ?? ""),
  );
}
