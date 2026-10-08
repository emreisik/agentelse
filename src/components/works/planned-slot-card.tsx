"use client";

import { useState } from "react";
import { CalendarClock } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { ChannelMark } from "@/components/commands/channel-badge";
import { useChatPackage } from "@/components/commands/chat-package-context";
import type { WsTone } from "@/components/commands/ws-event-card";
import { ActionCard } from "@/components/works/action-card";
import { CardActions } from "@/components/works/card-actions";
import { CardLiveRegion } from "@/components/works/live-region";
import { SlotSuggestion } from "@/components/works/slot-suggestion";
import { useCardAction } from "@/components/works/use-card-action";
import {
  disabledReasonOf,
  useWorkCardHost,
} from "@/components/works/work-card-host";
import { CHANNELS, resolvePlanItem } from "@/lib/content-channels";
import { STAGE_LABEL } from "@/lib/content-plan-view";
import type { PlanItemStage } from "@/lib/journey";
import { blocksOf } from "@/lib/works/brand-rules";
import type { CardActionResult, CardButton } from "@/lib/works/card-action";
import { copyText } from "@/lib/works/copy";
import { produceCostNote } from "@/lib/works/cost";
import { slotWhenLabel } from "@/lib/works/slot-rules";
import {
  moveSlotAction,
  removeSlotAction,
} from "@/server/actions/schedule-slots-actions";
import { suggestSlotsAction } from "@/server/actions/slot-suggest-actions";
import type { IdeaEventCardData } from "@/types/idea-event-card";

type PlanCard = Extract<IdeaEventCardData, { kind: "content-plan-draft" }>;
type SlotPair = { date: string; time: string };

const STAGE_TONE: Record<PlanItemStage, WsTone> = {
  PLANNED: "neutral",
  PRODUCING: "waiting",
  FAILED: "danger",
  IN_REVIEW: "waiting",
  REJECTED: "danger",
  APPROVED: "positive",
  PUBLISHED: "positive",
};

// Brings the creative's card into view when it is on the page.
function revealCreative(creativeId: string): boolean {
  const cards = document.querySelectorAll<HTMLElement>(
    `[data-creative-id="${CSS.escape(creativeId)}"]`,
  );
  const card = cards[cards.length - 1];
  if (!card) return false;
  card.scrollIntoView({ behavior: "smooth", block: "center" });
  return true;
}

// The compact card of ONE post that went straight onto the calendar (an idea,
// "create a post", a suggestion or a brief): where it stands, what the next
// step is, and the two things a person may still want: another time, or to
// take it back off the calendar while it has no content.
export function PlannedSlotCard({
  card,
  commandId,
}: {
  card: PlanCard;
  commandId?: string;
}) {
  const host = useWorkCardHost();
  const chatPackage = useChatPackage();
  const router = useRouter();
  const [timeOpen, setTimeOpen] = useState(false);
  const [times, setTimes] = useState<SlotPair[] | null>(null);
  const [timeIndex, setTimeIndex] = useState(0);
  const [timeNote, setTimeNote] = useState<string | null>(null);
  const [timeSpoken, setTimeSpoken] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const item = card.items[0];
  const slot = card.slots?.[0] ?? null;
  const resolved = item ? resolvePlanItem(item) : undefined;

  const loadTimes = async (): Promise<void> => {
    if (!host || !resolved) return;
    setTimes(null);
    setTimeNote(null);
    const result = await suggestSlotsAction(host.projectId, host.workId, {
      channels: [resolved.channel],
    });
    if (!result.ok) {
      setTimes([]);
      setTimeNote(result.message);
      return;
    }
    setTimes(result.byChannel[resolved.channel] ?? []);
    setTimeIndex(0);
  };

  const { run, busyId, error } = useCardAction({
    server: async (id): Promise<CardActionResult> => {
      if (!host || !item) return { ok: false, message: copyText("kit.failed") };
      switch (id) {
        case "slot:produce": {
          if (!commandId || !chatPackage) {
            return { ok: false, message: copyText("kit.failed") };
          }
          // One post, one picture: only this post's channels are made, live
          // in the chat. A plan saved before posts has no post id; its run
          // takes the plan's one piece anyway. The run streams for a while:
          // do not hold the button for it.
          const postId = slot?.postId;
          void chatPackage.startPlan(
            postId ? { commandId, postId } : { commandId },
          );
          return { ok: true };
        }
        case "slot:time": {
          const next = !timeOpen;
          setTimeOpen(next);
          setConfirming(false);
          if (next && times === null) await loadTimes();
          return { ok: true };
        }
        case "slot:review": {
          if (!slot) return { ok: true };
          if (!revealCreative(slot.id)) {
            router.push(
              `/projects/${host.projectId}/takvim?creative=${slot.id}`,
            );
          }
          return { ok: true };
        }
        case "slot:save-time": {
          const pick = times?.[timeIndex];
          if (!slot || !pick) return { ok: true };
          const result = await moveSlotAction(
            host.projectId,
            host.workId,
            slot.id,
            pick,
          );
          if (!result.ok) {
            return { ok: false, code: result.code, message: result.message };
          }
          // The action revalidates the page: no router.refresh.
          toast.success(copyText("slot.timeSaved"));
          setTimeOpen(false);
          return { ok: true, message: copyText("slot.timeSaved") };
        }
        case "slot:remove-ask":
          setConfirming(true);
          setTimeOpen(false);
          return { ok: true };
        case "slot:keep":
          setConfirming(false);
          return { ok: true };
        case "slot:remove": {
          if (!slot) return { ok: true };
          const result = await removeSlotAction(
            host.projectId,
            host.workId,
            slot.id,
          );
          if (!result.ok) {
            return { ok: false, code: result.code, message: result.message };
          }
          setConfirming(false);
          return { ok: true, message: copyText("slot.removed") };
        }
        default:
          return { ok: false, message: copyText("kit.failed") };
      }
    },
  });

  if (!host || !item) return null;

  const calendarHref = `/projects/${host.projectId}/takvim`;
  const openCalendar: CardButton = {
    id: "slot:calendar",
    label: copyText("kit.openCalendar"),
    emphasis: "quiet",
    action: { kind: "link", href: calendarHref },
  };

  if (item.removed === true) {
    return (
      <ActionCard
        icon={CalendarClock}
        title={item.topic}
        reason={copyText("slot.removed")}
        muted
        cardId="content-plan-draft"
        commandId={commandId}
        actions={
          <CardActions buttons={[openCalendar]} onAct={run} busyId={busyId} />
        }
      />
    );
  }

  const stage = slot?.stage ?? null;
  const blockedReason = (planId?: string) =>
    disabledReasonOf(host, { kind: "server", planId });
  const produceReason = blockedReason(commandId);
  const anyReason = blockedReason();

  const costNote = produceCostNote([
    {
      formatKey: item.formatKey,
      channel: resolved?.channel,
      photo: (item.photoAssetIds?.length ?? 0) > 0,
    },
  ]);
  const costLine = costNote
    ? copyText("slot.cost", { cost: costNote.replace(/^about /, "") })
    : null;

  const main: CardButton[] = [];
  if (stage === "PLANNED") {
    main.push(
      {
        id: "slot:produce",
        label: copyText("slot.produce"),
        emphasis: "primary",
        action: { kind: "server", id: "slot:produce" },
        disabledReason: produceReason ?? undefined,
      },
      {
        id: "slot:time",
        label: copyText("slot.changeTime"),
        emphasis: "secondary",
        action: { kind: "server", id: "slot:time" },
        disabledReason: anyReason ?? undefined,
      },
    );
  } else if (stage === "FAILED") {
    main.push({
      id: "slot:produce",
      label: copyText("kit.tryAgain"),
      emphasis: "primary",
      action: { kind: "server", id: "slot:produce" },
      disabledReason: produceReason ?? undefined,
    });
  } else if (stage === "IN_REVIEW") {
    main.push({
      id: "slot:review",
      label: copyText("slot.review"),
      emphasis: "primary",
      action: { kind: "server", id: "slot:review" },
    });
  }
  main.push(openCalendar);

  const shownTime = times?.[timeIndex];
  const flags = item.brandFlags ?? [];
  const where = resolved
    ? `${CHANNELS[resolved.channel].label} ${resolved.format.label}`
    : (item.platform ?? "");
  const zone = host.timezone ?? card.timezone;
  const makesPicture = stage === "PLANNED" || stage === "FAILED";

  return (
    <ActionCard
      icon={CalendarClock}
      title={item.topic}
      reason={copyText("slot.added")}
      status={
        stage
          ? { label: STAGE_LABEL[stage], tone: STAGE_TONE[stage] }
          : undefined
      }
      footnote={zone ? copyText("slot.zone", { zone }) : undefined}
      cardId="content-plan-draft"
      commandId={commandId}
      actions={
        <div className="space-y-1.5">
          <div data-slot-actions>
            <CardActions
              buttons={main}
              onAct={run}
              busyId={busyId}
              error={error}
              disabledAll={false}
              disabledReason={anyReason}
            />
          </div>
          {makesPicture && costLine ? (
            <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
              {costLine}
            </p>
          ) : null}
          {stage === "PLANNED" && slot && !confirming ? (
            <CardActions
              buttons={[
                {
                  id: "slot:remove-ask",
                  label: copyText("slot.remove"),
                  emphasis: "quiet",
                  action: { kind: "server", id: "slot:remove-ask" },
                },
              ]}
              onAct={run}
              busyId={busyId}
              disabledAll={anyReason !== null}
            />
          ) : null}
        </div>
      }
    >
      <p
        className="flex items-center gap-2 text-sm"
        style={{ color: "var(--ws-text)" }}
      >
        {resolved ? (
          <ChannelMark
            channel={resolved.channel}
            className="size-5"
            decorative
          />
        ) : null}
        <span>
          {copyText("slot.where", {
            when: slotWhenLabel(item.date, item.time),
            where,
          })}
        </span>
      </p>
      {flags.length > 0 ? (
        <span
          data-brand-chip
          className="inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium"
          style={{ borderColor: "var(--ws-border)", color: "var(--ws-text-2)" }}
        >
          {copyText(
            blocksOf(flags).length > 0 ? "brand.chip.block" : "brand.chip.warn",
          )}
        </span>
      ) : null}
      {timeOpen ? (
        <div data-change-time className="space-y-2">
          <SlotSuggestion
            label={
              shownTime
                ? copyText("ideaOptions.suggested", {
                    when: slotWhenLabel(shownTime.date, shownTime.time),
                  })
                : ""
            }
            loading={times === null}
            empty={
              times !== null && times.length === 0
                ? copyText("slot.noFree")
                : null
            }
            hasOther={(times?.length ?? 0) > 1}
            onOther={() => {
              if (!times || times.length < 2) return;
              const next = (timeIndex + 1) % times.length;
              const pick = times[next];
              setTimeIndex(next);
              if (pick) {
                setTimeSpoken(
                  copyText("ideaOptions.live.time", {
                    i: next + 1,
                    n: times.length,
                    when: slotWhenLabel(pick.date, pick.time),
                  }),
                );
              }
            }}
          />
          <CardLiveRegion message={timeSpoken} />
          {timeNote ? (
            <p
              role="alert"
              className="text-xs"
              style={{ color: "var(--destructive)" }}
            >
              {timeNote}
            </p>
          ) : null}
          {shownTime ? (
            <CardActions
              buttons={[
                {
                  id: "slot:save-time",
                  label: copyText("slot.confirmTime"),
                  emphasis: "secondary",
                  action: { kind: "server", id: "slot:save-time" },
                },
              ]}
              onAct={run}
              busyId={busyId}
              disabledAll={anyReason !== null}
            />
          ) : null}
        </div>
      ) : null}
      {confirming ? (
        <div data-remove-confirm role="group" className="space-y-1.5">
          <p className="text-sm" style={{ color: "var(--ws-text)" }}>
            {copyText("slot.removeAsk")}
          </p>
          <CardActions
            buttons={[
              {
                id: "slot:remove",
                label: copyText("slot.removeYes"),
                emphasis: "secondary",
                action: { kind: "server", id: "slot:remove" },
              },
              {
                id: "slot:keep",
                label: copyText("slot.keep"),
                emphasis: "quiet",
                action: { kind: "server", id: "slot:keep" },
              },
            ]}
            onAct={run}
            busyId={busyId}
            disabledAll={anyReason !== null}
          />
        </div>
      ) : null}
    </ActionCard>
  );
}
