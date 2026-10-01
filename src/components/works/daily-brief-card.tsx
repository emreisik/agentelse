"use client";

import { Fragment, useState } from "react";
import { useRouter } from "next/navigation";
import { Sun } from "lucide-react";

import { ChannelBadge } from "@/components/commands/channel-badge";
import { WsStatusPill } from "@/components/commands/ws-event-card";
import { workHref } from "@/components/layout/work-list";
import { ActionCard } from "@/components/works/action-card";
import { CardActions } from "@/components/works/card-actions";
import { useCardAction } from "@/components/works/use-card-action";
import {
  disabledReasonOf,
  useWorkCardHost,
} from "@/components/works/work-card-host";
import type { CardAction, CardButton } from "@/lib/works/card-action";
import { copyText } from "@/lib/works/copy";
import type {
  BriefAction,
  BriefRow,
  BriefRowGroup,
  DailyBrief,
} from "@/lib/works/daily-brief";
import { slotWhenLabel } from "@/lib/works/slot-rules";
import { openChannelWorkAction } from "@/server/actions/work-actions";

// The Today Work's daily brief (spec 3.11.4). Live data, never stored: the
// page recomputes it on every render. Row buttons are list-row actions; the
// footer holds at most two buttons and its primary is never a next step.

// The jump target of the header's "Today's brief" button.
export const DAILY_BRIEF_ANCHOR = "daily-brief";

const GROUP_LABEL: Partial<Record<BriefRowGroup, string>> = {
  content: copyText("brief.group.content"),
  seo: copyText("brief.group.seo"),
  ads: copyText("brief.group.ads"),
};

export function nextButtonLabel(next: NonNullable<DailyBrief["next"]>): string {
  return next.costNote
    ? copyText("brief.nextCost", { label: next.label, cost: next.costNote })
    : next.label;
}

// The weekday is computed, never hard-coded (the same formatter as slots).
export function briefDayLabel(day: string): string {
  return slotWhenLabel(day, "").split(",")[0] ?? day;
}

export function yesterdayLine(
  yesterday: NonNullable<DailyBrief["yesterday"]>,
): string {
  if (yesterday.published === 0 && yesterday.failed === 0) {
    return copyText("brief.yesterdayNone");
  }
  return copyText("brief.yesterday", {
    published: yesterday.published,
    failed: yesterday.failed,
  });
}

// next / open-channel-work are not CardActions: the button carries a
// placeholder and onAct finds the real action by the button id.
function toCardAction(id: string, action: BriefAction): CardAction {
  return action.kind === "next" || action.kind === "open-channel-work"
    ? { kind: "server", id }
    : action;
}

// The real action behind a button id (see the button builder below).
function actionOf(card: DailyBrief, id: string): BriefAction | undefined {
  if (id === "brief:primary") return card.primary.action;
  if (id === "brief:secondary") return card.secondary?.action;
  if (id === "row:next") {
    return card.next ? { kind: "next", step: card.next.step } : undefined;
  }
  return card.rows.find((row) => `row:${row.id}` === id)?.action;
}

function GroupLabel({ children }: { children: string }) {
  return (
    <p
      className="px-0.5 pt-1 text-[11px] font-semibold tracking-[0.08em] uppercase"
      style={{ color: "var(--ws-text-3)" }}
    >
      {children}
    </p>
  );
}

export function DailyBriefCard({ card }: { card: DailyBrief }) {
  const host = useWorkCardHost();
  const router = useRouter();
  const { run, busyId, error } = useCardAction({});
  const [localBusy, setLocalBusy] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  if (!host) return null;

  const button = (
    id: string,
    label: string,
    emphasis: CardButton["emphasis"],
    action: BriefAction,
  ): CardButton => {
    const cardAction = toCardAction(id, action);
    return {
      id,
      label,
      emphasis,
      action: cardAction,
      disabledReason:
        disabledReasonOf(host, {
          kind: cardAction.kind,
        }) ?? undefined,
    };
  };

  const onAct = (clicked: CardButton) => {
    const action = actionOf(card, clicked.id);
    if (!action) return;
    if (action.kind === "next") {
      host.runNextStep(action.step);
      return;
    }
    if (action.kind === "open-channel-work") {
      setLocalBusy(clicked.id);
      setLocalError(null);
      void openChannelWorkAction(host.projectId, action.channel)
        .then((result) => {
          if (!result.ok) {
            setLocalError(result.message);
            return;
          }
          router.push(workHref(host.projectId, result.workId));
        })
        .catch(() => setLocalError(copyText("kit.failed")))
        .finally(() => setLocalBusy(null));
      return;
    }
    run({ ...clicked, action });
  };

  const busy = localBusy ?? busyId;
  const failure = localError ?? error;
  const empty = card.rows.length === 0 && !card.next;

  const primary = button(
    "brief:primary",
    card.primary.label,
    "primary",
    card.primary.action,
  );
  const footer: CardButton[] = [primary];
  if (!empty && card.secondary) {
    footer.push(
      button(
        "brief:secondary",
        card.secondary.label,
        "quiet",
        card.secondary.action,
      ),
    );
  }

  const rowButton = (row: BriefRow) =>
    button(`row:${row.id}`, row.actionLabel, "quiet", row.action);

  return (
    // tabIndex -1: the header's jump button focuses this element, and a plain
    // div ignores focus().
    <div id={DAILY_BRIEF_ANCHOR} tabIndex={-1} className="scroll-mt-16 outline-none">
      <ActionCard
        icon={Sun}
        title={`${card.heading} · ${briefDayLabel(card.day)}`}
        reason={card.summary}
        width="wide"
        cardId="daily-brief"
        actions={
          <CardActions
            buttons={footer}
            busyId={busy}
            error={failure}
            onAct={onAct}
          />
        }
      >
        {empty ? null : (
          <div className="space-y-1.5">
            <ul className="space-y-1">
              {card.rows.map((row, index) => {
                const previous = card.rows[index - 1];
                const label =
                  previous?.group !== row.group
                    ? GROUP_LABEL[row.group]
                    : undefined;
                return (
                  <Fragment key={row.id}>
                    {label ? (
                      <li aria-hidden="true">
                        <GroupLabel>{label}</GroupLabel>
                      </li>
                    ) : null}
                    <li className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      {row.channel ? (
                        <ChannelBadge channel={row.channel} />
                      ) : null}
                      <span
                        className="min-w-0 flex-1 text-sm"
                        style={{ color: "var(--ws-text)" }}
                      >
                        {row.title}
                      </span>
                      {row.statusLabel ? (
                        <WsStatusPill
                          label={row.statusLabel}
                          className="whitespace-normal"
                        />
                      ) : null}
                      <CardActions
                        buttons={[rowButton(row)]}
                        busyId={busy}
                        onAct={onAct}
                      />
                    </li>
                  </Fragment>
                );
              })}
            </ul>
            {card.more > 0 ? (
              <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
                {copyText("brief.more", { n: card.more })}
              </p>
            ) : null}
            {card.next ? (
              <div className="space-y-1">
                <GroupLabel>{copyText("brief.next")}</GroupLabel>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span
                    className="min-w-0 flex-1 text-sm"
                    style={{ color: "var(--ws-text)" }}
                  >
                    {card.next.title}
                  </span>
                  <CardActions
                    buttons={[
                      button("row:next", nextButtonLabel(card.next), "quiet", {
                        kind: "next",
                        step: card.next.step,
                      }),
                    ]}
                    busyId={busy}
                    onAct={onAct}
                  />
                </div>
              </div>
            ) : null}
            {card.yesterday ? (
              <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
                {yesterdayLine(card.yesterday)}
              </p>
            ) : null}
            {card.focus ? (
              <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
                {copyText("brief.focus", { title: card.focus })}
              </p>
            ) : null}
          </div>
        )}
      </ActionCard>
    </div>
  );
}
