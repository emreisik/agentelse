import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { isFlowModuleKey } from "@/lib/module-flows/card";
import { MODULES, type ModuleKey } from "@/lib/modules/catalog";
import { startModuleFlowAction } from "@/server/actions/module-flow-actions";
import { setWorkModuleAction } from "@/server/actions/work-actions";

// The New Chat's module (plan P4; owner's decision of 5 Oct: a module goes on
// INSIDE the chat, never in a panel under the composer). Choosing one stores it
// on the Work, then:
//  - Social Media Planner: one ordinary chat message is sent, exactly as typing
//    it would be (the client's own words when they typed them, else
//    SOCIAL_START_MESSAGE), so the plan streams in live from the idea pool;
//  - Ads Manager, Analytics, SEO Manager: the module's flow card is written and
//    the page refreshed, so the chat shows the card.
// Nothing shows under the composer meanwhile (`starting`, kept until the chat
// moves on; it belongs to the Work it was chosen in). A refusal puts the tiles
// back and says why, and words are never lost: typed ones go to the chat as
// they are, a tile's start message goes into the composer (`onUnsent`).

export const MODULE_CHOICE_FAILED = "That didn't work. Try again.";

// What choosing the Social Media Planner says in the chat. The agent's social
// note (src/server/chat/works-notes.ts) answers it with a plan card at once.
export const SOCIAL_START_MESSAGE = "Plan next week's posts from my idea pool.";

export type ChooseOptions = {
  // The client's typed message (composer routing): sent instead of the start
  // message, and sent anyway when the module cannot be stored.
  words?: string;
  // Where a tile's start message goes when it cannot be sent (the composer).
  onUnsent?: (text: string) => void;
};

export type ModuleChoice = {
  // The module on screen: the one being started, else the Work's stored one.
  module: ModuleKey | null;
  // A module is being started in this Work: nothing shows under the composer.
  starting: boolean;
  choose: (module: ModuleKey, options?: ChooseOptions) => Promise<void>;
};

export function useModuleChoice(input: {
  projectId: string;
  // Absent outside a Work: nothing to store.
  workId: string | undefined;
  stored: ModuleKey | null;
  // The chat's own send (the message shows at once and streams live); null is
  // a general chat's message.
  send: (text: string, module: ModuleKey | null) => Promise<void> | void;
}): ModuleChoice {
  const { projectId, workId, send } = input;
  const router = useRouter();
  const [started, setStarted] = React.useState<{
    workId: string;
    module: ModuleKey;
  } | null>(null);
  const current = started && started.workId === workId ? started : null;

  const choose = React.useCallback(
    async (next: ModuleKey, options: ChooseOptions = {}) => {
      const words = options.words?.trim() || undefined;
      // The module could not be stored: the client's words still reach the
      // chat; a tile's message waits in the composer.
      const unsent = async () => {
        if (words) await send(words, null);
        else if (!isFlowModuleKey(next))
          options.onUnsent?.(SOCIAL_START_MESSAGE);
      };
      if (!workId) return unsent();
      setStarted({ workId, module: next });
      const stored = await setWorkModuleAction(projectId, workId, next).catch(
        () => null,
      );
      if (!stored?.ok) {
        setStarted(null);
        if (!words) toast.error(stored?.message ?? MODULE_CHOICE_FAILED);
        return unsent();
      }
      if (!isFlowModuleKey(next)) {
        await send(words ?? SOCIAL_START_MESSAGE, next);
        return;
      }
      // Not built yet (no tile offers it): back to the tiles.
      if (!MODULES[next].ready) return setStarted(null);
      // Ads Manager, Analytics and SEO Manager run on a flow card in the chat
      // (docs/modules.md): it is written at once and the page shows it.
      const flow = await startModuleFlowAction(projectId, workId, next).catch(
        () => null,
      );
      if (!flow?.ok) {
        setStarted(null);
        toast.error(flow?.message ?? MODULE_CHOICE_FAILED);
      }
      router.refresh();
    },
    [projectId, workId, send, router],
  );

  const shown = current?.module ?? input.stored;
  const starting = current !== null;
  return React.useMemo(
    () => ({ module: shown, starting, choose }),
    [shown, starting, choose],
  );
}
