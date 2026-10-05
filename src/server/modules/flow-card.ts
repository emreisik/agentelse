import "server-only";

import {
  isModuleFlowCard,
  type FlowModuleKey,
  type ModuleFlowCardData,
} from "@/lib/module-flows/card";
import { updateCommandCard } from "@/server/chat/card-store";

// The one writer of a module flow card (docs/modules.md): the module's server
// actions read the card, decide the next state and write it back through the
// atomic card store, so two taps (two tabs) can never both apply. A completed
// Work refuses (it must be reopened first), like every Works card.

export type FlowCardWrite =
  | { ok: true; card: ModuleFlowCardData }
  | { ok: false; message: string };

export async function updateModuleFlowCard(input: {
  commandId: string;
  projectId: string;
  module: FlowModuleKey;
  // Returns the next card, or a refusal shown to the person as is.
  update: (
    card: ModuleFlowCardData,
  ) => ModuleFlowCardData | { reject: string };
}): Promise<FlowCardWrite> {
  let refused: string | null = null;
  const result = await updateCommandCard({
    commandId: input.commandId,
    projectId: input.projectId,
    expectKinds: ["module-flow"],
    requireActiveWork: true,
    update: (card) => {
      if (!isModuleFlowCard(card) || card.module !== input.module) {
        refused = "This card belongs to another module.";
        return { reject: refused };
      }
      const next = input.update(card);
      if ("reject" in next) {
        refused = next.reject;
        return next;
      }
      return next;
    },
  });
  if (result.ok && isModuleFlowCard(result.card)) {
    return { ok: true, card: result.card };
  }
  return {
    ok: false,
    message: refused ?? (result.ok ? "That didn't work. Try again." : result.message),
  };
}
