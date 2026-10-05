"use client";

import { useRef, useState, type ReactNode } from "react";

import { DateTimePanel } from "@/components/ui/date-time-picker";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { splitDateTime } from "@/lib/date-picker";
import { addDays } from "@/lib/works/plan-platforms";
import {
  MAX_DAYS_AHEAD,
  formatDay,
  moveDayChips,
} from "@/lib/works/plan-pane";

import { PLAN_PANE_COPY as COPY } from "./copy";

// The date block of a post: tap it and the site's one date and time picker
// opens (the same panel as every other date field), with the days of the post's
// week on top (one tap each) and the usual times below; a draft post can also
// leave the plan from here. Today to 60 days ahead. The move is applied on Done
// (or Enter); closing any other way leaves the post where it was.
export function MoveDay({
  post,
  today,
  canRemove,
  onMove,
  onRemove,
  className,
  children,
}: {
  post: { date: string; time: string };
  today: string;
  canRemove: boolean;
  onMove: (date: string, time: string) => void;
  onRemove: () => void;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(`${post.date}T${post.time}`);
  const contentRef = useRef<HTMLDivElement>(null);
  const chips = moveDayChips(post.date, today);

  // `final` is what the panel ended on: on Enter the draft state has not caught
  // up yet, so the panel hands over the value itself.
  const done = (final: string = draft) => {
    setOpen(false);
    const next = splitDateTime(final);
    if (next && (next.day !== post.date || next.time !== post.time)) {
      onMove(next.day, next.time);
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        // Every open starts from the post's own day and time.
        if (next) setDraft(`${post.date}T${post.time}`);
        setOpen(next);
      }}
    >
      <PopoverTrigger
        aria-label={`${COPY.move}: ${formatDay(post.date)} ${post.time}`}
        className={className}
      >
        {children}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="max-h-[min(85dvh,40rem)] w-auto max-w-[calc(100vw-1.5rem)] gap-0 overflow-y-auto p-3"
        initialFocus={() =>
          contentRef.current?.querySelector<HTMLElement>(
            '[data-day][tabindex="0"]',
          ) ?? true
        }
      >
        <div ref={contentRef}>
          <DateTimePanel
            value={draft}
            onChange={setDraft}
            onDone={done}
            today={today}
            min={today}
            max={addDays(today, MAX_DAYS_AHEAD)}
            dayShortcuts={chips.length > 0 ? chips : undefined}
            footerLead={
              canRemove ? (
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onRemove();
                  }}
                  className="text-xs font-medium text-destructive underline underline-offset-2"
                >
                  {COPY.removePost}
                </button>
              ) : undefined
            }
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
