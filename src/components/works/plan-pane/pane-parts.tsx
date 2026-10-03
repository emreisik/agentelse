"use client";

import {
  Check,
  ChevronLeft,
  ChevronRight,
  Plus,
  SlidersHorizontal,
  X,
} from "lucide-react";
import Link from "next/link";

import { ChannelMark } from "@/components/commands/channel-badge";
import { buttonVariants } from "@/components/ui/button";
import {
  CHANNELS,
  type ChannelConnections,
  type ChannelKey,
} from "@/lib/content-channels";
import { cn } from "@/lib/utils";
import {
  PANE_STEPS,
  dayNumberOf,
  weekdayOf,
  type PaneStep,
  type StepState,
} from "@/lib/works/plan-pane";
import { SOCIAL_PLATFORMS } from "@/lib/works/plan-platforms";

import { PLAN_PANE_COPY as COPY } from "./copy";

// The presentational parts of the plan pane: header, steps, the channels row,
// the accounts panel, the list/week switch and the week strip. ContentPlanPane
// owns every state and action; nothing here fetches or writes.

const STEP_LABEL: Record<PaneStep, string> = {
  plan: COPY.stepPlan,
  content: COPY.stepContent,
  publish: COPY.stepPublish,
};

export const ACCOUNTS_PANEL_ID = "plan-pane-accounts";

export function PaneHeader({
  meta,
  accountsOpen,
  onAccounts,
}: {
  meta: string;
  accountsOpen: boolean;
  onAccounts: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p
          className="text-[11px] font-medium tracking-[0.1em] uppercase"
          style={{ color: "var(--ws-text-2)" }}
        >
          {COPY.eyebrow}
        </p>
        <h3
          className="mt-1 text-[22px] leading-tight font-semibold tracking-tight"
          style={{ color: "var(--ws-text)" }}
        >
          {COPY.title}
        </h3>
        {meta ? (
          <p className="mt-1.5 text-xs" style={{ color: "var(--ws-text-2)" }}>
            {meta}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        aria-expanded={accountsOpen}
        aria-controls={ACCOUNTS_PANEL_ID}
        onClick={onAccounts}
        className="inline-flex min-h-9 shrink-0 items-center gap-2 rounded-lg border px-3 text-xs font-medium transition-colors outline-none hover:bg-[var(--ws-hover)] focus-visible:ring-2 focus-visible:ring-ring/50"
        style={{
          borderColor: "var(--ws-border)",
          color: "var(--ws-text)",
          background: accountsOpen ? "var(--ws-hover)" : "var(--ws-surface)",
        }}
      >
        <SlidersHorizontal aria-hidden className="size-3.5" />
        {COPY.accounts}
      </button>
    </div>
  );
}

export function PlanStepper({
  states,
  openable,
  onPick,
}: {
  states: Record<PaneStep, StepState>;
  openable: Record<PaneStep, boolean>;
  onPick: (step: PaneStep) => void;
}) {
  return (
    <nav aria-label={COPY.stepsAria}>
      <ol
        className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b pb-3.5"
        style={{ borderColor: "var(--ws-border)" }}
      >
        {PANE_STEPS.map((step, index) => {
          const state = states[step];
          const circle =
            state === "current"
              ? {
                  background: "var(--ws-text)",
                  color: "var(--ws-surface)",
                  border: "1px solid var(--ws-text)",
                }
              : state === "done"
                ? {
                    background:
                      "color-mix(in oklch, var(--ws-approved) 16%, transparent)",
                    color: "var(--ws-approved)",
                    border: "1px solid transparent",
                  }
                : {
                    background: "transparent",
                    color: "var(--ws-text-3)",
                    border: "1px solid var(--ws-border)",
                  };
          const body = (
            <>
              <span
                className="grid size-5 shrink-0 place-items-center rounded-full text-[11px] leading-none font-semibold"
                style={circle}
              >
                {state === "done" ? (
                  <Check aria-hidden className="size-3" />
                ) : (
                  index + 1
                )}
              </span>
              <span
                className={cn(
                  "text-xs",
                  state === "current" && "font-semibold",
                )}
                style={{
                  color:
                    state === "current"
                      ? "var(--ws-text)"
                      : state === "done"
                        ? "var(--ws-text-2)"
                        : "var(--ws-text-3)",
                }}
              >
                {STEP_LABEL[step]}
              </span>
            </>
          );
          return (
            <li key={step}>
              {openable[step] && state !== "current" ? (
                <button
                  type="button"
                  onClick={() => onPick(step)}
                  className="inline-flex min-h-8 items-center gap-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  {body}
                </button>
              ) : (
                <span
                  aria-current={state === "current" ? "step" : undefined}
                  className="inline-flex min-h-8 items-center gap-2"
                >
                  {body}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

// The channels a plan goes to: a box, the platform's own mark and its name. A
// channel with no account connected is dashed with a "+" that goes to connect
// it; it can still be ticked (the posts are made, publishing waits).
export function ChannelChips({
  active,
  connected,
  locked,
  onToggle,
  connectHrefOf,
}: {
  active: readonly ChannelKey[];
  connected: readonly ChannelKey[];
  // A saved plan: the choice is made.
  locked: boolean;
  onToggle: (key: ChannelKey) => void;
  connectHrefOf: (key: ChannelKey) => string;
}) {
  const shown = locked
    ? SOCIAL_PLATFORMS.filter((key) => active.includes(key))
    : SOCIAL_PLATFORMS;
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <p
          className="text-[13px] font-medium"
          style={{ color: "var(--ws-text)" }}
        >
          {COPY.channelsLabel}
        </p>
        <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
          {COPY.selected(active.length)}
        </p>
      </div>
      <div
        role="group"
        aria-label={COPY.channelsAria}
        className="flex flex-wrap gap-2"
      >
        {shown.map((key) => {
          const on = active.includes(key);
          const linked = connected.includes(key);
          return (
            <div
              key={key}
              className={cn(
                "inline-flex min-h-10 items-center rounded-xl border transition-colors",
                !linked && "border-dashed",
              )}
              style={{
                borderColor: on ? "var(--ws-text)" : "var(--ws-border)",
                background: on ? "var(--ws-hover)" : "var(--ws-surface)",
              }}
            >
              <button
                type="button"
                role="checkbox"
                aria-checked={on}
                disabled={locked}
                onClick={() => onToggle(key)}
                className={cn(
                  "inline-flex min-h-10 items-center gap-2 rounded-xl pl-2.5 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default",
                  linked || locked ? "pr-3" : "pr-1.5",
                )}
                style={{ color: "var(--ws-text)" }}
              >
                <span
                  aria-hidden
                  className="grid size-4 shrink-0 place-items-center rounded-[5px] border"
                  style={
                    on
                      ? {
                          background: "var(--ws-text)",
                          borderColor: "var(--ws-text)",
                          color: "var(--ws-surface)",
                        }
                      : { borderColor: "var(--ws-text-3)" }
                  }
                >
                  {on ? <Check className="size-3" strokeWidth={3} /> : null}
                </span>
                <ChannelMark channel={key} decorative className="size-5" />
                {CHANNELS[key].label}
              </button>
              {!linked && !locked ? (
                <Link
                  href={connectHrefOf(key)}
                  aria-label={COPY.connectChannel(CHANNELS[key].label)}
                  title={COPY.connectChannel(CHANNELS[key].label)}
                  className="mr-1 grid size-8 place-items-center rounded-lg outline-none hover:bg-[var(--ws-hover)] focus-visible:ring-2 focus-visible:ring-ring/50"
                  style={{ color: "var(--ws-text-2)" }}
                >
                  <Plus aria-hidden className="size-3.5" />
                </Link>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function AccountsPanel({
  connections,
  connected,
  hrefOf,
  onClose,
}: {
  connections?: ChannelConnections;
  connected: readonly ChannelKey[];
  hrefOf: (key: ChannelKey) => string;
  onClose: () => void;
}) {
  return (
    <section
      id={ACCOUNTS_PANEL_ID}
      className="rounded-xl border p-4"
      style={{
        borderColor: "var(--ws-border)",
        background: "var(--ws-surface)",
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <h4
          className="text-sm font-semibold"
          style={{ color: "var(--ws-text)" }}
        >
          {COPY.accountsTitle}
        </h4>
        <button
          type="button"
          aria-label={COPY.close}
          onClick={onClose}
          className="-m-1.5 grid size-8 place-items-center rounded-lg outline-none hover:bg-[var(--ws-hover)] focus-visible:ring-2 focus-visible:ring-ring/50"
          style={{ color: "var(--ws-text-2)" }}
        >
          <X aria-hidden className="size-4" />
        </button>
      </div>
      <p className="mt-1 text-xs" style={{ color: "var(--ws-text-2)" }}>
        {COPY.accountsHint}
      </p>
      <ul className="mt-3">
        {SOCIAL_PLATFORMS.map((key, index) => {
          const linked =
            connected.includes(key) || connections?.[key]?.connected === true;
          const label = connections?.[key]?.accountLabel;
          return (
            <li
              key={key}
              className={cn(
                "flex items-center gap-3 py-2.5",
                index > 0 && "border-t",
              )}
              style={{ borderColor: "var(--ws-border)" }}
            >
              <ChannelMark channel={key} decorative className="size-7" />
              <div className="min-w-0 flex-1">
                <p
                  className="text-sm font-medium"
                  style={{ color: "var(--ws-text)" }}
                >
                  {CHANNELS[key].label}
                </p>
                <p
                  className="truncate text-xs"
                  style={{ color: "var(--ws-text-2)" }}
                >
                  {linked ? (label ?? COPY.connected) : COPY.notConnected}
                </p>
              </div>
              <Link
                href={hrefOf(key)}
                className={cn(
                  buttonVariants({
                    variant: linked ? "outline" : "default",
                    size: "sm",
                  }),
                  "min-h-9 rounded-lg px-3",
                )}
              >
                {linked ? COPY.manage : COPY.connect}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export type PaneView = "list" | "week";

export function ViewToggle({
  view,
  onChange,
}: {
  view: PaneView;
  onChange: (view: PaneView) => void;
}) {
  return (
    <div
      role="group"
      aria-label={COPY.viewAria}
      className="inline-flex rounded-lg border p-0.5"
      style={{
        borderColor: "var(--ws-border)",
        background: "var(--ws-surface-2)",
      }}
    >
      {(["list", "week"] as const).map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={view === value}
          onClick={() => onChange(value)}
          className={cn(
            "min-h-7 rounded-md px-3 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
            view === value && "shadow-sm",
          )}
          style={{
            background: view === value ? "var(--ws-surface)" : "transparent",
            color: view === value ? "var(--ws-text)" : "var(--ws-text-2)",
          }}
        >
          {value === "list" ? COPY.list : COPY.week}
        </button>
      ))}
    </div>
  );
}

// The seven days of a week with how many posts each has; a day with posts is a
// button that picks it. Arrows only when the plan spans more than one week.
export function WeekStrip({
  days,
  counts,
  selected,
  label,
  onSelect,
  onPrevious,
  onNext,
}: {
  days: readonly string[];
  counts: Readonly<Record<string, number>>;
  selected: string | null;
  label: string;
  onSelect: (day: string) => void;
  onPrevious?: () => void;
  onNext?: () => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span
          className="text-xs font-medium"
          style={{ color: "var(--ws-text-2)" }}
        >
          {label}
        </span>
        {onPrevious || onNext ? (
          <span className="flex items-center gap-1">
            <button
              type="button"
              aria-label={COPY.previousWeek}
              disabled={!onPrevious}
              onClick={onPrevious}
              className="grid size-8 place-items-center rounded-md hover:bg-[var(--ws-hover)] disabled:opacity-40"
            >
              <ChevronLeft aria-hidden className="size-4" />
            </button>
            <button
              type="button"
              aria-label={COPY.nextWeek}
              disabled={!onNext}
              onClick={onNext}
              className="grid size-8 place-items-center rounded-md hover:bg-[var(--ws-hover)] disabled:opacity-40"
            >
              <ChevronRight aria-hidden className="size-4" />
            </button>
          </span>
        ) : null}
      </div>
      <div className="grid grid-cols-7 gap-1.5">
        {days.map((day) => {
          const count = counts[day] ?? 0;
          const on = day === selected;
          return (
            <button
              key={day}
              type="button"
              aria-pressed={on}
              disabled={count === 0}
              onClick={() => onSelect(day)}
              className="flex min-h-[72px] min-w-0 flex-col items-center justify-start gap-1 rounded-lg border px-1 py-2 text-center transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50 enabled:hover:bg-[var(--ws-hover)]"
              style={{
                borderColor: on ? "var(--ws-text)" : "var(--ws-border)",
                background:
                  count === 0 ? "var(--ws-surface-2)" : "var(--ws-surface)",
                color: "var(--ws-text)",
              }}
            >
              <span
                className="text-[11px] leading-none"
                style={{ color: "var(--ws-text-2)" }}
              >
                {weekdayOf(day)}
              </span>
              <span className="text-[15px] leading-none font-medium">
                {dayNumberOf(day)}
              </span>
              {count > 0 ? (
                <span
                  className="max-w-full truncate rounded px-1.5 py-0.5 text-[10px] leading-none font-medium"
                  style={{
                    background: "var(--ws-hover)",
                    color: "var(--ws-text-2)",
                  }}
                >
                  {COPY.ideaCount(count)}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
