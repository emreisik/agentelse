"use client";

import { Sparkles } from "lucide-react";

import { ActionCard } from "@/components/works/action-card";
import { CardActions } from "@/components/works/card-actions";
import type { CardButton } from "@/lib/works/card-action";
import type { StarterAction, StarterCard } from "@/lib/works/starter-cards";

// The cards of an empty Work: what to do next, each with the reason it is
// offered (docs/works.md). Presentational: the chat maps an action to a send, a
// link or a panel.

export const STARTER_COPY = {
  heading: "What do you want to do?",
  groupAria: "Suggested next steps",
} as const;

export function StarterCardsView({
  cards,
  disabled,
  onAct,
}: {
  cards: readonly StarterCard[];
  disabled: boolean;
  onAct: (action: StarterAction) => void;
}) {
  if (cards.length === 0) return null;
  return (
    <section aria-label={STARTER_COPY.groupAria} className="mt-6">
      <h2
        className="mb-2 px-1 text-xs font-semibold tracking-[0.08em] uppercase"
        style={{ color: "var(--ws-text-3)" }}
      >
        {STARTER_COPY.heading}
      </h2>
      <ul className="grid gap-3 sm:grid-cols-2">
        {cards.map((card) => {
          const buttons: CardButton[] = [
            {
              id: `${card.id}:primary`,
              label: card.primary.label,
              emphasis: "primary",
              action: card.primary.action,
            },
            ...(card.secondary
              ? [
                  {
                    id: `${card.id}:secondary`,
                    label: card.secondary.label,
                    emphasis: "quiet" as const,
                    action: card.secondary.action,
                  },
                ]
              : []),
          ];
          return (
            <li key={card.id} className="flex">
              <ActionCard
                icon={Sparkles}
                title={card.title}
                reason={card.reason}
                cardId={card.id}
                actions={
                  <CardActions
                    buttons={buttons}
                    disabledAll={disabled}
                    onAct={(button) => onAct(button.action as StarterAction)}
                  />
                }
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
