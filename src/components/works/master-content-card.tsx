"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Megaphone } from "lucide-react";
import { toast } from "sonner";

import { ChannelMark } from "@/components/commands/channel-badge";
import { useChatPackage } from "@/components/commands/chat-package-context";
import { WsTag } from "@/components/commands/ws-event-card";
import { Button } from "@/components/ui/button";
import { ActionCard } from "@/components/works/action-card";
import { CardActions } from "@/components/works/card-actions";
import { SlotSuggestion } from "@/components/works/slot-suggestion";
import { useCardAction } from "@/components/works/use-card-action";
import {
  disabledReasonOf,
  useWorkCardHost,
} from "@/components/works/work-card-host";
import { isChannelKey, type ChannelKey } from "@/lib/content-channels";
import { cn } from "@/lib/utils";
import type { CardActionResult, CardButton } from "@/lib/works/card-action";
import { brandCheckText, copyText } from "@/lib/works/copy";
import { formatUsd, pieceCostUsd } from "@/lib/works/cost";
import {
  MAX_ADAPT_RUNS,
  chipStates,
  leadChannelOf,
  type MasterChip,
  type MasterContentCardData,
} from "@/lib/works/master-content";
import { slotWhenLabel } from "@/lib/works/slot-rules";
import { integrationsHref } from "@/lib/works/starter-cards";
import {
  addMasterChannelAction,
  scheduleMasterAction,
  toggleMasterTargetAction,
  type ScheduleMasterResult,
} from "@/server/actions/master-content-actions";
import { suggestSlotsAction } from "@/server/actions/slot-suggest-actions";

// The master-content card (spec 3.9.5): one main message, channel chips derived
// at render from the host's live channel states, "Adapt to channels" (a Route
// Handler: it is a multi-second model call) and "Add to calendar".
//
// Button budget: at most three buttons and one primary per state; there is no
// Preview. "Add to calendar" never commits on the first tap: it opens ONE inline
// panel that shows the lead channel's suggested slot first (two taps, like Plan
// it), so the dates are known BEFORE the commit.

type SlotPair = { date: string; time: string };

const ADAPT = "adapt";
const READAPT = "readapt";
const CHECK = "check";
const OPEN_SCHEDULE = "open-schedule";
const OPEN_MAKE = "open-make";
const COMMIT = "commit";
const COMMIT_MAKE = "commit-make";
const CANCEL = "cancel";
const TOGGLE_PREFIX = "toggle:";
const ADD_PREFIX = "add:";

const MASTER_CARD_SELECTOR =
  "[data-card='master-content'], [data-card='content-plan-draft']";

type Panel = {
  lead: ChannelKey;
  slots: SlotPair[] | undefined;
  index: number;
  timezone: string;
  loading: boolean;
  // The last press was stopped by a brand rule; the primary becomes
  // "Add anyway" and "Add & make" goes away (money stays explicit).
  brandBlocked: boolean;
  // The label of the button that opened the panel, for focus on Cancel.
  opener: string;
};

// ---- pure helpers (SSR-testable) -------------------------------------------

// What "Add & make" spends on pictures over the ticked channels: the post's
// one picture, and each other picture format adapted from it (a paid call of
// its own). Null when no ticked channel makes a picture.
export function makeCostLine(
  targets: MasterContentCardData["targets"],
): string | null {
  const total = targets
    .filter((target) => target.included)
    .reduce(
      (sum, target) => sum + pieceCostUsd({ formatKey: target.formatKey }),
      0,
    );
  return total > 0 ? copyText("slot.cost", { cost: formatUsd(total) }) : null;
}

// The card's own button row. Draft: Adapt (primary) + Add to calendar.
// Adapted: Add to calendar (primary) + Add & make + quiet Re-adapt.
// "Check again" takes the quiet slot after a BUSY answer. Never more than three.
export function masterButtons(input: {
  state: "draft" | "adapted";
  busyId: string | null;
  // The chat can make the post right after the commit.
  canMake: boolean;
  canReadapt: boolean;
  checkAgain: boolean;
  disabledReason: string | null;
}): CardButton[] {
  const reason = input.disabledReason
    ? { disabledReason: input.disabledReason }
    : {};
  const server = (id: string) => ({ kind: "server" as const, id });
  const checkButton: CardButton = {
    id: CHECK,
    label: copyText("master.checkAgain"),
    emphasis: "quiet",
    action: server(CHECK),
  };
  if (input.state === "draft") {
    return [
      {
        id: ADAPT,
        label:
          input.busyId === ADAPT
            ? copyText("master.adapting")
            : copyText("master.adapt"),
        emphasis: "primary",
        action: server(ADAPT),
        ...reason,
      },
      {
        id: OPEN_SCHEDULE,
        label: copyText("master.schedule"),
        emphasis: "secondary",
        action: server(OPEN_SCHEDULE),
        ...reason,
      },
      ...(input.checkAgain ? [checkButton] : []),
    ];
  }
  return [
    {
      id: OPEN_SCHEDULE,
      label: copyText("master.schedule"),
      emphasis: "primary",
      action: server(OPEN_SCHEDULE),
      ...reason,
    },
    ...(input.canMake
      ? [
          {
            id: OPEN_MAKE,
            label: copyText("master.scheduleMake"),
            emphasis: "secondary" as const,
            action: server(OPEN_MAKE),
            ...reason,
          },
        ]
      : []),
    ...(input.checkAgain
      ? [checkButton]
      : input.canReadapt
        ? [
            {
              id: READAPT,
              label:
                input.busyId === READAPT
                  ? copyText("master.adapting")
                  : copyText("master.readapt"),
              emphasis: "quiet" as const,
              action: server(READAPT),
              ...reason,
            },
          ]
        : []),
  ];
}

export type AdaptOutcome =
  { ok: true } | { ok: false; code: string; message: string; busy?: boolean };

// The adapt route's answer as the card acts on it. A wrong-kind / not-found
// answer means the card changed under us: STALE refreshes the page.
export function mapAdaptResponse(
  status: number,
  payload: unknown,
): AdaptOutcome {
  const body =
    typeof payload === "object" && payload !== null
      ? (payload as { ok?: unknown; code?: unknown; message?: unknown })
      : {};
  if (status >= 200 && status < 300 && body.ok === true) return { ok: true };
  const code = typeof body.code === "string" ? body.code : "";
  switch (code) {
    case "MOCK":
      return { ok: false, code, message: copyText("master.adaptMock") };
    case "BUSY":
      return {
        ok: false,
        code,
        message: copyText("master.adaptBusy"),
        busy: true,
      };
    case "NO_TARGETS":
      return { ok: false, code, message: copyText("master.noTargets") };
    case "LIMIT":
      return { ok: false, code, message: copyText("master.adaptLimit") };
    case "WORK":
      return { ok: false, code, message: copyText("kit.workDone") };
    case "WRONG_KIND":
      return { ok: false, code: "STALE", message: copyText("kit.stale") };
    // Both carry a sentence written for the person (the budget notice, the
    // channel the Work does not cover); retrying would not help.
    case "OUTSIDE_WORK":
    case "BUDGET":
      return {
        ok: false,
        code,
        message:
          typeof body.message === "string" && body.message
            ? body.message
            : copyText("master.adaptFailed"),
      };
    default:
      return {
        ok: false,
        code: "FAILED",
        message: copyText("master.adaptFailed"),
      };
  }
}

export type MasterScheduleOutcome =
  | { kind: "ok" }
  | { kind: "stale"; channel?: string; slot?: SlotPair; message: string }
  | { kind: "brand"; message: string }
  // Another tab already turned the card into a plan: refresh instead.
  | { kind: "refresh"; message: string }
  | { kind: "error"; message: string };

// The body of the commit call: the suggestion the person is looking at leads,
// and the brand-rule override rides only on the "Add anyway" press after a
// brand block (never on the first press, never together with making).
export function scheduleOptionsOf(input: {
  shown: SlotPair | undefined;
  brandBlocked: boolean;
  andMake: boolean;
}): { leadSlot?: SlotPair; allowIssues?: true } {
  return {
    ...(input.shown
      ? { leadSlot: { date: input.shown.date, time: input.shown.time } }
      : {}),
    ...(input.brandBlocked && !input.andMake ? { allowIssues: true } : {}),
  };
}

type PlanStarter = Pick<
  NonNullable<ReturnType<typeof useChatPackage>>,
  "startPlan"
>;

// After a commit, "Add & make" makes the post right away, live in the chat:
// the master's Command is now the saved plan, so the chat's plan run takes it
// (one picture, the other formats adapted from it). Plain "Add to calendar"
// makes nothing. True when a run was started.
export function startMaking(input: {
  andMake: boolean;
  commandId: string;
  chatPackage: PlanStarter | null;
}): boolean {
  if (!input.andMake || !input.chatPackage) return false;
  // The run streams for a while: the card does not wait for it.
  void input.chatPackage.startPlan({ commandId: input.commandId });
  return true;
}

export function mapScheduleMasterResult(
  result: ScheduleMasterResult,
): MasterScheduleOutcome {
  if (result.ok) return { kind: "ok" };
  switch (result.code) {
    case "STALE": {
      const suggestion = result.suggestion;
      return {
        kind: "stale",
        channel: suggestion?.channel,
        slot: suggestion
          ? { date: suggestion.date, time: suggestion.time }
          : undefined,
        message: result.message || copyText("kit.stale"),
      };
    }
    case "BRAND_RULES":
      return { kind: "brand", message: result.message };
    case "STATE":
      return { kind: "refresh", message: copyText("kit.stale") };
    case "NO_TARGETS":
      return { kind: "error", message: copyText("master.noTargets") };
    case "WORK":
      return { kind: "error", message: copyText("kit.workDone") };
    default:
      return {
        kind: "error",
        message: result.message || copyText("kit.failed"),
      };
  }
}

// ---- views -------------------------------------------------------------------

// The channel chips. Included chips toggle (aria-pressed); a locked chip is an
// included one that cannot publish yet and carries a Connect link; a channel
// outside the Work is a dashed "+ Add".
export function MasterChannelChips({
  chips,
  blocked,
  busyId,
  connectHrefOf,
  onToggle,
  onAdd,
}: {
  chips: readonly MasterChip[];
  blocked: boolean;
  busyId: string | null;
  connectHrefOf: (key: ChannelKey) => string;
  onToggle: (chip: MasterChip) => void;
  onAdd: (chip: MasterChip) => void;
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium" style={{ color: "var(--ws-text-2)" }}>
        {copyText("master.channelsLabel")}
      </p>
      <div
        role="group"
        aria-label={copyText("a11y.channels")}
        className="flex flex-wrap gap-2"
      >
        {chips.map((chip) => {
          if (chip.state === "outside") {
            const id = `${ADD_PREFIX}${chip.key}`;
            return (
              <button
                key={chip.key}
                type="button"
                data-chip={chip.key}
                data-chip-state="outside"
                aria-disabled={blocked ? "true" : undefined}
                aria-busy={busyId === id ? "true" : undefined}
                onClick={() => {
                  if (blocked) return;
                  onAdd(chip);
                }}
                className={cn(
                  "inline-flex min-h-11 items-center gap-2 rounded-xl border border-dashed px-3 py-2 text-sm font-medium outline-none transition-colors hover:bg-[var(--ws-hover)] focus-visible:ring-2 focus-visible:ring-ring/50",
                  blocked && "cursor-not-allowed opacity-50",
                )}
                style={{
                  borderColor: "var(--ws-border)",
                  color: "var(--ws-text-2)",
                }}
              >
                <ChannelMark channel={chip.key} className="size-5" decorative />
                {copyText("master.chip.add")} {chip.label}
              </button>
            );
          }
          const on = chip.state !== "excluded";
          const locked = chip.state === "locked";
          const subId = `master-chip-${chip.key}-locked`;
          return (
            <div
              key={chip.key}
              data-chip={chip.key}
              data-chip-state={chip.state}
              className="flex flex-wrap items-center gap-x-2 gap-y-0.5"
            >
              <button
                type="button"
                aria-pressed={on}
                aria-describedby={locked ? subId : undefined}
                aria-disabled={blocked ? "true" : undefined}
                aria-busy={
                  busyId === `${TOGGLE_PREFIX}${chip.key}:${on ? 0 : 1}`
                    ? "true"
                    : undefined
                }
                onClick={() => {
                  if (blocked) return;
                  onToggle(chip);
                }}
                className={cn(
                  "inline-flex min-h-11 items-center gap-2 rounded-xl border px-3 py-2 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
                  on
                    ? "border-primary bg-primary/5"
                    : "hover:bg-[var(--ws-hover)]",
                  blocked && "cursor-not-allowed opacity-50",
                )}
                style={on ? undefined : { borderColor: "var(--ws-border)" }}
              >
                <ChannelMark channel={chip.key} className="size-5" decorative />
                {chip.label}
              </button>
              {locked ? (
                <>
                  <span
                    id={subId}
                    className="text-xs"
                    style={{ color: "var(--ws-text-2)" }}
                  >
                    {copyText("master.chip.locked")}
                  </span>
                  <Link
                    href={connectHrefOf(chip.key)}
                    className="inline-flex min-h-11 items-center px-1 text-xs font-medium underline underline-offset-2"
                    style={{ color: "var(--ws-text)" }}
                  >
                    {copyText("master.chip.connect")}
                  </Link>
                </>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// One row per ticked channel once the message is adapted.
export function MasterTargetRows({
  targets,
  labelOf,
}: {
  targets: MasterContentCardData["targets"];
  labelOf: (channel: string) => string;
}) {
  const rows = targets.filter((t) => t.included && t.adaptation);
  if (rows.length === 0) return null;
  return (
    <ul className="space-y-2">
      {rows.map((target) => {
        const text = target.adaptation!;
        const issues = text.issues ?? [];
        return (
          <li
            key={`${target.channel}:${target.formatKey}`}
            data-target-row={target.channel}
            className="space-y-1 rounded-xl border p-3"
            style={{ borderColor: "var(--ws-border)" }}
          >
            <WsTag>
              {isChannelKey(target.channel) ? (
                <ChannelMark
                  channel={target.channel}
                  className="size-4"
                  decorative
                />
              ) : null}
              {labelOf(target.channel)}
            </WsTag>
            <p
              className="text-sm font-semibold"
              style={{ color: "var(--ws-text)" }}
            >
              {text.topic}
            </p>
            <p
              className="text-xs leading-5"
              style={{ color: "var(--ws-text-2)" }}
            >
              {text.captionIdea}
            </p>
            {issues.length > 0 ? (
              <div data-row-issues="" className="space-y-0.5">
                <p
                  className="text-xs font-medium"
                  style={{ color: "var(--ws-pending)" }}
                >
                  {copyText("master.issues")}
                </p>
                <ul
                  className="list-disc pl-4 text-xs"
                  style={{ color: "var(--ws-text-2)" }}
                >
                  {issues.map((issue, index) => (
                    <li key={index}>{issue}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

// The inline schedule panel. Presentational: every decision is a callback.
export function MasterSchedulePanelView({
  leadLabel,
  slots,
  index,
  timezone,
  loading,
  manyChannels,
  canMake,
  costLine,
  brandBlocked,
  busyId,
  error,
  disabledReason,
  onOther,
  onAct,
}: {
  leadLabel: string;
  slots: readonly SlotPair[] | undefined;
  index: number;
  timezone?: string;
  loading: boolean;
  // More than one channel is ticked: one post, so they all share this time.
  manyChannels: boolean;
  canMake: boolean;
  costLine: string | null;
  brandBlocked: boolean;
  busyId: string | null;
  error: string | null;
  disabledReason: string | null;
  onOther: () => void;
  onAct: (button: CardButton) => void;
}) {
  const total = slots?.length ?? 0;
  const slot = total > 0 ? slots![index % total] : undefined;
  const noSlot = !loading && slots !== undefined && !slot;
  const blockReason =
    disabledReason ??
    (loading
      ? copyText("ideaOptions.finding")
      : noSlot
        ? copyText("ideaOptions.noSlot", { channel: leadLabel })
        : null);
  const reason = blockReason ? { disabledReason: blockReason } : {};
  const buttons: CardButton[] = [
    {
      id: COMMIT,
      label: brandBlocked
        ? copyText("brand.addAnyway")
        : copyText("master.schedule"),
      emphasis: "primary",
      action: { kind: "server", id: COMMIT },
      ...reason,
    },
    ...(canMake && !brandBlocked
      ? [
          {
            id: COMMIT_MAKE,
            label: copyText("master.scheduleMake"),
            emphasis: "secondary" as const,
            action: { kind: "server" as const, id: COMMIT_MAKE },
            ...reason,
          },
        ]
      : []),
    {
      id: CANCEL,
      label: copyText("kit.cancel"),
      emphasis: "quiet",
      action: { kind: "server", id: CANCEL },
    },
  ];
  return (
    <div
      role="group"
      aria-label={leadLabel}
      data-master-panel=""
      className="space-y-3 rounded-xl border p-3"
      style={{ borderColor: "var(--ws-border)" }}
    >
      <div className="space-y-1">
        <p className="text-xs font-medium" style={{ color: "var(--ws-text)" }}>
          {leadLabel}
        </p>
        <SlotSuggestion
          label={
            slot
              ? copyText("ideaOptions.suggested", {
                  when: slotWhenLabel(slot.date, slot.time),
                })
              : ""
          }
          loading={loading}
          empty={
            noSlot
              ? copyText("ideaOptions.noSlot", { channel: leadLabel })
              : null
          }
          hasOther={total > 1}
          onOther={onOther}
          zone={timezone}
        />
        {manyChannels ? (
          <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
            {copyText("master.panelNote")}
          </p>
        ) : null}
      </div>
      {costLine && canMake && !brandBlocked ? (
        <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
          {costLine}
        </p>
      ) : null}
      <CardActions
        buttons={buttons}
        onAct={onAct}
        busyId={busyId}
        error={error}
        disabledReason={disabledReason}
      />
    </div>
  );
}

// ---- IO ----------------------------------------------------------------------

async function postAdapt(
  projectId: string,
  commandId: string,
): Promise<AdaptOutcome> {
  try {
    const response = await fetch(
      `/api/projects/${projectId}/chat/master/adapt`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commandId }),
      },
    );
    const payload: unknown = await response.json().catch(() => null);
    return mapAdaptResponse(response.status, payload);
  } catch {
    return {
      ok: false,
      code: "FAILED",
      message: copyText("master.adaptFailed"),
    };
  }
}

// A superseded card points at the newest master or plan of the thread.
function scrollToNewerCard(ownCommandId: string): void {
  const all = Array.from(
    document.querySelectorAll<HTMLElement>(MASTER_CARD_SELECTOR),
  );
  const target = [...all]
    .reverse()
    .find((node) => node.getAttribute("data-card-id") !== ownCommandId);
  if (!target) return;
  const reduced = window.matchMedia?.(
    "(prefers-reduced-motion: reduce)",
  ).matches;
  target.scrollIntoView({
    behavior: reduced ? "auto" : "smooth",
    block: "start",
  });
  target.querySelector<HTMLElement>("h3")?.focus({ preventScroll: true });
}

// ---- the card ----------------------------------------------------------------

export function MasterContentCard({
  card,
  commandId,
}: {
  card: MasterContentCardData;
  commandId: string;
}) {
  const host = useWorkCardHost();
  const chatPackage = useChatPackage();
  const [panel, setPanel] = useState<Panel | null>(null);
  // The route answered BUSY: another tab is adapting.
  const [adaptBusy, setAdaptBusy] = useState(false);
  // Validation and suggestion-load errors that never reach a Server Action.
  const [localError, setLocalError] = useState<string | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const restoreLabel = useRef<string | null>(null);
  // A newer open/toggle supersedes a suggestion fetch still in flight.
  const loadSeq = useRef(0);

  // Focus goes back to the opener once the panel is gone (a DOM side effect,
  // no state).
  useEffect(() => {
    if (panel) return;
    const label = restoreLabel.current;
    if (!label) return;
    restoreLabel.current = null;
    const buttons = Array.from(
      rowRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [],
    );
    buttons.find((button) => button.textContent?.trim() === label)?.focus();
  }, [panel]);

  const closePanel = (restoreFocus: boolean) => {
    loadSeq.current += 1;
    if (restoreFocus && panel) restoreLabel.current = panel.opener;
    setPanel(null);
    setLocalError(null);
  };

  const connectedSet = new Set<string>(
    (host?.channels ?? []).filter((c) => c.connected).map((c) => c.key),
  );
  const includedCount = card.targets.filter((t) => t.included).length;

  const openPanel = async (opener: CardButton) => {
    if (!host) return;
    setLocalError(null);
    const lead = leadChannelOf(card.targets, connectedSet);
    if (!lead || !isChannelKey(lead.channel)) {
      setLocalError(copyText("master.noTargets"));
      return;
    }
    const leadKey: ChannelKey = lead.channel;
    const seq = ++loadSeq.current;
    setPanel({
      lead: leadKey,
      slots: undefined,
      index: 0,
      timezone: host.timezone ?? "",
      loading: true,
      brandBlocked: false,
      opener: opener.label,
    });
    let slots: SlotPair[] | undefined;
    let timezone = "";
    let failed = false;
    try {
      const result = await suggestSlotsAction(host.projectId, host.workId, {
        channels: [leadKey],
      });
      if (result.ok) {
        slots = result.byChannel[leadKey] ?? [];
        timezone = result.timezone;
      } else {
        failed = true;
      }
    } catch {
      failed = true;
    }
    if (seq !== loadSeq.current) return;
    if (failed) setLocalError(copyText("kit.failed"));
    setPanel((current) =>
      current && current.lead === leadKey
        ? {
            ...current,
            loading: false,
            slots: failed ? undefined : slots,
            timezone: timezone || current.timezone,
          }
        : current,
    );
  };

  const otherTime = () => {
    if (!panel || !host || !panel.slots || panel.slots.length < 2) return;
    const next = (panel.index + 1) % panel.slots.length;
    setPanel({ ...panel, index: next });
    const slot = panel.slots[next]!;
    host.announce(
      copyText("ideaOptions.live.time", {
        i: next + 1,
        n: panel.slots.length,
        when: slotWhenLabel(slot.date, slot.time),
      }),
    );
  };

  const commit = async (andMake: boolean): Promise<CardActionResult> => {
    if (!host || !panel) {
      return { ok: false, message: copyText("kit.failed") };
    }
    const shown =
      panel.slots && panel.slots.length > 0
        ? panel.slots[panel.index % panel.slots.length]
        : undefined;
    // Focus first: the plan card that replaces this one takes it.
    host.requestFocus(commandId);
    let outcome: MasterScheduleOutcome;
    try {
      outcome = mapScheduleMasterResult(
        await scheduleMasterAction(
          commandId,
          scheduleOptionsOf({
            shown,
            brandBlocked: panel.brandBlocked,
            andMake,
          }),
        ),
      );
    } catch (error) {
      host.cancelFocus(commandId);
      throw error;
    }
    if (outcome.kind === "ok") {
      toast.success(copyText("master.scheduled"));
      setPanel(null);
      const making = startMaking({ andMake, commandId, chatPackage });
      return {
        ok: true,
        message: making
          ? `${copyText("master.scheduled")} ${copyText("kit.reasonRun")}`
          : copyText("master.scheduled"),
      };
    }
    host.cancelFocus(commandId);
    if (outcome.kind === "refresh") {
      return { ok: false, code: "STALE", message: outcome.message };
    }
    if (outcome.kind === "stale") {
      const { channel, slot } = outcome;
      setPanel((current) => {
        if (!current) return current;
        // The fresh suggestion goes first; the old list stays behind it.
        if (!slot || (channel && channel !== current.lead)) {
          return { ...current, slots: undefined, index: 0, loading: false };
        }
        const rest = (current.slots ?? []).filter(
          (s) => !(s.date === slot.date && s.time === slot.time),
        );
        return { ...current, slots: [slot, ...rest], index: 0 };
      });
      return { ok: false, code: "SUGGESTION", message: outcome.message };
    }
    if (outcome.kind === "brand") {
      setPanel((current) =>
        current ? { ...current, brandBlocked: true } : current,
      );
    }
    return { ok: false, code: "SCHEDULE", message: outcome.message };
  };

  const { run, busyId, error } = useCardAction({
    server: async (id): Promise<CardActionResult> => {
      if (!host) return { ok: false, message: copyText("kit.failed") };
      if (id === ADAPT || id === READAPT) {
        if (includedCount === 0) {
          return { ok: false, message: copyText("master.noTargets") };
        }
        setAdaptBusy(false);
        const outcome = await postAdapt(host.projectId, commandId);
        if (outcome.ok) return { ok: true, refresh: true };
        if (outcome.busy) setAdaptBusy(true);
        return { ok: false, code: outcome.code, message: outcome.message };
      }
      if (id === CHECK) {
        setAdaptBusy(false);
        return { ok: true, refresh: true };
      }
      if (id === COMMIT || id === COMMIT_MAKE) {
        return commit(id === COMMIT_MAKE);
      }
      if (id.startsWith(TOGGLE_PREFIX)) {
        const [channel, flag] = id.slice(TOGGLE_PREFIX.length).split(":");
        const result = await toggleMasterTargetAction(
          commandId,
          channel ?? "",
          flag === "1",
        );
        if (result.ok) return { ok: true };
        if (result.code === "STATE") {
          return { ok: false, code: "STALE", message: copyText("kit.stale") };
        }
        return {
          ok: false,
          code: result.code,
          message:
            result.code === "NO_TARGETS"
              ? copyText("master.noTargets")
              : result.code === "WORK"
                ? copyText("kit.workDone")
                : result.message || copyText("kit.failed"),
        };
      }
      if (id.startsWith(ADD_PREFIX)) {
        const result = await addMasterChannelAction(
          host.projectId,
          host.workId,
          commandId,
          id.slice(ADD_PREFIX.length),
        );
        if (result.ok) return { ok: true };
        if (result.code === "STATE") {
          return { ok: false, code: "STALE", message: copyText("kit.stale") };
        }
        return {
          ok: false,
          code: result.code,
          message:
            result.code === "WORK"
              ? copyText("kit.workDone")
              : result.message || copyText("kit.failed"),
        };
      }
      return { ok: false, message: copyText("kit.failed") };
    },
  });

  if (!host) return null;

  const superseded = card.state === "superseded";
  const hostReason = disabledReasonOf(host, { kind: "server" });
  const chips = chipStates({
    targets: card.targets,
    workChannels: host.channels,
    projectId: host.projectId,
  });
  const labelOf = (channel: string): string =>
    chips.find((chip) => chip.key === channel)?.label ?? channel;
  const anyBusy = busyId !== null;
  const chipsBlocked = !!hostReason || anyBusy;
  // Outside the chat nothing could make the post: no "Add & make" there.
  const canMake = chatPackage !== null;
  const costLine = makeCostLine(card.targets);
  const shownError = localError ?? error;

  const onToggle = (chip: MasterChip) => {
    // A tick change moves the lead channel: the open panel would be stale.
    if (panel) closePanel(false);
    setLocalError(null);
    const on = chip.state !== "excluded";
    if (on && includedCount <= 1) {
      setLocalError(copyText("master.noTargets"));
      return;
    }
    const id = `${TOGGLE_PREFIX}${chip.key}:${on ? 0 : 1}`;
    run({
      id,
      label: chip.label,
      emphasis: "quiet",
      action: { kind: "server", id },
    });
  };
  const onAdd = (chip: MasterChip) => {
    if (panel) closePanel(false);
    setLocalError(null);
    const id = `${ADD_PREFIX}${chip.key}`;
    run({
      id,
      label: chip.label,
      emphasis: "quiet",
      action: { kind: "server", id },
    });
  };

  const onAct = (button: CardButton) => {
    if (button.id === OPEN_SCHEDULE || button.id === OPEN_MAKE) {
      void openPanel(button);
      return;
    }
    if (button.id === CANCEL) {
      closePanel(true);
      return;
    }
    setLocalError(null);
    run(button);
  };

  const status = superseded
    ? { label: copyText("master.statusReplaced") }
    : card.state === "adapted"
      ? { label: copyText("master.statusAdapted"), tone: "positive" as const }
      : { label: copyText("master.statusDraft"), tone: "waiting" as const };

  const adaptRunsLeft = (card.adaptRuns ?? 0) < MAX_ADAPT_RUNS;

  let actions: React.ReactNode;
  if (superseded) {
    actions = (
      <Button
        type="button"
        size="sm"
        variant="ghost"
        data-emphasis="quiet"
        className="min-h-11 rounded-lg px-4"
        onClick={() => scrollToNewerCard(commandId)}
      >
        {copyText("kit.showNewer")}
      </Button>
    );
  } else if (panel) {
    actions = (
      <MasterSchedulePanelView
        leadLabel={labelOf(panel.lead)}
        slots={panel.slots}
        index={panel.index}
        timezone={panel.timezone}
        loading={panel.loading}
        manyChannels={includedCount > 1}
        canMake={canMake}
        costLine={costLine}
        brandBlocked={panel.brandBlocked}
        busyId={busyId}
        error={shownError}
        disabledReason={hostReason}
        onOther={otherTime}
        onAct={onAct}
      />
    );
  } else {
    actions = (
      <div ref={rowRef} className="space-y-1.5">
        <CardActions
          buttons={masterButtons({
            state: card.state === "adapted" ? "adapted" : "draft",
            busyId,
            canMake,
            canReadapt: adaptRunsLeft,
            checkAgain: adaptBusy,
            disabledReason: hostReason,
          })}
          onAct={onAct}
          busyId={busyId}
          error={shownError}
          disabledReason={hostReason}
        />
        {card.state === "adapted" && canMake && costLine ? (
          <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
            {costLine}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <ActionCard
      icon={Megaphone}
      title={card.title}
      status={status}
      width="wide"
      muted={superseded}
      cardId="master-content"
      commandId={commandId}
      actions={actions}
    >
      <div className="space-y-1">
        <p
          className="text-xs font-medium"
          style={{ color: "var(--ws-text-2)" }}
        >
          {copyText("master.messageLabel")}
        </p>
        <p
          className="whitespace-pre-line text-sm leading-6"
          style={{ color: "var(--ws-text)" }}
        >
          {card.master.message}
        </p>
      </div>
      {card.brandCheck ? (
        <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
          {brandCheckText(card.brandCheck)}
        </p>
      ) : null}
      {superseded ? null : (
        <>
          <MasterChannelChips
            chips={chips}
            blocked={chipsBlocked}
            busyId={busyId}
            connectHrefOf={(key) =>
              integrationsHref(host.projectId, key, {
                fromWorkId: host.workId,
              })
            }
            onToggle={onToggle}
            onAdd={onAdd}
          />
          {card.state === "adapted" ? (
            <MasterTargetRows targets={card.targets} labelOf={labelOf} />
          ) : null}
        </>
      )}
    </ActionCard>
  );
}
