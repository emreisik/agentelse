"use client";

import { useAui } from "@assistant-ui/react";

import { StarterRowsView } from "@/components/works/starter-rows";
import type { ModuleKey } from "@/lib/modules/catalog";
import type { StarterAction, StarterCard } from "@/lib/works/starter-cards";

import { ModuleLauncher } from "./module-launcher";
import { SOCIAL_START_MESSAGE, type ChooseOptions } from "./use-module-choice";

// A new chat's suggestions under the composer with modules on (docs/modules.md):
// the module tiles, with the rows no module covers under them. A module goes on
// in the chat itself, never in a panel here: while one starts nothing shows.
// A Social Media Planner chat with nothing sent yet (opened from a module link)
// offers its first message as one row instead of the tiles. Rendered inside the
// thread, so a tile's message can fall back to the composer.

export const SOCIAL_START_ROW: StarterCard = {
  id: "plan-week",
  line: SOCIAL_START_MESSAGE,
  reason:
    "Three posts for the next 7 days, made from the strongest ideas in your idea pool.",
  action: { kind: "send", text: SOCIAL_START_MESSAGE },
};

export function ModuleSuggestions({
  projectId,
  module,
  starting,
  rows,
  disabled,
  onChoose,
  onAct,
}: {
  projectId: string;
  // The module on screen and whether it is being started (use-module-choice).
  module: ModuleKey | null;
  starting: boolean;
  // The starter rows no module covers (moduleStarterCards).
  rows: readonly StarterCard[];
  // A message is being sent, or the chat is not open.
  disabled: boolean;
  onChoose: (module: ModuleKey, options?: ChooseOptions) => Promise<void>;
  onAct: (action: StarterAction) => void;
}) {
  const aui = useAui();
  if (starting) return null;
  if (module === "social") {
    return (
      <div className="pt-1 pb-4">
        <StarterRowsView
          cards={[SOCIAL_START_ROW, ...rows]}
          disabled={disabled}
          onAct={onAct}
        />
      </div>
    );
  }
  // A tile's message that could not be sent waits in the composer.
  const fill = (text: string) => {
    try {
      aui.composer.setText(text);
    } catch {
      // No composer in this scope: the toast already said why.
    }
  };
  return (
    <div className="flex flex-col gap-2 pt-1 pb-4">
      <ModuleLauncher
        projectId={projectId}
        disabled={disabled}
        onChoose={(key) => void onChoose(key, { onUnsent: fill })}
      />
      <StarterRowsView cards={rows} disabled={disabled} onAct={onAct} />
    </div>
  );
}
