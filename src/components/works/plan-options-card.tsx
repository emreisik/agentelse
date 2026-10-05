"use client";

import { useId } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Sparkles } from "lucide-react";

import { ChannelMark } from "@/components/commands/channel-badge";
import { WsTag } from "@/components/commands/ws-event-card";
import { Button } from "@/components/ui/button";
import { ActionCard } from "@/components/works/action-card";
import { useCardAction } from "@/components/works/use-card-action";
import {
  disabledReasonOf,
  useWorkCardHost,
} from "@/components/works/work-card-host";
import { CHANNELS, isChannelKey } from "@/lib/content-channels";
import { cn } from "@/lib/utils";
import type { BrandCheckState } from "@/lib/works/brand-rules";
import type { CardActionResult, CardButton } from "@/lib/works/card-action";
import { brandCheckText, copyText } from "@/lib/works/copy";
import type { PlanOption, PlanOptionsCardData } from "@/lib/works/plan-options";
import {
  pickPlanOptionAction,
  type PickPlanOptionResult,
} from "@/server/actions/plan-options-actions";

// The three plan directions (spec 2.2 and 3.2.4). One primary button PER
// OPTION REGION is the designed exception to the card-level button budget:
// the person has to choose. A pick is one Server Action (DB only); the new
// plan card takes focus and there is no router.refresh() on success.

const TWEAKS = [
  {
    id: "tweak:playful",
    label: "planOptions.tweak.playful",
    text: "Make the directions more playful.",
  },
  {
    id: "tweak:educational",
    label: "planOptions.tweak.educational",
    text: "Make the directions more educational.",
  },
  {
    id: "tweak:shorter",
    label: "planOptions.tweak.shorter",
    text: "Make the directions shorter and simpler.",
  },
] as const;

const PLAN_CARD_SELECTOR =
  "[data-card='content-plan-options'], [data-card='content-plan-draft']";

const PICK_PREFIX = "pick:";

// The pick result as the kit understands it. PICKED also refreshes: another
// tab or turn already turned this card into a plan, so the page is stale.
export function mapPickResult(
  result: PickPlanOptionResult,
  label: string,
): { result: CardActionResult; refresh: boolean } {
  if (result.ok) {
    return {
      result: {
        ok: true,
        message: copyText("planOptions.live.picked", { label }),
      },
      refresh: false,
    };
  }
  switch (result.code) {
    case "PICKED":
      return {
        result: {
          ok: false,
          code: "PICKED",
          message: copyText("planOptions.alreadyPicked"),
        },
        refresh: true,
      };
    case "STATE":
      return {
        result: {
          ok: false,
          code: "STATE",
          message: copyText("planOptions.replaced"),
        },
        refresh: false,
      };
    case "WORK":
      return {
        result: {
          ok: false,
          code: "WORK",
          message: copyText("kit.workDone"),
        },
        refresh: false,
      };
    default:
      return {
        result: {
          ok: false,
          code: result.code,
          message: copyText("planOptions.pickFailed"),
        },
        refresh: false,
      };
  }
}

// The quiet "Checked against N brand rules." line; absent on old cards.
export function BrandCheckLine({
  brandCheck,
}: {
  brandCheck: BrandCheckState | undefined;
}) {
  if (!brandCheck) return null;
  return (
    <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
      {brandCheckText(brandCheck)}
    </p>
  );
}

function channelLabelOf(channel: string): string {
  return isChannelKey(channel) ? CHANNELS[channel].label : channel;
}

// A failed pick leaves no new card behind, so its focus request is dropped.
// PICKED refreshes into the plan card another tab made: the request stays.
export function shouldCancelFocus(outcome: {
  result: CardActionResult;
  refresh: boolean;
}): boolean {
  return !outcome.result.ok && !outcome.refresh;
}

// A superseded card points at the newest directions or plan of the thread.
function scrollToNewerCard(ownCommandId: string): void {
  const all = Array.from(
    document.querySelectorAll<HTMLElement>(PLAN_CARD_SELECTOR),
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

function OptionRegion({
  option,
  channels,
  postCount,
  blocked,
  busy,
  describedBy,
  onPick,
}: {
  option: PlanOption;
  channels: string[];
  postCount: number;
  blocked: boolean;
  busy: boolean;
  describedBy: string | undefined;
  onPick: () => void;
}) {
  const first = option.ideas[0]?.topic;
  return (
    <div
      role="group"
      aria-label={copyText("a11y.option", { label: option.label })}
      data-option={option.id}
      className="space-y-2 rounded-xl border p-3"
      style={{ borderColor: "var(--ws-border)" }}
    >
      <div className="space-y-1">
        <p
          className="text-sm font-semibold"
          style={{ color: "var(--ws-text)" }}
        >
          {option.label}
        </p>
        <p
          className="line-clamp-2 text-xs leading-5"
          style={{ color: "var(--ws-text-2)" }}
        >
          {option.angle}
        </p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <WsTag>
          {postCount === 1
            ? copyText("planOptions.posts.one")
            : copyText("planOptions.posts.many", { n: postCount })}
        </WsTag>
        {channels.map((channel) => (
          <WsTag key={channel}>
            {isChannelKey(channel) ? (
              <ChannelMark channel={channel} className="size-4" decorative />
            ) : null}
            {channelLabelOf(channel)}
          </WsTag>
        ))}
        {option.basis ? (
          <WsTag>
            {copyText("planOptions.basis", { basis: option.basis })}
          </WsTag>
        ) : null}
      </div>
      {first ? (
        <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
          {copyText("planOptions.startsWith", { topic: first })}
        </p>
      ) : null}
      {option.ideas.length > 0 ? (
        <details className="text-xs" style={{ color: "var(--ws-text-2)" }}>
          <summary className="flex min-h-11 cursor-pointer items-center">
            {copyText("planOptions.allTopics", { n: option.ideas.length })}
          </summary>
          <ol className="list-decimal space-y-1 pb-1 pl-5">
            {option.ideas.map((idea, index) => (
              <li key={index}>{idea.topic}</li>
            ))}
          </ol>
        </details>
      ) : null}
      <Button
        type="button"
        size="sm"
        variant="default"
        data-emphasis="primary"
        aria-disabled={blocked ? "true" : undefined}
        aria-describedby={blocked ? describedBy : undefined}
        aria-busy={busy ? "true" : undefined}
        className={cn(
          "min-h-11 w-full rounded-lg px-4 sm:w-auto",
          blocked && "opacity-50",
          blocked && !busy && "cursor-not-allowed",
        )}
        onClick={() => {
          if (blocked) return;
          onPick();
        }}
      >
        {busy ? (
          <Loader2 className="animate-spin motion-reduce:animate-none" />
        ) : null}
        {busy ? copyText("planOptions.picking") : copyText("planOptions.pick")}
      </Button>
    </div>
  );
}

export function PlanOptionsCard({
  card,
  commandId,
}: {
  card: PlanOptionsCardData;
  commandId: string;
}) {
  const host = useWorkCardHost();
  const router = useRouter();
  const pickReasonId = useId();
  const chipReasonId = useId();
  const footnoteId = useId();
  const { run, busyId, error } = useCardAction({
    server: async (id) => {
      if (!id.startsWith(PICK_PREFIX)) {
        return { ok: false, message: copyText("kit.failed") };
      }
      const optionId = id.slice(PICK_PREFIX.length);
      const label =
        card.options.find((o) => o.id === optionId)?.label ?? card.title;
      // Focus first: the new plan card heading takes it on mount.
      host?.requestFocus(commandId);
      let outcome: ReturnType<typeof mapPickResult>;
      try {
        outcome = mapPickResult(
          await pickPlanOptionAction(commandId, optionId),
          label,
        );
      } catch (error) {
        host?.cancelFocus(commandId);
        throw error;
      }
      if (shouldCancelFocus(outcome)) host?.cancelFocus(commandId);
      if (outcome.refresh) router.refresh();
      return outcome.result;
    },
  });
  if (!host) return null;

  const superseded = card.state === "superseded";
  const anyBusy = busyId !== null;
  const pickReason = superseded
    ? copyText("planOptions.replaced")
    : disabledReasonOf(host, { kind: "server" });
  const chipReason = superseded
    ? copyText("planOptions.replaced")
    : disabledReasonOf(host, { kind: "send" });
  // The same sentence is shown once.
  const chipReasonSeparate = !!chipReason && chipReason !== pickReason;
  const blocked = !!pickReason || anyBusy;
  const chipsBlocked = !!chipReason || anyBusy;
  // A post goes to every channel of the brief, not only its slot's own.
  const channels = [
    ...new Set([
      ...card.slots.map((slot) => slot.channel),
      ...(card.platforms ?? []),
    ]),
  ];

  const pick = (option: PlanOption) => {
    const button: CardButton = {
      id: `${PICK_PREFIX}${option.id}`,
      label: copyText("planOptions.pick"),
      emphasis: "primary",
      action: { kind: "server", id: `${PICK_PREFIX}${option.id}` },
    };
    run(button);
  };

  return (
    <ActionCard
      icon={Sparkles}
      title={card.title}
      reason={card.reason}
      width="wide"
      cardId="content-plan-options"
      commandId={commandId}
      muted={superseded}
      status={
        superseded
          ? { label: copyText("planOptions.statusReplaced") }
          : { label: copyText("planOptions.statusOpen"), tone: "waiting" }
      }
      actions={
        <div className="space-y-1.5">
          {superseded ? (
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
          ) : null}
          {error ? (
            <p
              role="alert"
              className="text-xs"
              style={{ color: "var(--destructive)" }}
            >
              {error}
            </p>
          ) : null}
        </div>
      }
    >
      <BrandCheckLine brandCheck={card.brandCheck} />
      <div
        role="group"
        aria-label={copyText("a11y.directions")}
        className="space-y-2"
      >
        {card.options.map((option) => (
          <OptionRegion
            key={option.id}
            option={option}
            channels={channels}
            postCount={card.slots.length}
            blocked={blocked}
            busy={busyId === `${PICK_PREFIX}${option.id}`}
            describedBy={pickReason ? pickReasonId : undefined}
            onPick={() => pick(option)}
          />
        ))}
      </div>
      {pickReason ? (
        <p
          id={pickReasonId}
          className="text-xs"
          style={{ color: "var(--ws-text-2)" }}
        >
          {pickReason}
        </p>
      ) : null}
      <p
        id={footnoteId}
        className="text-xs"
        style={{ color: "var(--ws-text-2)" }}
      >
        {copyText("planOptions.footnote")}
      </p>
      <div
        role="group"
        aria-labelledby={footnoteId}
        className="flex flex-wrap gap-2"
      >
        {TWEAKS.map((tweak) => (
          <Button
            key={tweak.id}
            type="button"
            size="sm"
            variant="ghost"
            data-emphasis="quiet"
            data-tweak={tweak.id}
            aria-disabled={chipsBlocked ? "true" : undefined}
            aria-describedby={
              chipReason
                ? chipReasonSeparate
                  ? chipReasonId
                  : pickReasonId
                : undefined
            }
            className={cn(
              "min-h-11 rounded-lg border px-4",
              chipsBlocked && "opacity-50",
              chipsBlocked && "cursor-not-allowed",
            )}
            style={{ borderColor: "var(--ws-border)" }}
            onClick={() => {
              if (chipsBlocked) return;
              run({
                id: tweak.id,
                label: copyText(tweak.label),
                emphasis: "quiet",
                action: { kind: "send", text: tweak.text },
              });
            }}
          >
            {copyText(tweak.label)}
          </Button>
        ))}
      </div>
      {chipReasonSeparate ? (
        <p
          id={chipReasonId}
          className="text-xs"
          style={{ color: "var(--ws-text-2)" }}
        >
          {chipReason}
        </p>
      ) : null}
    </ActionCard>
  );
}
