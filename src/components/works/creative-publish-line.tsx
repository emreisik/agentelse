"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { CardActions } from "@/components/works/card-actions";
import { SlotSuggestion } from "@/components/works/slot-suggestion";
import {
  disabledReasonOf,
  useWorkCardHost,
  type WorkCardHostValue,
} from "@/components/works/work-card-host";
import {
  CHANNELS,
  isChannelKey,
  type ChannelKey,
} from "@/lib/content-channels";
import type { CardButton } from "@/lib/works/card-action";
import { copyText } from "@/lib/works/copy";
import type { CreativePublishLine as PublishLine } from "@/lib/works/publish-guard";
import { slotWhenLabel } from "@/lib/works/slot-rules";
import { integrationsHref } from "@/lib/works/starter-cards";
import { publishCreativeToInstagramAction } from "@/server/actions/publish-actions";
import { enablePlanPublishingAction } from "@/server/actions/plan-progress-actions";
import {
  moveSlotAction,
  type MoveSlotResult,
} from "@/server/actions/schedule-slots-actions";
import { suggestSlotsAction } from "@/server/actions/slot-suggest-actions";

const DEFAULT_ZONE = "Europe/Istanbul";

// ISO instant -> 'Fri 2 Oct, 11:00' on the project's wall clock.
export function whenLabelOf(iso: string, timezone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone || DEFAULT_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? "00";
  return slotWhenLabel(
    `${part("year")}-${part("month")}-${part("day")}`,
    `${part("hour")}:${part("minute")}`,
  );
}

function channelName(channel: string | undefined): string {
  return channel && isChannelKey(channel)
    ? CHANNELS[channel].label
    : (channel ?? "");
}

// The sentence of a line. Failed and publishing never fall through to a
// "goes out" text: the line kind decides, not the time.
export function publishLineText(line: PublishLine, timezone?: string): string {
  const when = (iso?: string) => (iso ? whenLabelOf(iso, timezone) : "");
  switch (line.kind) {
    case "review":
      switch (line.consequence) {
        case "scheduled":
          return line.plannedFor
            ? copyText("publish.review.scheduled", {
                when: when(line.plannedFor),
              })
            : copyText("publish.review.nextSlot");
        case "scheduled-off":
          return copyText("publish.review.scheduledOff");
        case "held":
          return copyText("publish.review.held");
        case "manual":
          return copyText("publish.review.manual");
        case "locked":
          return copyText("publish.review.locked", {
            channel: channelName(line.channel),
          });
      }
      return "";
    case "scheduled":
      if (!line.released) {
        return copyText("publish.scheduledOff", {
          when: when(line.plannedFor),
        });
      }
      return line.plannedFor
        ? copyText("publish.scheduled", { when: when(line.plannedFor) })
        : copyText("publish.nextSlot");
    case "held":
      return copyText(
        line.reason === "no-time" ? "publish.held" : "publish.heldPast",
      );
    case "manual":
      return copyText("publish.manual", { when: when(line.plannedFor) });
    case "locked":
      return copyText("publish.locked", { channel: channelName(line.channel) });
    case "publishing":
      return copyText("publish.publishing");
    case "failed":
      return line.reason
        ? copyText("publish.failedWhy", { reason: line.reason })
        : copyText("publish.failed");
    case "published":
      return copyText("publish.published");
  }
}

// Post now goes through the project's Instagram connection, so it depends on
// the PROJECT's connections, not on which channels this Work covers (Change
// channels may have dropped Instagram while a held Instagram piece remains).
// A host without the project list falls back to the Work's channels.
export function isInstagramConnected(
  host: Pick<WorkCardHostValue, "channels" | "connectedChannels">,
): boolean {
  if (host.connectedChannels) {
    return host.connectedChannels.includes("instagram");
  }
  return host.channels.find((c) => c.key === "instagram")?.connected === true;
}

// Blocks a server button with the host's reason. Cancel only closes the open
// panel and changes nothing, so it is never blocked: a Work completed in
// another tab must not trap the person inside an open confirm panel.
export function gateButton(
  button: CardButton,
  reason: string | null,
): CardButton {
  if (button.id === "cancel") return button;
  return button.action.kind === "server" && reason
    ? { ...button, disabledReason: reason }
    : button;
}

export type LineMode = "idle" | "confirm" | "time";

// The Post now state machine, kept pure so the two-step rule is testable:
// the first tap only asks, only the second one posts.
export function stepPublishMode(
  mode: LineMode,
  buttonId: string,
): { mode: LineMode; post: boolean } {
  switch (buttonId) {
    case "post-now":
    case "try-again":
      return { mode: "confirm", post: false };
    case "confirm-post":
      return {
        mode: mode === "confirm" ? "idle" : mode,
        post: mode === "confirm",
      };
    case "set-time":
      return { mode: "time", post: false };
    case "cancel":
      return { mode: "idle", post: false };
    default:
      return { mode, post: false };
  }
}

export type LineButtonContext = {
  projectId: string;
  workId: string;
  // Is Instagram connected (Post now is only offered then).
  instagramConnected: boolean;
};

// The buttons of a line in its resting state (at most three, one primary).
export function publishLineButtons(
  line: PublishLine,
  ctx: LineButtonContext,
): CardButton[] {
  const server = (id: string): CardButton["action"] => ({ kind: "server", id });
  const postNow = (id: string, label: string): CardButton => ({
    id,
    label,
    emphasis: "quiet",
    action: server(id),
  });
  switch (line.kind) {
    case "review":
      return line.consequence === "scheduled-off"
        ? [
            {
              id: "turn-on",
              label: copyText("publish.turnOn"),
              emphasis: "secondary",
              action: server("turn-on"),
            },
          ]
        : [];
    case "scheduled":
      return line.released
        ? []
        : [
            {
              id: "turn-on",
              label: copyText("publish.turnOn"),
              emphasis: "secondary",
              action: server("turn-on"),
            },
          ];
    case "held": {
      const buttons: CardButton[] = [
        {
          id: "set-time",
          label: copyText("publish.setTime"),
          emphasis: "primary",
          action: server("set-time"),
        },
      ];
      if (ctx.instagramConnected) {
        buttons.push(postNow("post-now", copyText("publish.postNow")));
      }
      return buttons;
    }
    case "failed": {
      const buttons: CardButton[] = [];
      if (ctx.instagramConnected) {
        buttons.push({
          id: "try-again",
          label: copyText("kit.tryAgain"),
          emphasis: "primary",
          action: server("try-again"),
        });
      }
      buttons.push({
        id: "set-time",
        label: copyText("publish.setTime"),
        emphasis: buttons.length ? "secondary" : "primary",
        action: server("set-time"),
      });
      return buttons;
    }
    case "manual":
      return [
        {
          id: "post-it",
          label: copyText("publish.postIt"),
          emphasis: "primary",
          action: server("post-it"),
        },
      ];
    case "locked": {
      const key: ChannelKey | undefined = isChannelKey(line.channel)
        ? line.channel
        : undefined;
      return [
        {
          id: "connect",
          label: copyText("publish.connect", {
            channel: channelName(line.channel),
          }),
          emphasis: "primary",
          action: {
            kind: "link",
            href: integrationsHref(ctx.projectId, key, {
              fromWorkId: ctx.workId,
            }),
          },
        },
      ];
    }
    case "publishing":
    case "published":
      return [];
  }
}

type Slot = { date: string; time: string };

type LineCard = {
  creativeId: string;
  platform?: string | null;
  contentFormat?: string | null;
  publishLine?: PublishLine;
};

export function CreativePublishLine({ card }: { card: LineCard }) {
  const host = useWorkCardHost();
  const router = useRouter();
  const [mode, setMode] = useState<LineMode>("idle");
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [slotIndex, setSlotIndex] = useState(0);
  const [pending, startTransition] = useTransition();
  const guard = useRef(false);

  const channel =
    card.platform && isChannelKey(card.platform.toLowerCase())
      ? card.platform.toLowerCase()
      : "instagram";
  const workId = host?.workId;
  const projectId = host?.projectId;
  const inTimeMode = mode === "time";

  useEffect(() => {
    if (!inTimeMode || !projectId || !workId) return;
    let live = true;
    void suggestSlotsAction(projectId, workId, { channels: [channel] })
      .then((result) => {
        if (!live) return;
        setSlots(result.ok ? (result.byChannel[channel] ?? []) : []);
      })
      .catch(() => {
        if (live) setSlots([]);
      });
    return () => {
      live = false;
    };
  }, [inTimeMode, projectId, workId, channel]);

  const line = card.publishLine;
  if (!host || !line) return null;
  const zone = host.timezone ?? DEFAULT_ZONE;
  const instagramConnected = isInstagramConnected(host);
  const ctx: LineButtonContext = {
    projectId: host.projectId,
    workId: host.workId,
    instagramConnected,
  };
  const reason = disabledReasonOf(host, { kind: "server" });
  const gate = (button: CardButton): CardButton =>
    gateButton(button, reason);

  const gated = (list: CardButton[]): CardButton[] => list.map(gate);

  const format = card.contentFormat === "STORY" ? "STORIES" : "FEED";
  const slot = slots?.[slotIndex];

  const fail = (message: string) => setError(message);

  const act = (button: CardButton) => {
    if (guard.current) return;
    setError(null);
    const step = stepPublishMode(mode, button.id);
    if (button.id === "set-time") {
      setSlots(null);
      setSlotIndex(0);
    }
    setMode(step.mode);
    if (step.post) {
      guard.current = true;
      setBusyId(button.id);
      startTransition(async () => {
        try {
          const result = await publishCreativeToInstagramAction(
            card.creativeId,
            format,
          );
          if (result.ok) {
            toast.success(copyText("publish.postSent"));
            host.announce(copyText("publish.postSent"));
            router.refresh();
          } else {
            fail(result.message);
          }
        } catch {
          fail(copyText("kit.failed"));
        } finally {
          guard.current = false;
          setBusyId(null);
        }
      });
      return;
    }
    if (button.id === "post-it") {
      host.runNextStep({
        key: "publish-manual",
        tone: "blocker",
        label: copyText("publish.postIt"),
        title: "",
        action: { kind: "publish_manual", creativeIds: [card.creativeId] },
      });
      return;
    }
    if (button.id === "turn-on") {
      guard.current = true;
      setBusyId(button.id);
      startTransition(async () => {
        try {
          const result = await enablePlanPublishingAction(host.projectId);
          if (result.ok) router.refresh();
          else fail(result.message);
        } catch {
          fail(copyText("kit.failed"));
        } finally {
          guard.current = false;
          setBusyId(null);
        }
      });
      return;
    }
    if (button.id === "save-time" && slot) {
      guard.current = true;
      setBusyId(button.id);
      startTransition(async () => {
        try {
          const result: MoveSlotResult = await moveSlotAction(
            host.projectId,
            host.workId,
            card.creativeId,
            slot,
          );
          if (result.ok) {
            toast.success(copyText("publish.timeSaved"));
            host.announce(copyText("publish.timeSaved"));
            setMode("idle");
            router.refresh();
          } else {
            fail(result.message);
          }
        } catch {
          fail(copyText("kit.failed"));
        } finally {
          guard.current = false;
          setBusyId(null);
        }
      });
    }
  };

  const wrapper = "space-y-2 border-t pt-2";
  const wrapperStyle = {
    borderColor: "var(--ws-border)",
    color: "var(--ws-text-2)",
  };

  if (mode === "confirm") {
    return (
      <div className={wrapper} style={wrapperStyle} data-publish-line="confirm">
        <p className="text-xs">{copyText("publish.postConfirm")}</p>
        <CardActions
          buttons={gated([
            {
              id: "confirm-post",
              label: copyText("publish.postNow"),
              emphasis: "primary",
              action: { kind: "server", id: "confirm-post" },
            },
            {
              id: "cancel",
              label: copyText("kit.cancel"),
              emphasis: "quiet",
              action: { kind: "server", id: "cancel" },
            },
          ])}
          onAct={act}
          busyId={pending ? busyId : null}
          error={error}
        />
      </div>
    );
  }

  if (mode === "time") {
    return (
      <div className={wrapper} style={wrapperStyle} data-publish-line="time">
        <SlotSuggestion
          label={slot ? slotWhenLabel(slot.date, slot.time) : ""}
          loading={slots === null}
          empty={slots !== null && !slot ? copyText("slot.noFree") : null}
          hasOther={(slots?.length ?? 0) > 1}
          onOther={() => setSlotIndex((i) => (i + 1) % (slots?.length ?? 1))}
          zone={zone}
        />
        <CardActions
          buttons={gated([
            ...(slot
              ? [
                  {
                    id: "save-time",
                    label: copyText("slot.confirmTime"),
                    emphasis: "primary" as const,
                    action: { kind: "server" as const, id: "save-time" },
                  },
                ]
              : []),
            {
              id: "cancel",
              label: copyText("kit.cancel"),
              emphasis: "quiet" as const,
              action: { kind: "server" as const, id: "cancel" },
            },
          ])}
          onAct={act}
          busyId={pending ? busyId : null}
          error={error}
        />
      </div>
    );
  }

  const buttons = publishLineButtons(line, ctx).map(gate);
  return (
    <div
      className={wrapper}
      style={wrapperStyle}
      data-publish-line={line.kind}
      aria-busy={line.kind === "publishing" ? "true" : undefined}
    >
      <p className="text-xs">{publishLineText(line, zone)}</p>
      {buttons.length || error ? (
        <CardActions
          buttons={buttons}
          onAct={act}
          busyId={pending ? busyId : null}
          error={error}
        />
      ) : null}
    </div>
  );
}
