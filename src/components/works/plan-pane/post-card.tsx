"use client";

import { ChevronDown, Loader2, RefreshCw, Sparkles } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";
import { toast } from "sonner";

import {
  ChannelMark,
  ConnectionDot,
} from "@/components/commands/channel-badge";
import { Button } from "@/components/ui/button";
import { TimePicker } from "@/components/ui/date-time-picker";
import { StageDot } from "@/components/works/stage-dot";
import {
  CHANNELS,
  type ChannelConnections,
  type ChannelKey,
} from "@/lib/content-channels";
import { cn } from "@/lib/utils";
import {
  approachOf,
  dayNumberOf,
  formatLineOf,
  MOVABLE_STAGES,
  postStateOf,
  weekdayOf,
  zoneName,
  type PieceView,
  type PostState,
} from "@/lib/works/plan-pane";
import { PIECE_TEXT_MAX } from "@/lib/works/piece-text";
import { moveSlotAction } from "@/server/actions/schedule-slots-actions";
import { updateSlotTextAction } from "@/server/actions/slot-text-actions";

import { PLAN_PANE_COPY as COPY } from "./copy";
import { MoveDay } from "./move-day";
import { assetUrl } from "@/lib/asset-url";

// One post of the plan as a card: its day, its idea, where it stands; opened it
// shows the idea per channel and, once the plan is made, each piece's picture,
// text and publish time to edit. ContentPlanPane owns the state and the actions.

// A new idea for the post: the button on its card, and the idea that is
// suggested instead while the person looks at it. Nothing changes until they
// say "Use this idea".
export type NewIdea = {
  // The button (and "Another idea"): shows the next idea.
  onNew: () => void;
  // More ideas are being asked for.
  busy: boolean;
  disabled: boolean;
  suggestion?: {
    topic: string;
    captionIdea: string;
    // The direction the idea came from, when it did.
    from?: string;
    position: number;
    total: number;
  };
  onUse: () => void;
  onKeep: () => void;
};

export type CardTab = {
  channel: ChannelKey;
  formatKey?: string;
  // Once the plan is saved: the piece made for this channel.
  piece?: PieceView;
};

// A channel can have two pieces of one post (an Instagram post and its Story):
// a tab is its channel and format.
function tabKeyOf(tab: CardTab): string {
  return `${tab.channel}:${tab.formatKey ?? ""}`;
}

// "Instagram", or "Instagram Story" next to the post's own Instagram tab.
function tabLabelOf(tab: CardTab, tabs: readonly CardTab[]): string {
  const name = CHANNELS[tab.channel].label;
  const twin = tabs.some(
    (other) => other !== tab && other.channel === tab.channel,
  );
  const format = tab.formatKey
    ? CHANNELS[tab.channel].formats.find((f) => f.key === tab.formatKey)
    : undefined;
  return twin && format && format !== CHANNELS[tab.channel].formats[0]
    ? `${name} ${format.label}`
    : name;
}

const STATE_COLOR: Record<PostState, string> = {
  idea: "var(--ws-text-2)",
  needs: "var(--ws-text-2)",
  making: "var(--ws-text-2)",
  ready: "var(--ws-approved)",
  failed: "var(--destructive)",
  declined: "var(--destructive)",
  scheduled: "var(--ws-approved)",
  published: "var(--ws-approved)",
};

export function PostCard({
  topic,
  purpose,
  idea,
  date,
  time,
  tabs,
  state,
  open,
  onToggle,
  step,
  connected,
  connections,
  timezone,
  today,
  move,
  newIdea,
  edit,
}: {
  topic: string;
  // What the post does for the plan; the subtitle's first part.
  purpose?: string;
  idea: string;
  date: string;
  time: string;
  tabs: readonly CardTab[];
  state: PostState;
  open: boolean;
  onToggle: () => void;
  // "plan": the idea per channel; "content": each piece to edit.
  step: "plan" | "content";
  connected: readonly ChannelKey[];
  connections?: ChannelConnections;
  timezone: string;
  today: string;
  // Only a draft moves, drops or changes its idea.
  move?: {
    canRemove: boolean;
    onMove: (date: string, time: string) => void;
    onRemove: () => void;
  };
  newIdea?: NewIdea;
  // Only while the plan is made and the Work is open.
  edit?: { projectId: string; workId: string; active: boolean };
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const tab = tabs.find((entry) => tabKeyOf(entry) === picked) ?? tabs[0];
  const panelId = useId();
  const subtitle = [
    purpose ?? (tab ? formatLabelOf(tab) : ""),
    COPY.channelCount(new Set(tabs.map((entry) => entry.channel)).size),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <li
      data-post-card
      data-state={state}
      className="rounded-xl border transition-colors"
      style={{
        borderColor: open ? "var(--ws-text)" : "var(--ws-border)",
        background: "var(--ws-surface)",
      }}
    >
      <div className="flex items-center gap-1 pr-2">
        <DateBlock date={date} time={time} today={today} move={move} />
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={onToggle}
          className="min-w-0 flex-1 rounded-lg px-3 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <span
            className="block truncate text-sm font-semibold"
            style={{ color: "var(--ws-text)" }}
          >
            {topic}
          </span>
          <span
            className="mt-0.5 block truncate text-xs"
            style={{ color: "var(--ws-text-2)" }}
          >
            {subtitle}
          </span>
        </button>
        <span
          className={cn(
            "shrink-0 text-xs font-medium",
            state === "idea" && "max-sm:hidden",
          )}
          style={{ color: STATE_COLOR[state] }}
        >
          {COPY.state[state]}
        </span>
        {newIdea ? (
          <button
            type="button"
            aria-disabled={
              newIdea.disabled || newIdea.busy ? "true" : undefined
            }
            onClick={() => {
              if (newIdea.disabled || newIdea.busy) return;
              newIdea.onNew();
            }}
            className={cn(
              "inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors outline-none hover:bg-[var(--ws-hover)] focus-visible:ring-2 focus-visible:ring-ring/50",
              (newIdea.disabled || newIdea.busy) &&
                "cursor-not-allowed opacity-60",
            )}
            style={{
              borderColor: "var(--ws-border)",
              color: "var(--ws-text)",
            }}
          >
            {newIdea.busy ? (
              <Loader2 aria-hidden className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw aria-hidden className="size-3.5" />
            )}
            <span>{COPY.newIdea}</span>
          </button>
        ) : null}
        <button
          type="button"
          tabIndex={-1}
          aria-hidden
          onClick={onToggle}
          className="grid size-8 shrink-0 place-items-center rounded-lg hover:bg-[var(--ws-hover)]"
          style={{ color: "var(--ws-text-2)" }}
        >
          <ChevronDown
            aria-hidden
            className={cn("size-4 transition-transform", open && "rotate-180")}
          />
        </button>
      </div>

      {open ? (
        <div id={panelId} className="space-y-4 px-4 pb-4">
          {idea ? (
            <p
              className="text-sm leading-relaxed"
              style={{ color: "var(--ws-text-2)" }}
            >
              {idea}
            </p>
          ) : null}

          {newIdea?.suggestion || newIdea?.busy ? (
            <IdeaSuggestion newIdea={newIdea} />
          ) : null}

          {tab ? (
            <>
              <section className="space-y-2">
                <p
                  className="text-[11px] font-medium tracking-[0.08em] uppercase"
                  style={{ color: "var(--ws-text-2)" }}
                >
                  {COPY.adaptations}
                </p>
                <div
                  role="tablist"
                  aria-label={COPY.adaptations}
                  className="flex flex-wrap gap-1.5"
                >
                  {tabs.map((entry) => {
                    const on = tabKeyOf(entry) === tabKeyOf(tab);
                    return (
                      <button
                        key={tabKeyOf(entry)}
                        type="button"
                        role="tab"
                        aria-selected={on}
                        onClick={() => setPicked(tabKeyOf(entry))}
                        className="inline-flex min-h-8 items-center gap-1.5 rounded-lg px-2 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                        style={{
                          background: on ? "var(--ws-hover)" : "transparent",
                          color: on ? "var(--ws-text)" : "var(--ws-text-2)",
                        }}
                      >
                        <ChannelMark
                          channel={entry.channel}
                          decorative
                          className="size-4"
                        />
                        {tabLabelOf(entry, tabs)}
                        {entry.piece?.stage ? (
                          <StageDot stage={entry.piece.stage} />
                        ) : connected.includes(entry.channel) ? (
                          <ConnectionDot state="connected" />
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </section>

              <div
                role="tabpanel"
                className="space-y-3 border-t pt-3"
                style={{ borderColor: "var(--ws-border)" }}
              >
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span
                    className="font-medium"
                    style={{ color: "var(--ws-text)" }}
                  >
                    {formatLabelOf(tab)}
                  </span>
                  <span style={{ color: "var(--ws-text-2)" }}>
                    {connected.includes(tab.channel)
                      ? (connections?.[tab.channel]?.accountLabel ??
                        COPY.connected)
                      : COPY.notConnected}
                  </span>
                </div>
                {step === "content" && tab.piece ? (
                  <PieceEditor
                    key={tab.piece.creativeId ?? tabKeyOf(tab)}
                    piece={tab.piece}
                    channel={tab.channel}
                    timezone={timezone}
                    edit={edit}
                  />
                ) : (
                  <ApproachBox
                    channel={tab.channel}
                    formatKey={tab.formatKey}
                  />
                )}
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

// The idea suggested instead of the post's own: what it is, where it stands among
// the others, and the three things to do with it. The post changes only on "Use
// this idea".
export function IdeaSuggestion({ newIdea }: { newIdea: NewIdea }) {
  const suggestion = newIdea.suggestion;
  return (
    <section
      data-idea-suggestion
      role="region"
      aria-label={COPY.suggestionAria}
      aria-busy={newIdea.busy ? "true" : undefined}
      className="space-y-3 rounded-xl border p-3.5"
      style={{
        borderColor: "var(--ws-text)",
        background: "var(--ws-surface-2)",
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <p
          className="flex items-center gap-1.5 text-[11px] font-medium tracking-[0.08em] uppercase"
          style={{ color: "var(--ws-text-2)" }}
        >
          <Sparkles aria-hidden className="size-3.5" />
          {COPY.suggestionLabel}
        </p>
        {suggestion ? (
          <p
            className="text-[11px] tabular-nums"
            style={{ color: "var(--ws-text-2)" }}
          >
            {COPY.suggestionPosition(suggestion.position, suggestion.total)}
          </p>
        ) : null}
      </div>
      {suggestion ? (
        <div>
          <p
            className="text-sm font-semibold"
            style={{ color: "var(--ws-text)" }}
          >
            {suggestion.topic}
          </p>
          <p
            className="mt-1 text-[13px] leading-relaxed"
            style={{ color: "var(--ws-text-2)" }}
          >
            {suggestion.captionIdea}
          </p>
          {suggestion.from ? (
            <p
              className="mt-1.5 text-[11px]"
              style={{ color: "var(--ws-text-2)" }}
            >
              {COPY.ideaFrom(suggestion.from)}
            </p>
          ) : null}
        </div>
      ) : (
        <p
          className="flex items-center gap-2 text-[13px]"
          style={{ color: "var(--ws-text-2)" }}
        >
          <Loader2 aria-hidden className="size-4 animate-spin" />
          {COPY.findingIdeas}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          className="min-h-10 rounded-lg px-4"
          disabled={!suggestion || newIdea.disabled}
          onClick={newIdea.onUse}
        >
          {COPY.useIdea}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="min-h-10 rounded-lg px-4"
          disabled={newIdea.busy || newIdea.disabled}
          onClick={newIdea.onNew}
        >
          {COPY.anotherIdea}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="min-h-10 rounded-lg px-3"
          onClick={newIdea.onKeep}
        >
          {COPY.keepIdea}
        </Button>
      </div>
    </section>
  );
}

function formatLabelOf(tab: CardTab): string {
  return formatLineOf(tab.channel, tab.formatKey);
}

// The weekday, the day of the month and the time. A post that can still move has
// a button here (a draft's can also drop it); one that cannot is plain.
function DateBlock({
  date,
  time,
  today,
  move,
}: {
  date: string;
  time: string;
  today: string;
  move?: {
    canRemove: boolean;
    onMove: (date: string, time: string) => void;
    onRemove: () => void;
  };
}) {
  const body = (
    <>
      <span
        className="block text-[10px] leading-none font-medium tracking-[0.08em] uppercase"
        style={{ color: "var(--ws-text-2)" }}
      >
        {weekdayOf(date)}
      </span>
      <span
        className="mt-1 block text-[22px] leading-none font-medium tabular-nums"
        style={{ color: "var(--ws-text)" }}
      >
        {dayNumberOf(date)}
      </span>
      {time ? (
        <span
          className="mt-1.5 block text-[10px] leading-none tabular-nums"
          style={{ color: "var(--ws-text-2)" }}
        >
          {time}
        </span>
      ) : null}
    </>
  );
  const shape =
    "ml-1 flex w-14 shrink-0 flex-col items-center self-stretch justify-center border-r py-3 pr-1 text-center";
  if (!move) {
    return (
      <span className={shape} style={{ borderColor: "var(--ws-border)" }}>
        {body}
      </span>
    );
  }
  return (
    <MoveDay
      post={{ date, time }}
      today={today}
      canRemove={move.canRemove}
      onMove={move.onMove}
      onRemove={move.onRemove}
      className={cn(
        shape,
        "rounded-l-lg outline-none hover:bg-[var(--ws-hover)] focus-visible:ring-2 focus-visible:ring-ring/50",
      )}
    >
      {body}
    </MoveDay>
  );
}

function ApproachBox({
  channel,
  formatKey,
}: {
  channel: ChannelKey;
  formatKey?: string;
}) {
  const text = approachOf(channel, formatKey);
  if (!text) return null;
  return (
    <div
      className="rounded-lg p-3"
      style={{ background: "var(--ws-surface-2)" }}
    >
      <p className="text-xs font-semibold" style={{ color: "var(--ws-text)" }}>
        {COPY.contentApproach}
      </p>
      <p
        className="mt-1 text-[13px] leading-relaxed"
        style={{ color: "var(--ws-text-2)" }}
      >
        {text}
      </p>
    </div>
  );
}

// ---- a made piece: its picture, its words, its time ------------------------------

const EDITABLE_TEXT_STAGES = new Set(["IN_REVIEW"]);

function PieceEditor({
  piece,
  channel,
  timezone,
  edit,
}: {
  piece: PieceView;
  channel: ChannelKey;
  timezone: string;
  edit?: { projectId: string; workId: string; active: boolean };
}) {
  const textId = useId();
  const timeId = useId();
  const stage = piece.stage;
  const serverText = piece.text ?? "";
  const serverTime = piece.when?.slice(11, 16) ?? "";
  // What the person typed, kept only while the server still holds what it held
  // when they started: a save (or anyone else's change) moves the server's value
  // and the typed copy gives way to it.
  const [typed, setTyped] = useState<{ base: string; value: string } | null>(
    null,
  );
  const [typedTime, setTypedTime] = useState<{
    base: string;
    value: string;
  } | null>(null);
  const [saving, setSaving] = useState<"idle" | "saving" | "saved">("idle");
  const text = typed && typed.base === serverText ? typed.value : serverText;
  const time =
    typedTime && typedTime.base === serverTime ? typedTime.value : serverTime;

  const active = edit?.active === true;
  const textEditable =
    active && !!piece.creativeId && !!stage && EDITABLE_TEXT_STAGES.has(stage);
  const timeEditable =
    active &&
    !!piece.creativeId &&
    !!stage &&
    !!piece.when &&
    MOVABLE_STAGES.has(stage);

  const saveText = async () => {
    if (!textEditable || !edit || !piece.creativeId) return;
    const next = text.trim();
    if (!next || next === serverText.trim()) {
      setTyped(null);
      return;
    }
    setSaving("saving");
    const result = await updateSlotTextAction(
      edit.projectId,
      edit.workId,
      piece.creativeId,
      next,
    ).catch(() => null);
    if (result?.ok) {
      setSaving("saved");
    } else {
      setSaving("idle");
      setTyped(null);
      toast.error(result?.message ?? COPY.textFailed);
    }
  };

  const commitTime = async (next: string) => {
    if (!timeEditable || !edit || !piece.creativeId || !piece.when) return;
    if (!next || next === serverTime) {
      setTypedTime(null);
      return;
    }
    const result = await moveSlotAction(
      edit.projectId,
      edit.workId,
      piece.creativeId,
      { date: piece.when.slice(0, 10), time: next },
    ).catch(() => null);
    if (!result?.ok) {
      setTypedTime(null);
      toast.error(result?.message ?? COPY.timeFailed);
    }
  };

  const timeRow = (
    <TimeRow
      id={timeId}
      time={time}
      zone={zoneName(timezone)}
      editable={timeEditable}
      onChange={(value) => setTypedTime({ base: serverTime, value })}
      onCommit={commitTime}
    />
  );

  if (
    !stage ||
    stage === "PLANNED" ||
    stage === "PRODUCING" ||
    stage === "FAILED"
  ) {
    return (
      <div className="space-y-3">
        <p
          className="flex items-center gap-2 text-[13px]"
          style={{ color: "var(--ws-text-2)" }}
        >
          {stage ? <StageDot stage={stage} /> : null}
          {stage === "PRODUCING"
            ? COPY.pieceMaking
            : stage === "FAILED"
              ? COPY.pieceFailed
              : COPY.pieceNeeds}
        </p>
        {timeEditable ? timeRow : null}
      </div>
    );
  }

  const rows = Math.min(10, Math.max(4, text.split("\n").length + 1));
  return (
    <div className="space-y-3">
      <div className="flex gap-3">
        {piece.assetId ? (
          // eslint-disable-next-line @next/next/no-img-element -- source is /api/assets/<id>, next/image cannot optimize it
          <img
            src={assetUrl(piece.assetId, "thumb")}
            alt=""
            loading="lazy"
            decoding="async"
            className="h-[150px] w-[120px] shrink-0 rounded-lg border object-cover"
            style={{ borderColor: "var(--ws-border)" }}
          />
        ) : null}
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <label
              htmlFor={textId}
              className="text-xs font-medium"
              style={{ color: "var(--ws-text)" }}
            >
              {COPY.textOf(CHANNELS[channel].label)}
            </label>
            <span
              className="text-[11px] tabular-nums"
              style={{ color: "var(--ws-text-2)" }}
              aria-live="polite"
            >
              {saving === "saving"
                ? COPY.saving
                : saving === "saved"
                  ? COPY.saved
                  : COPY.characters(text.length)}
            </span>
          </div>
          <textarea
            id={textId}
            value={text}
            rows={rows}
            maxLength={PIECE_TEXT_MAX}
            readOnly={!textEditable}
            onChange={(event) => {
              setTyped({ base: serverText, value: event.target.value });
              setSaving("idle");
            }}
            onBlur={saveText}
            className="w-full resize-y rounded-lg border bg-transparent p-2.5 text-sm leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            style={{
              borderColor: "var(--ws-border)",
              color: "var(--ws-text)",
            }}
          />
        </div>
      </div>
      {timeRow}
      {!textEditable && (stage === "APPROVED" || stage === "PUBLISHED") ? (
        <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
          {COPY.locked}
        </p>
      ) : null}
      {stage === "REJECTED" ? (
        <p className="text-xs" style={{ color: "var(--destructive)" }}>
          {COPY.pieceDeclined}
        </p>
      ) : null}
      {edit && piece.creativeId ? (
        <Link
          href={`/projects/${edit.projectId}/takvim?creative=${piece.creativeId}`}
          className="inline-block text-xs underline underline-offset-2"
          style={{ color: "var(--ws-text-2)" }}
        >
          {COPY.openPiece}
        </Link>
      ) : null}
    </div>
  );
}

function TimeRow({
  id,
  time,
  zone,
  editable,
  onChange,
  onCommit,
}: {
  id: string;
  time: string;
  zone: string;
  editable: boolean;
  onChange: (time: string) => void;
  onCommit: (time: string) => void;
}) {
  if (!time) return null;
  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <label
        htmlFor={id}
        className="text-xs"
        style={{ color: "var(--ws-text-2)" }}
      >
        {COPY.publishTime}
      </label>
      {/* The site's one time picker. The time is saved when the panel closes
          with a different time (not on every tap). */}
      <TimePicker
        id={id}
        value={time}
        readOnly={!editable}
        aria-label={COPY.timeAria}
        onChange={onChange}
        onCommit={onCommit}
        className="w-28"
      />
      {zone ? (
        <span className="text-xs" style={{ color: "var(--ws-text-2)" }}>
          {zone}
        </span>
      ) : null}
    </div>
  );
}

// A state of the post as the aggregated stages of its tabs.
export function stateOfTabs(tabs: readonly CardTab[]): PostState {
  return postStateOf(tabs.map((tab) => tab.piece?.stage));
}
