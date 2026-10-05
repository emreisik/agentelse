import "server-only";

import { prisma } from "@/lib/prisma";
import {
  isModuleFlowCard,
  type ModuleFlowCardData,
  type ModuleFlowStep,
} from "@/lib/module-flows/card";
import {
  parseSeoState,
  serializeSeoState,
  withoutRun,
  type SeoState,
} from "@/lib/module-flows/seo/state";
import { updateModuleFlowCard } from "@/server/modules/flow-card";

// Reading and writing the SEO Manager's card (docs/modules.md): every write
// goes through the module flow card's one writer (atomic, refuses a completed
// Work), and the step function always sees the state as stored at that moment,
// parsed, never the copy an action read before a model call.

export type SeoCardRead = {
  card: ModuleFlowCardData;
  step: ModuleFlowStep;
  state: SeoState;
  workId: string | null;
};

// Looked up WITH the project id: an id from another project never matches.
export async function readSeoCard(
  projectId: string,
  commandId: string,
): Promise<SeoCardRead | null> {
  const row = await prisma.command.findFirst({
    where: { id: commandId, projectId },
    select: { parsedIntent: true, workId: true },
  });
  const card = (row?.parsedIntent as { card?: unknown } | null)?.card;
  if (!row || !isModuleFlowCard(card) || card.module !== "seo") return null;
  return {
    card,
    step: card.step,
    state: parseSeoState(card.data),
    workId: row.workId,
  };
}

export type SeoCardNext =
  { step: ModuleFlowStep; state: SeoState } | { reject: string };

export type SeoCardWrite =
  | { ok: true; step: ModuleFlowStep; state: SeoState }
  | { ok: false; message: string };

export async function writeSeoCard(input: {
  projectId: string;
  commandId: string;
  update: (current: { step: ModuleFlowStep; state: SeoState }) => SeoCardNext;
}): Promise<SeoCardWrite> {
  const result = await updateModuleFlowCard({
    commandId: input.commandId,
    projectId: input.projectId,
    module: "seo",
    update: (card) => {
      const next = input.update({
        step: card.step,
        state: parseSeoState(card.data),
      });
      if ("reject" in next) return next;
      return { ...card, step: next.step, data: serializeSeoState(next.state) };
    },
  });
  if (!result.ok) return { ok: false, message: result.message };
  return {
    ok: true,
    step: result.card.step,
    state: parseSeoState(result.card.data),
  };
}

// Gives a model call's claim back after it failed: the card returns to `step`
// with everything else as it is. Only this run's own claim is released; never
// throws (the failure the person sees is the model's, not this).
export async function releaseSeoRun(input: {
  projectId: string;
  commandId: string;
  runId: string;
  step: ModuleFlowStep;
}): Promise<void> {
  await writeSeoCard({
    projectId: input.projectId,
    commandId: input.commandId,
    update: ({ state }) =>
      state.run?.id === input.runId
        ? { step: input.step, state: withoutRun(state) }
        : { reject: "released" },
  }).catch((error: unknown) => {
    console.error(
      "[works] seo release failed:",
      error instanceof Error ? error.message : error,
    );
  });
}
