"use client";

import {
  CalendarDays,
  ClipboardCheck,
  ImagePlus,
  Lightbulb,
  Plug,
  Sparkles,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";

import type { StarterAction, StarterCard } from "@/lib/works/starter-cards";

// What a new chat suggests under its composer, like ChatGPT's suggestion rows
// (docs/works.md): one icon and one muted sentence each; a tap does what the
// card's main button does (send a message, open a page, open a panel tab).
// Presentational: the chat maps an action.

export const STARTER_ROWS_COPY = {
  groupAria: "Suggestions for this chat",
} as const;

const ROW_ICON: Record<string, LucideIcon> = {
  "plan-week": CalendarDays,
  ideas: Lightbulb,
  "make-post": ImagePlus,
  decisions: ClipboardCheck,
  connect: Plug,
  "connect-first": Plug,
  performance: TrendingUp,
};

export function StarterRowsView({
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
    // A labelled list, not a region: the page already has its landmarks.
    <div className="w-full">
      <ul aria-label={STARTER_ROWS_COPY.groupAria} className="flex flex-col">
        {cards.map((card) => {
          const Icon = ROW_ICON[card.id] ?? Sparkles;
          return (
            <li key={card.id}>
              <button
                type="button"
                disabled={disabled}
                title={card.reason}
                onClick={() => onAct(card.action)}
                className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-[15px] outline-hidden transition-colors enabled:hover:bg-[var(--ws-hover)] focus-visible:bg-[var(--ws-hover)] focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                style={{ color: "var(--ws-text-2)" }}
              >
                <Icon
                  aria-hidden="true"
                  className="size-4 shrink-0"
                  style={{ color: "var(--ws-text-3)" }}
                />
                {/* One line, two where a phone's width needs it (three
                    channels named): the whole sentence stays readable. */}
                <span className="line-clamp-2 min-w-0 flex-1">{card.line}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
