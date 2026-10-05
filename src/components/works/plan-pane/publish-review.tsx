"use client";

import { CircleCheck } from "lucide-react";
import Link from "next/link";
import { useId } from "react";

import { ChannelMark } from "@/components/commands/channel-badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  CHANNELS,
  type ChannelKey,
  type PublishMode,
} from "@/lib/content-channels";
import type { PlanItemStage } from "@/lib/journey";
import { cn } from "@/lib/utils";
import { deliveryLabelOf, formatDay, zoneName } from "@/lib/works/plan-pane";

import { PLAN_PANE_COPY as COPY } from "./copy";

// The last step of the plan pane: the publish plan to review and approve, and,
// once everything is decided, the publish calendar. One row per post, one line
// per channel it goes to (a channel left out of the post is not listed).
// Presentational.

export type ReviewPiece = {
  channel: ChannelKey;
  // An Instagram post and its Story are two lines of one channel.
  formatKey?: string;
  stage?: PlanItemStage;
  // "YYYY-MM-DDTHH:mm" in the plan's zone.
  when?: string;
  // What really happens to it at its time (the catalog says "auto" for LinkedIn
  // and X too; only Instagram is posted by the app).
  mode: PublishMode;
  connected: boolean;
};

export type ReviewPost = {
  key: string;
  date: string;
  topic: string;
  pieces: ReviewPiece[];
};

const NOT_MADE: ReadonlySet<PlanItemStage | undefined> = new Set([
  undefined,
  "PLANNED",
  "PRODUCING",
  "FAILED",
  "REJECTED",
]);

// The short truth after a piece's time. `done`: it is decided, so the words are
// what happens now rather than what will.
function tagOf(
  piece: ReviewPiece,
  scheduleEnabled: boolean | undefined,
  done: boolean,
): string {
  if (NOT_MADE.has(piece.stage)) return COPY.notMade;
  if (piece.stage === "PUBLISHED") return COPY.state.published;
  if (!piece.connected) return COPY.tags.unconnected;
  if (piece.mode === "approval") return COPY.tags.approval;
  if (piece.mode === "manual") return COPY.tags.manual;
  if (scheduleEnabled === false) return COPY.tags.off;
  return done ? COPY.state.scheduled : COPY.tags.auto;
}

function PublishRows({
  posts,
  scheduleEnabled,
  done,
}: {
  posts: readonly ReviewPost[];
  scheduleEnabled: boolean | undefined;
  done: boolean;
}) {
  return (
    <ul>
      {posts.map((post, index) => (
        <li
          key={post.key}
          className={cn("py-3.5", index > 0 && "border-t")}
          style={{ borderColor: "var(--ws-border)" }}
        >
          <p
            className="text-sm font-medium"
            style={{ color: "var(--ws-text)" }}
          >
            {formatDay(post.date)} · {post.topic}
          </p>
          <ul className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1.5 min-[420px]:grid-cols-2">
            {post.pieces.map((piece) => {
              const made = !NOT_MADE.has(piece.stage);
              return (
                <li
                  key={`${piece.channel}:${piece.formatKey ?? ""}`}
                  className="flex min-w-0 items-center gap-2 text-xs"
                  style={{ color: "var(--ws-text-2)" }}
                >
                  <ChannelMark
                    channel={piece.channel}
                    decorative
                    className="size-4"
                  />
                  <span className="min-w-0 truncate">
                    <span style={{ color: "var(--ws-text)" }}>
                      {deliveryLabelOf(piece, post.pieces)}
                    </span>
                    {made && piece.when ? ` ${piece.when.slice(11, 16)}` : ""}
                    {` · ${tagOf(piece, scheduleEnabled, done)}`}
                  </span>
                </li>
              );
            })}
          </ul>
        </li>
      ))}
    </ul>
  );
}

// Step 3 before the decision.
export function PublishReview({
  posts,
  toApprove,
  timezone,
  scheduleEnabled,
  heldChannels,
  approved,
  onApprovedChange,
  onEdit,
}: {
  posts: readonly ReviewPost[];
  // Posts with something that waits for the decision.
  toApprove: number;
  timezone: string;
  scheduleEnabled: boolean | undefined;
  // Selected channels with no account connected.
  heldChannels: readonly ChannelKey[];
  approved: boolean;
  onApprovedChange: (approved: boolean) => void;
  onEdit: () => void;
}) {
  const checkId = useId();
  const channels = posts.reduce((sum, post) => sum + post.pieces.length, 0);
  return (
    <section className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4
            className="text-base font-semibold"
            style={{ color: "var(--ws-text)" }}
          >
            {COPY.reviewTitle}
          </h4>
          <p className="mt-0.5 text-xs" style={{ color: "var(--ws-text-2)" }}>
            {COPY.reviewMeta(posts.length, channels, zoneName(timezone))}
          </p>
        </div>
        <button
          type="button"
          onClick={onEdit}
          className="min-h-8 rounded-md px-2 text-xs font-medium underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
          style={{ color: "var(--ws-text-2)" }}
        >
          {COPY.edit}
        </button>
      </div>
      <PublishRows
        posts={posts}
        scheduleEnabled={scheduleEnabled}
        done={false}
      />
      {heldChannels.length > 0 ? (
        <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
          {heldChannels.map((key) => CHANNELS[key].label).join(", ")}
          {": "}
          {COPY.holdLine}
        </p>
      ) : null}
      <label
        htmlFor={checkId}
        className="flex cursor-pointer items-start gap-2.5 text-sm"
        style={{ color: "var(--ws-text)" }}
      >
        <input
          id={checkId}
          type="checkbox"
          checked={approved}
          disabled={toApprove === 0}
          onChange={(event) => onApprovedChange(event.target.checked)}
          className="mt-0.5 size-4 shrink-0 accent-[var(--ws-text)]"
        />
        {COPY.approveLabel(toApprove)}
      </label>
    </section>
  );
}

// Step 3 once everything is decided.
export function PublishCalendar({
  posts,
  scheduleEnabled,
  instagramNeedsSchedule,
  scheduleBusy,
  onTurnOnSchedule,
  onSeeContent,
  calendarHref,
}: {
  posts: readonly ReviewPost[];
  scheduleEnabled: boolean | undefined;
  // Instagram pieces are approved and connected, but scheduled posting is off.
  instagramNeedsSchedule: boolean;
  scheduleBusy: boolean;
  onTurnOnSchedule: () => void;
  onSeeContent: () => void;
  calendarHref?: string;
}) {
  return (
    <section className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <h4
          className="text-base font-semibold"
          style={{ color: "var(--ws-text)" }}
        >
          {COPY.calendarTitle}
        </h4>
        <button
          type="button"
          onClick={onSeeContent}
          className="min-h-8 rounded-md px-2 text-xs font-medium underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
          style={{ color: "var(--ws-text-2)" }}
        >
          {COPY.seeContent}
        </button>
      </div>
      <PublishRows posts={posts} scheduleEnabled={scheduleEnabled} done />
      <div
        className="space-y-2 rounded-xl border p-4"
        style={{
          background: "color-mix(in oklch, var(--ws-approved) 8%, transparent)",
          borderColor:
            "color-mix(in oklch, var(--ws-approved) 28%, transparent)",
        }}
      >
        <p
          className="flex items-center gap-2 text-sm font-semibold"
          style={{ color: "var(--ws-approved)" }}
        >
          <CircleCheck aria-hidden className="size-4" />
          {COPY.doneTitle(posts.length)}
        </p>
        <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
          {COPY.doneBody}
        </p>
        {instagramNeedsSchedule ? (
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
              {COPY.turnOnLine}
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="min-h-9 rounded-lg px-3"
              disabled={scheduleBusy}
              onClick={onTurnOnSchedule}
            >
              {COPY.turnOnScheduled}
            </Button>
          </div>
        ) : null}
        {calendarHref ? (
          <Link
            href={calendarHref}
            className={cn(
              buttonVariants({ variant: "outline", size: "sm" }),
              "min-h-9 rounded-lg px-3",
            )}
          >
            {COPY.openCalendar}
          </Link>
        ) : null}
      </div>
    </section>
  );
}
