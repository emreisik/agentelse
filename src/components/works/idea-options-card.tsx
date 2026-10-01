"use client";

import { useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Lightbulb } from "lucide-react";
import { toast } from "sonner";

import { useChatPackage } from "@/components/commands/chat-package-context";
import { Button } from "@/components/ui/button";
import { ActionCard } from "@/components/works/action-card";
import { CardActions } from "@/components/works/card-actions";
import { BrandCheckLine } from "@/components/works/plan-options-card";
import { SlotSuggestion } from "@/components/works/slot-suggestion";
import { useCardAction } from "@/components/works/use-card-action";
import {
  disabledReasonOf,
  useWorkCardHost,
} from "@/components/works/work-card-host";
import {
  CHANNELS,
  defaultFormat,
  isChannelKey,
  type ChannelKey,
} from "@/lib/content-channels";
import { cn } from "@/lib/utils";
import type { CardButton } from "@/lib/works/card-action";
import { copyText } from "@/lib/works/copy";
import { produceCostNote } from "@/lib/works/cost";
import type { IdeaOptionsCardData } from "@/lib/works/idea-options";
import { slotWhenLabel } from "@/lib/works/slot-rules";
import {
  scheduleSlotsAction,
  type ScheduleSlotsResult,
} from "@/server/actions/schedule-slots-actions";
import { suggestSlotsAction } from "@/server/actions/slot-suggest-actions";

// The idea list (spec 2.2 and 3.4.8). "Plan it" opens ONE inline panel at a
// time; its suggestions are fetched in the click handler, never in an effect.
// Scheduling is one Server Action (its revalidatePath returns the page, so
// there is no router.refresh() on success); "Add & produce" then starts the
// plan's production through the same explicit-consent path as Save & produce.

type SlotPair = { date: string; time: string };
type SlotsByChannel = Partial<Record<string, SlotPair[]>>;
type IndexByChannel = Partial<Record<string, number>>;

type Panel = {
  ideaId: string;
  selected: ChannelKey[];
  byChannel: SlotsByChannel;
  index: IndexByChannel;
  timezone: string;
  loading: boolean;
  // The last press was stopped by a brand rule; the primary becomes
  // "Add anyway" (it only adds, never produces: money stays explicit).
  brandBlocked: boolean;
};

export type PanelChannel = { key: ChannelKey; label: string };

const ADD = "add";
const PRODUCE = "produce";
const CANCEL = "cancel";

function channelLabelOf(channel: string): string {
  return isChannelKey(channel) ? CHANNELS[channel].label : channel;
}

// The slot each selected channel currently shows; channels without a free
// day are left out.
export function buildTargets(
  selected: readonly string[],
  byChannel: SlotsByChannel,
  index: IndexByChannel,
): { channel: string; date: string; time: string }[] {
  const targets: { channel: string; date: string; time: string }[] = [];
  for (const channel of selected) {
    const slots = byChannel[channel];
    if (!slots || slots.length === 0) continue;
    const slot = slots[(index[channel] ?? 0) % slots.length]!;
    targets.push({ channel, date: slot.date, time: slot.time });
  }
  return targets;
}

export type ScheduleOutcome =
  | { kind: "ok"; commandId: string; alreadyScheduled: boolean }
  | {
      kind: "stale";
      channel?: string;
      slot?: SlotPair;
      message: string;
    }
  | { kind: "brand"; message: string }
  | { kind: "error"; message: string };

// The schedule result as the card acts on it.
export function mapScheduleResult(
  result: ScheduleSlotsResult,
): ScheduleOutcome {
  if (result.ok) {
    return {
      kind: "ok",
      commandId: result.commandId,
      alreadyScheduled: result.alreadyScheduled,
    };
  }
  switch (result.code) {
    case "STALE": {
      const suggestion = "suggestion" in result ? result.suggestion : undefined;
      return {
        kind: "stale",
        channel: suggestion?.channel,
        slot: suggestion
          ? { date: suggestion.date, time: suggestion.time }
          : undefined,
        message: copyText("kit.stale"),
      };
    }
    case "BRAND_RULES":
      return { kind: "brand", message: result.message };
    case "IDEA_GONE":
      return { kind: "error", message: copyText("ideaOptions.gone") };
    case "WORK":
      return { kind: "error", message: copyText("kit.workDone") };
    default:
      return {
        kind: "error",
        message: result.message || copyText("kit.failed"),
      };
  }
}

// The panel under one idea. Presentational (SSR-testable): every decision
// is a callback.
export function IdeaPlanPanelView({
  channels,
  selected,
  byChannel,
  index,
  timezone,
  loading,
  noChannel,
  brandBlocked,
  busyId,
  error,
  disabledReason,
  onToggle,
  onOther,
  onAct,
}: {
  channels: readonly PanelChannel[];
  selected: readonly ChannelKey[];
  byChannel: SlotsByChannel;
  index: IndexByChannel;
  timezone?: string;
  loading: boolean;
  noChannel: boolean;
  brandBlocked: boolean;
  busyId: string | null;
  error: string | null;
  // Why the buttons cannot be used right now (Work completed...), or null.
  disabledReason: string | null;
  onToggle: (key: ChannelKey) => void;
  onOther: (channel: ChannelKey) => void;
  onAct: (button: CardButton) => void;
}) {
  const targets = buildTargets(selected, byChannel, index);
  const costNote = produceCostNote(
    selected
      .filter((key) => targets.some((t) => t.channel === key))
      .map((key) => ({ formatKey: defaultFormat(key).key })),
  );
  const emptyChannel = selected.find(
    (key) => !targets.some((t) => t.channel === key),
  );
  const noSlotReason =
    targets.length === 0
      ? loading
        ? copyText("ideaOptions.finding")
        : emptyChannel
          ? copyText("ideaOptions.noSlot", {
              channel: channelLabelOf(emptyChannel),
            })
          : null
      : null;
  const blockReason = disabledReason ?? noSlotReason;
  const reasonFor = (reason: string | null) =>
    reason ? { disabledReason: reason } : {};

  const buttons: CardButton[] = [
    {
      id: ADD,
      label: brandBlocked
        ? copyText("brand.addAnyway")
        : copyText("ideaOptions.add"),
      emphasis: "primary",
      action: { kind: "server", id: ADD },
      ...reasonFor(blockReason),
    },
    ...(brandBlocked
      ? []
      : [
          {
            id: PRODUCE,
            label: costNote
              ? copyText("ideaOptions.addProduceCost", { cost: costNote })
              : copyText("ideaOptions.addProduce"),
            emphasis: "secondary" as const,
            action: { kind: "server" as const, id: PRODUCE },
            ...reasonFor(blockReason),
          },
        ]),
    {
      id: CANCEL,
      label: copyText("kit.cancel"),
      emphasis: "quiet",
      action: { kind: "server", id: CANCEL },
    },
  ];

  return (
    <div
      data-idea-panel=""
      className="space-y-3 rounded-xl border p-3"
      style={{ borderColor: "var(--ws-border)" }}
    >
      <p className="text-xs font-medium" style={{ color: "var(--ws-text-2)" }}>
        {copyText("ideaOptions.where")}
      </p>
      <div
        role="group"
        aria-label={copyText("a11y.channels")}
        className="flex flex-wrap gap-2"
      >
        {channels.map((channel) => {
          const on = selected.includes(channel.key);
          return (
            <button
              key={channel.key}
              type="button"
              aria-pressed={on}
              onClick={() => onToggle(channel.key)}
              className={cn(
                "min-h-11 rounded-xl border px-3 py-2 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
                on
                  ? "border-primary bg-primary/5"
                  : "hover:bg-[var(--ws-hover)]",
              )}
              style={on ? undefined : { borderColor: "var(--ws-border)" }}
            >
              {channel.label}
            </button>
          );
        })}
      </div>
      {noChannel ? (
        <p
          role="alert"
          className="text-xs"
          style={{ color: "var(--destructive)" }}
        >
          {copyText("ideaOptions.noChannel")}
        </p>
      ) : null}
      <div className="space-y-2">
        {selected.map((key, position) => {
          const slots = byChannel[key];
          const total = slots?.length ?? 0;
          const at = total > 0 ? (index[key] ?? 0) % total : 0;
          const slot = slots?.[at];
          return (
            <div
              key={key}
              role="group"
              aria-label={channelLabelOf(key)}
              className="space-y-1"
            >
              {selected.length > 1 ? (
                <p
                  className="text-xs font-medium"
                  style={{ color: "var(--ws-text)" }}
                >
                  {channelLabelOf(key)}
                </p>
              ) : null}
              <SlotSuggestion
                label={
                  slot
                    ? copyText("ideaOptions.suggested", {
                        when: slotWhenLabel(slot.date, slot.time),
                      })
                    : ""
                }
                loading={slots === undefined && loading}
                empty={
                  slots !== undefined && !slot
                    ? copyText("ideaOptions.noSlot", {
                        channel: channelLabelOf(key),
                      })
                    : null
                }
                hasOther={total > 1}
                onOther={() => onOther(key)}
                zone={position === 0 ? timezone : undefined}
              />
            </div>
          );
        })}
      </div>
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

export function IdeaOptionsCard({
  card,
  commandId,
}: {
  card: IdeaOptionsCardData;
  commandId: string;
}) {
  const host = useWorkCardHost();
  const router = useRouter();
  const chatPackage = useChatPackage();
  const [panel, setPanel] = useState<Panel | null>(null);
  const [noChannel, setNoChannel] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const openers = useRef<Record<string, HTMLButtonElement | null>>({});
  // The row of each idea: after an Add the opener button unmounts, so focus
  // moves to its row instead of falling back to <body>.
  const rows = useRef<Record<string, HTMLLIElement | null>>({});
  const idBase = useId();
  // A newer open/toggle supersedes a suggestion fetch still in flight.
  const loadSeq = useRef(0);

  const closePanel = (ideaId: string) => {
    loadSeq.current += 1;
    setPanel(null);
    setNoChannel(false);
    setLoadError(null);
    openers.current[ideaId]?.focus();
  };

  const fetchSlots = async (
    channels: readonly ChannelKey[],
  ): Promise<{ timezone: string; byChannel: SlotsByChannel } | null> => {
    if (!host) return null;
    const seq = ++loadSeq.current;
    try {
      const result = await suggestSlotsAction(host.projectId, host.workId, {
        channels: [...channels],
      });
      if (seq !== loadSeq.current) return null;
      if (!result.ok) {
        setLoadError(copyText("kit.failed"));
        return null;
      }
      return { timezone: result.timezone, byChannel: result.byChannel };
    } catch {
      if (seq === loadSeq.current) setLoadError(copyText("kit.failed"));
      return null;
    }
  };

  const openPanel = async (ideaId: string) => {
    if (!host) return;
    if (panel?.ideaId === ideaId) {
      closePanel(ideaId);
      return;
    }
    // Ideas carry no channel of their own: the Work's first channel starts.
    const first = host.channels[0]?.key;
    const selected: ChannelKey[] = first ? [first] : [];
    setNoChannel(false);
    setLoadError(null);
    setPanel({
      ideaId,
      selected,
      byChannel: {},
      index: {},
      timezone: host.timezone ?? "",
      loading: selected.length > 0,
      brandBlocked: false,
    });
    if (selected.length === 0) return;
    const loaded = await fetchSlots(selected);
    setPanel((current) =>
      current && current.ideaId === ideaId
        ? {
            ...current,
            loading: false,
            ...(loaded
              ? {
                  byChannel: { ...current.byChannel, ...loaded.byChannel },
                  timezone: loaded.timezone || current.timezone,
                }
              : {}),
          }
        : current,
    );
  };

  const toggleChannel = async (key: ChannelKey) => {
    if (!panel) return;
    const on = panel.selected.includes(key);
    if (on && panel.selected.length === 1) {
      // At least one channel stays selected.
      setNoChannel(true);
      return;
    }
    setNoChannel(false);
    const selected = on
      ? panel.selected.filter((k) => k !== key)
      : [...panel.selected, key];
    const needsLoad = !on && panel.byChannel[key] === undefined;
    setPanel({ ...panel, selected, loading: needsLoad, brandBlocked: false });
    if (!needsLoad) return;
    const ideaId = panel.ideaId;
    const loaded = await fetchSlots([key]);
    setPanel((current) =>
      current && current.ideaId === ideaId
        ? {
            ...current,
            loading: false,
            ...(loaded
              ? {
                  byChannel: { ...current.byChannel, ...loaded.byChannel },
                  timezone: loaded.timezone || current.timezone,
                }
              : {}),
          }
        : current,
    );
  };

  const otherTime = (channel: ChannelKey) => {
    if (!panel || !host) return;
    const slots = panel.byChannel[channel];
    if (!slots || slots.length < 2) return;
    const next = ((panel.index[channel] ?? 0) + 1) % slots.length;
    setPanel({ ...panel, index: { ...panel.index, [channel]: next } });
    const slot = slots[next]!;
    host.announce(
      copyText("ideaOptions.live.time", {
        i: next + 1,
        n: slots.length,
        when: slotWhenLabel(slot.date, slot.time),
      }),
    );
  };

  const { run, busyId, error } = useCardAction({
    server: async (id) => {
      if (!host || !panel || (id !== ADD && id !== PRODUCE)) {
        return { ok: false, message: copyText("kit.failed") };
      }
      const targets = buildTargets(
        panel.selected,
        panel.byChannel,
        panel.index,
      );
      if (targets.length === 0) {
        return { ok: false, message: copyText("kit.failed") };
      }
      const outcome = mapScheduleResult(
        await scheduleSlotsAction(host.projectId, host.workId, {
          ideaId: panel.ideaId,
          targets,
          // Only the "Add anyway" press (it never produces).
          ...(panel.brandBlocked && id === ADD ? { allowIssues: true } : {}),
        }),
      );
      if (outcome.kind === "ok") {
        const message = outcome.alreadyScheduled
          ? copyText("ideaOptions.already")
          : copyText("ideaOptions.added");
        if (outcome.alreadyScheduled) {
          // Not on this card's overlay, so it sits on the calendar from
          // another Work (or the overlay has not caught up yet).
          toast.success(copyText("ideaOptions.alreadyElsewhere"), {
            action: {
              label: copyText("kit.openCalendar"),
              onClick: () => router.push(`/projects/${host.projectId}/takvim`),
            },
          });
        } else {
          toast.success(message);
        }
        if (id === PRODUCE && chatPackage) {
          // Not awaited: a production runs for minutes and reports itself.
          void chatPackage
            .startPlan({ commandId: outcome.commandId })
            .then((started) => {
              if (!started.ok) toast.error(copyText("kit.failed"));
            })
            .catch(() => toast.error(copyText("kit.failed")));
        }
        setPanel(null);
        setNoChannel(false);
        rows.current[panel.ideaId]?.focus();
        return { ok: true, message };
      }
      if (outcome.kind === "stale") {
        if (outcome.channel && outcome.slot) {
          const { channel, slot } = outcome;
          setPanel((current) => {
            if (!current) return current;
            const rest = (current.byChannel[channel] ?? []).filter(
              (s) => !(s.date === slot.date && s.time === slot.time),
            );
            return {
              ...current,
              byChannel: { ...current.byChannel, [channel]: [slot, ...rest] },
              index: { ...current.index, [channel]: 0 },
            };
          });
        } else {
          const loaded = await fetchSlots(panel.selected);
          if (loaded) {
            setPanel((current) =>
              current
                ? {
                    ...current,
                    byChannel: { ...current.byChannel, ...loaded.byChannel },
                    index: {},
                  }
                : current,
            );
          }
        }
        return { ok: false, code: "SUGGESTION", message: outcome.message };
      }
      if (outcome.kind === "brand") {
        setPanel((current) =>
          current ? { ...current, brandBlocked: true } : current,
        );
      }
      return { ok: false, code: "SCHEDULE", message: outcome.message };
    },
  });

  if (!host) return null;

  const hostReason = disabledReasonOf(host, { kind: "server" });
  const channelsText = host.channels.map((c) => c.label).join(", ");
  const title =
    card.title.trim() ||
    copyText("ideaOptions.titleDefault", {
      n: card.items.length,
      channels: channelsText,
    });
  const anyBusy = busyId !== null;
  const planItBlocked = !!hostReason || anyBusy;

  return (
    <ActionCard
      icon={Lightbulb}
      title={title}
      reason={card.reason.trim() || copyText("ideaOptions.reasonDefault")}
      width="wide"
      cardId="idea-options"
      commandId={commandId}
    >
      <BrandCheckLine brandCheck={card.brandCheck} />
      <ul className="space-y-2">
        {card.items.map((item) => {
          const scheduled = card.scheduled?.[item.ideaId];
          const open = panel?.ideaId === item.ideaId;
          return (
            <li
              key={item.ideaId}
              ref={(node: HTMLLIElement | null) => {
                rows.current[item.ideaId] = node;
              }}
              tabIndex={-1}
              className="space-y-2 rounded-xl border p-3 outline-none"
              style={{ borderColor: "var(--ws-border)" }}
            >
              <div className="space-y-1">
                <p
                  id={`${idBase}-${item.ideaId}`}
                  className="text-sm font-semibold"
                  style={{ color: "var(--ws-text)" }}
                >
                  {item.title}
                </p>
                <p
                  className="line-clamp-3 text-xs leading-5"
                  style={{ color: "var(--ws-text-2)" }}
                >
                  {item.description}
                </p>
              </div>
              {scheduled ? (
                <div className="space-y-1">
                  <p
                    className="text-xs font-medium"
                    style={{ color: "var(--ws-text)" }}
                  >
                    {copyText("ideaOptions.scheduled", {
                      when: slotWhenLabel(scheduled.date, scheduled.time),
                    })}
                  </p>
                  <CardActions
                    buttons={[
                      {
                        id: `calendar:${item.ideaId}`,
                        label: copyText("kit.openCalendar"),
                        emphasis: "quiet",
                        action: {
                          kind: "link",
                          href: `/projects/${host.projectId}/takvim`,
                        },
                      },
                    ]}
                    onAct={() => undefined}
                  />
                </div>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant={open ? "ghost" : "default"}
                  data-emphasis={open ? "quiet" : "primary"}
                  aria-expanded={open}
                  aria-describedby={`${idBase}-${item.ideaId}`}
                  aria-disabled={planItBlocked ? "true" : undefined}
                  ref={(node: HTMLButtonElement | null) => {
                    openers.current[item.ideaId] = node;
                  }}
                  className={cn(
                    "min-h-11 w-full rounded-lg px-4 sm:w-auto",
                    planItBlocked && "opacity-50 cursor-not-allowed",
                  )}
                  onClick={() => {
                    if (planItBlocked) return;
                    void openPanel(item.ideaId);
                  }}
                >
                  {copyText("ideaOptions.plan")}
                </Button>
              )}
              {open && panel && !scheduled ? (
                <IdeaPlanPanelView
                  channels={host.channels}
                  selected={panel.selected}
                  byChannel={panel.byChannel}
                  index={panel.index}
                  timezone={panel.timezone}
                  loading={panel.loading}
                  noChannel={noChannel}
                  brandBlocked={panel.brandBlocked}
                  busyId={busyId}
                  error={error ?? loadError}
                  disabledReason={hostReason}
                  onToggle={(key) => void toggleChannel(key)}
                  onOther={otherTime}
                  onAct={(button) => {
                    if (button.id === CANCEL) {
                      closePanel(item.ideaId);
                      return;
                    }
                    run(button);
                  }}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
      {hostReason && !panel ? (
        <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
          {hostReason}
        </p>
      ) : null}
    </ActionCard>
  );
}
