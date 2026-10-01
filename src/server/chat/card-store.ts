import "server-only";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import type { IdeaEventCardData } from "@/types/idea-event-card";

// Atomic writer of the card stored on a Command row (parsedIntent.card). Every
// Works card writer goes through it: a Serializable transaction plus a bounded
// retry means two racing writers cannot both apply.

export type CardUpdateResult<C> =
  | { ok: true; card: C; changed: boolean }
  | {
      ok: false;
      code:
        | "NOT_FOUND"
        | "WRONG_KIND"
        | "REJECTED"
        | "WORK_INACTIVE"
        | "CONFLICT"
        | "INVALID";
      message: string;
    };

// A bare card = write the card; null = no write; {reject} = refuse;
// {card, replyText} also rewrites Command.replyText in the same write.
export type CardUpdate =
  | IdeaEventCardData
  | null
  | { reject: string }
  | { card: IdeaEventCardData; replyText: string };

export type CardUpdateInput = {
  commandId: string;
  projectId: string;
  expectKinds?: readonly string[];
  requireActiveWork?: boolean;
  update: (
    card: IdeaEventCardData,
    row: { workId: string | null },
  ) => CardUpdate;
};

const WORK_INACTIVE_MESSAGE = "This Work is completed. Reopen it to continue.";
const CONFLICT_MESSAGE = "This card changed at the same time. Try again.";
const MAX_ATTEMPTS = 3;
const MAX_BACKOFF_MS = 50;

function fail(
  code: Extract<CardUpdateResult<never>, { ok: false }>["code"],
  message: string,
): CardUpdateResult<never> {
  return { ok: false, code, message };
}

export async function updateCardInTx(
  tx: Prisma.TransactionClient,
  input: CardUpdateInput,
): Promise<CardUpdateResult<IdeaEventCardData>> {
  const row = await tx.command.findUnique({
    where: { id: input.commandId },
    select: {
      parsedIntent: true,
      projectId: true,
      workId: true,
      replyText: true,
    },
  });
  // A foreign project id is NOT_FOUND, never WRONG_KIND (no existence oracle).
  if (!row || row.projectId !== input.projectId) {
    return fail("NOT_FOUND", "Card not found.");
  }

  const intent = row.parsedIntent as {
    card?: IdeaEventCardData | null;
  } | null;
  const card = intent?.card;
  const kind = (card as { kind?: unknown } | null | undefined)?.kind;
  if (!card || typeof kind !== "string") {
    return fail("WRONG_KIND", "This card can't be changed.");
  }
  if (input.expectKinds && !input.expectKinds.includes(kind)) {
    return fail("WRONG_KIND", "This card can't be changed.");
  }

  if (input.requireActiveWork && row.workId) {
    const work = await tx.work.findFirst({
      where: { id: row.workId, projectId: input.projectId },
      select: { status: true },
    });
    if (!work || work.status !== "ACTIVE") {
      return fail("WORK_INACTIVE", WORK_INACTIVE_MESSAGE);
    }
  }

  const outcome = input.update(card, { workId: row.workId });
  if (outcome === null) return { ok: true, card, changed: false };
  if ("reject" in outcome) return fail("REJECTED", outcome.reject);

  const next = "kind" in outcome ? outcome : outcome.card;
  const replyText = "kind" in outcome ? undefined : outcome.replyText;

  await tx.command.update({
    where: { id: input.commandId },
    data: {
      // Only parsedIntent.card is replaced; other keys stay.
      parsedIntent: {
        ...intent,
        card: next,
      } as unknown as Prisma.InputJsonValue,
      ...(replyText !== undefined ? { replyText } : {}),
    },
  });
  return { ok: true, card: next, changed: true };
}

function isWriteConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2034"
  );
}

export async function updateCommandCard(
  input: CardUpdateInput,
): Promise<CardUpdateResult<IdeaEventCardData>> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await prisma.$transaction((tx) => updateCardInTx(tx, input), {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (!isWriteConflict(error)) throw error;
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.random() * MAX_BACKOFF_MS),
        );
      }
    }
  }
  return fail("CONFLICT", CONFLICT_MESSAGE);
}
