"use client";

import { useOptimistic, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { CardActions } from "@/components/works/card-actions";
import { useCardAction } from "@/components/works/use-card-action";
import {
  disabledReasonOf,
  useWorkCardHost,
  type WorkCardHostValue,
} from "@/components/works/work-card-host";
import { CHANNELS, resolvePlanItem } from "@/lib/content-channels";
import { blocksOf, type BrandFlag } from "@/lib/works/brand-rules";
import type { CardActionResult, CardButton } from "@/lib/works/card-action";
import { brandCheckText, copyText } from "@/lib/works/copy";
import { MAX_ALTERNATIVE_RUNS, swapItem } from "@/lib/works/plan-alternatives";
import { saveContentPlanAction } from "@/server/actions/content-plan-actions";
import { swapPlanItemAction } from "@/server/actions/plan-options-actions";
import type { IdeaEventCardData } from "@/types/idea-event-card";

type PlanCard = Extract<IdeaEventCardData, { kind: "content-plan-draft" }>;
type PlanItem = PlanCard["items"][number];

function formatDay(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

function channelLabelOf(item: PlanItem): string {
  const resolved = resolvePlanItem(item);
  return resolved ? CHANNELS[resolved.channel].label : (item.platform ?? "");
}

// "{day} · {channel}": the name of one post in the disclosure and its list.
function postLabelOf(item: PlanItem): string {
  return copyText("planAlt.post", {
    day: formatDay(item.date),
    channel: channelLabelOf(item),
  });
}

function flagText(flag: BrandFlag): string {
  switch (flag.kind) {
    case "never-term":
      return copyText("brand.flag.never", {
        matched: flag.matched,
        rule: flag.rule ?? flag.matched,
      });
    case "preset":
      return copyText("brand.flag.preset", { rule: flag.rule ?? flag.matched });
    case "figure":
      return copyText("brand.flag.figure", { matched: flag.matched });
    case "absolute":
      return copyText("brand.flag.absolute", { matched: flag.matched });
  }
}

function Chip({ flag }: { flag: BrandFlag }) {
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap"
      style={{ borderColor: "var(--ws-border)", color: "var(--ws-text-2)" }}
    >
      {copyText(
        flag.severity === "block" ? "brand.chip.block" : "brand.chip.warn",
      )}
    </span>
  );
}

function FlagLines({
  entries,
}: {
  entries: { index: number; item: PlanItem; flags: BrandFlag[] }[];
}) {
  return (
    <ul className="space-y-2">
      {entries.map(({ index, item, flags }) => (
        <li key={index} className="space-y-1">
          <p
            className="text-xs font-medium"
            style={{ color: "var(--ws-text)" }}
          >
            {`${formatDay(item.date)} · ${item.topic}`}
          </p>
          {flags.map((flag, i) => (
            <p
              key={i}
              className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"
              style={{ color: "var(--ws-text-2)" }}
            >
              <span>{flagText(flag)}</span>
              <Chip flag={flag} />
            </p>
          ))}
        </li>
      ))}
    </ul>
  );
}

const SAVE_ANYWAY: CardButton = {
  id: "brand:save-anyway",
  label: copyText("brand.saveAnyway"),
  emphasis: "secondary",
  action: { kind: "server", id: "brand:save-anyway" },
};

function BrandCheck({
  card,
  commandId,
  host,
}: {
  card: PlanCard;
  commandId?: string;
  host: WorkCardHostValue;
}) {
  const { run, busyId, error } = useCardAction({
    server: async (): Promise<CardActionResult> => {
      if (!commandId) return { ok: false, message: copyText("kit.failed") };
      const result = await saveContentPlanAction(commandId, {
        allowIssues: true,
      });
      if (!result.ok) {
        return { ok: false, message: result.message, code: result.code };
      }
      // The action revalidates the page: no router.refresh here.
      toast.success(
        copyText("plan.savedToast", { n: result.saved ?? card.items.length }),
      );
      return { ok: true };
    },
  });

  const flagged = card.items.flatMap((item, index) =>
    !item.removed && item.brandFlags && item.brandFlags.length > 0
      ? [{ index, item, flags: item.brandFlags }]
      : [],
  );
  const blocked = flagged.filter((entry) => blocksOf(entry.flags).length > 0);
  const warnOnly = flagged.filter(
    (entry) => blocksOf(entry.flags).length === 0,
  );
  const check = card.brandCheck;
  if (flagged.length === 0 && !check) return null;

  const reason = disabledReasonOf(host, {
    kind: "server",
    planId: commandId,
  });

  return (
    <section data-brand-check className="space-y-2">
      <h4 className="text-sm font-medium" style={{ color: "var(--ws-text)" }}>
        {copyText("brand.heading")}
      </h4>
      {blocked.length > 0 ? (
        <div className="space-y-2" data-brand-blocks>
          <p className="text-xs" style={{ color: "var(--ws-text)" }}>
            {copyText("brand.blockedNote")}
          </p>
          <FlagLines entries={blocked} />
          {card.state === "draft" ? (
            <CardActions
              buttons={[SAVE_ANYWAY]}
              onAct={run}
              busyId={busyId}
              error={error}
              disabledAll={reason !== null || !commandId}
              disabledReason={reason}
            />
          ) : null}
        </div>
      ) : null}
      {warnOnly.length > 0 ? (
        <details className="rounded-lg border px-2.5" data-brand-warn>
          <summary
            className="flex min-h-11 cursor-pointer items-center text-xs font-medium"
            style={{ color: "var(--ws-text-2)" }}
          >
            {warnOnly.length === 1
              ? copyText("brand.summary.one")
              : copyText("brand.summary.many", { n: warnOnly.length })}
          </summary>
          <div className="pb-2.5">
            <FlagLines entries={warnOnly} />
          </div>
        </details>
      ) : null}
      {check ? (
        <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
          {brandCheckText(check)}
        </p>
      ) : null}
    </section>
  );
}

// Which posts may change idea. A draft: all. A saved plan: the slots still
// waiting for content and not claimed by a running production (the server
// re-checks; this only keeps the UI honest).
export function swappableOf(card: PlanCard, items: readonly PlanItem[]): Set<number> {
  const out = new Set<number>();
  const running =
    card.production?.state === "running"
      ? new Set(card.production.creativeIds)
      : null;
  items.forEach((item, index) => {
    if (item.removed) return;
    if (card.state === "draft") {
      out.add(index);
      return;
    }
    const slot = card.slots?.[index];
    if (slot?.stage === "PLANNED" && !running?.has(slot.id)) out.add(index);
  });
  return out;
}

type AlternativesReply =
  { ok: true } | { ok: false; code?: string; message?: string };

export function parseReply(value: unknown): AlternativesReply | null {
  if (!value || typeof value !== "object") return null;
  const data = value as { ok?: unknown; code?: unknown; message?: unknown };
  if (data.ok === true) return { ok: true };
  if (data.ok !== false) return null;
  return {
    ok: false,
    code: typeof data.code === "string" ? data.code : undefined,
    message: typeof data.message === "string" ? data.message : undefined,
  };
}

export function replyFailure(reply: AlternativesReply | null): {
  code: string;
  message: string;
} {
  if (!reply || reply.ok) {
    return { code: "FAILED", message: copyText("planAlt.failed") };
  }
  switch (reply.code) {
    case "MOCK":
      return { code: "MOCK", message: copyText("planAlt.mock") };
    case "BUSY":
      return { code: "BUSY", message: copyText("planAlt.busy") };
    case "LIMIT_RUNS":
      return { code: "LIMIT_RUNS", message: copyText("planAlt.limit") };
    case "NOTHING":
      return { code: "NOTHING", message: copyText("planAlt.nothingLeft") };
    case "BUDGET":
      return {
        code: "BUDGET",
        message: reply.message ?? copyText("planAlt.failed"),
      };
    default:
      return { code: "FAILED", message: copyText("planAlt.failed") };
  }
}

function OtherIdeas({
  card,
  commandId,
  host,
}: {
  card: PlanCard;
  commandId?: string;
  host: WorkCardHostValue;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const swapping = useRef(false);
  const [swapError, setSwapError] = useState<string | null>(null);
  const [lastCode, setLastCode] = useState<string | null>(null);

  // The row changes at the tap; the action's own revalidation reconciles it
  // and a failure simply drops the optimistic value.
  const [items, applySwap] = useOptimistic(
    card.items,
    (current, change: { index: number; altIndex: number }) =>
      current.map((item, index) =>
        index === change.index
          ? (swapItem(item, change.altIndex) ?? item)
          : item,
      ),
  );

  const paid = useCardAction({
    server: async (id): Promise<CardActionResult> => {
      if (id === "alt:check") {
        setLastCode(null);
        return { ok: true, refresh: true };
      }
      if (!commandId) return { ok: false, message: copyText("kit.failed") };
      setLastCode(null);
      try {
        const response = await fetch(
          `/api/projects/${host.projectId}/chat/plan/alternatives`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ commandId }),
          },
        );
        const reply = parseReply(await response.json().catch(() => null));
        if (response.ok && reply?.ok) {
          // A Route Handler does not revalidate: ask for the refresh.
          return {
            ok: true,
            message: copyText("planAlt.live.ready"),
            refresh: true,
          };
        }
        const failure = replyFailure(reply);
        setLastCode(failure.code);
        return { ok: false, code: failure.code, message: failure.message };
      } catch {
        setLastCode("FAILED");
        return {
          ok: false,
          code: "FAILED",
          message: copyText("planAlt.failed"),
        };
      }
    },
  });

  const swappable = swappableOf(card, items);
  const hasAny = items.some(
    (item, index) =>
      !item.removed &&
      (item.alternatives?.length ?? 0) > 0 &&
      swappable.has(index),
  );
  const cameWithPick = items.some((item) =>
    item.alternatives?.some((alternative) => !!alternative.from),
  );
  const runs = card.alternativesMeta?.runs ?? 0;
  const firstOpen = items.findIndex((_, index) => swappable.has(index));
  const reason = disabledReasonOf(host, {
    kind: "server",
    planId: commandId,
  });
  const blocked = reason !== null || !commandId || pending;

  const swap = (index: number, altIndex: number, topic: string) => {
    if (!commandId || blocked || swapping.current) return;
    swapping.current = true;
    setSwapError(null);
    startTransition(async () => {
      applySwap({ index, altIndex });
      try {
        const result = await swapPlanItemAction(
          commandId,
          index,
          altIndex,
          topic,
        );
        if (result.ok) {
          host.announce(copyText("planAlt.swapped"));
          toast.success(copyText("planAlt.swapped"));
        } else if (result.code === "STALE") {
          host.announce(copyText("planAlt.stale"));
          toast.error(copyText("planAlt.stale"));
          router.refresh();
        } else {
          setSwapError(result.message);
        }
      } catch {
        setSwapError(copyText("kit.failed"));
      } finally {
        swapping.current = false;
      }
    });
  };

  const paidLabel = hasAny
    ? copyText("planAlt.refresh")
    : copyText("planAlt.get");
  const paidBusy = paid.busyId === "alt:request";
  const paidButtons: CardButton[] = [];
  // Nothing to change on a saved plan whose slots are all made.
  if (swappable.size > 0 && (!hasAny || runs < MAX_ALTERNATIVE_RUNS)) {
    paidButtons.push({
      id: "alt:request",
      label: paidBusy ? copyText("planAlt.getting") : paidLabel,
      emphasis: "quiet",
      action: { kind: "server", id: "alt:request" },
    });
  }
  if (lastCode === "BUSY") {
    paidButtons.push({
      id: "alt:check",
      label: copyText("master.checkAgain"),
      emphasis: "quiet",
      action: { kind: "server", id: "alt:check" },
    });
  }

  return (
    <section data-other-ideas className="space-y-2">
      <h4 className="text-sm font-medium" style={{ color: "var(--ws-text)" }}>
        {copyText("planAlt.heading")}
      </h4>
      {swappable.size === 0 ? (
        <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
          {copyText("planAlt.nothingLeft")}
        </p>
      ) : (
        <>
          <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
            {hasAny && (cameWithPick || card.fromOption)
              ? copyText("planAlt.readyFromOptions")
              : copyText("planAlt.helper")}
          </p>
          <div className="space-y-2" aria-busy={pending ? "true" : undefined}>
            {items.map((item, index) => {
              if (item.removed) return null;
              const post = postLabelOf(item);
              const alternatives = item.alternatives ?? [];
              return (
                <details
                  key={index}
                  open={index === firstOpen}
                  className="rounded-lg border px-2.5"
                  style={{ borderColor: "var(--ws-border)" }}
                >
                  <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-x-2 gap-y-0.5 py-1 text-xs">
                    <span
                      className="font-medium"
                      style={{ color: "var(--ws-text)" }}
                    >
                      {post}
                    </span>
                    <span
                      className="min-w-0 truncate"
                      style={{ color: "var(--ws-text-2)" }}
                    >
                      {item.topic}
                    </span>
                  </summary>
                  <div className="space-y-2 pb-2.5">
                    <div className="space-y-0.5">
                      <p
                        className="text-[11px] font-medium"
                        style={{ color: "var(--ws-text-2)" }}
                      >
                        {copyText("planAlt.current")}
                      </p>
                      <p
                        className="text-xs"
                        style={{ color: "var(--ws-text)" }}
                      >
                        {item.topic}
                      </p>
                    </div>
                    {!swappable.has(index) ? (
                      <p
                        className="text-xs"
                        style={{ color: "var(--ws-text-2)" }}
                      >
                        {copyText("planAlt.locked")}
                      </p>
                    ) : alternatives.length === 0 ? (
                      <p
                        className="text-xs"
                        style={{ color: "var(--ws-text-2)" }}
                      >
                        {copyText("planAlt.none")}
                      </p>
                    ) : (
                      <ul
                        aria-label={copyText("a11y.otherIdeas", { post })}
                        className="space-y-2"
                      >
                        {alternatives.map((alternative, altIndex) => (
                          <li
                            key={altIndex}
                            className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between"
                          >
                            <span className="min-w-0 space-y-0.5">
                              <span
                                className="block text-xs"
                                style={{ color: "var(--ws-text)" }}
                              >
                                {alternative.topic}
                              </span>
                              {alternative.from ? (
                                <span
                                  className="block text-[11px]"
                                  style={{ color: "var(--ws-text-2)" }}
                                >
                                  {copyText("planAlt.from", {
                                    label: alternative.from,
                                  })}
                                </span>
                              ) : null}
                            </span>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              data-emphasis="secondary"
                              aria-disabled={blocked ? "true" : undefined}
                              className={`min-h-11 w-full rounded-lg px-4 sm:w-auto${blocked ? " cursor-not-allowed opacity-50" : ""}`}
                              onClick={() => swap(index, altIndex, item.topic)}
                            >
                              {copyText("planAlt.use")}
                            </Button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </details>
              );
            })}
          </div>
        </>
      )}
      {swapError ? (
        <p
          role="alert"
          className="text-xs"
          style={{ color: "var(--destructive)" }}
        >
          {swapError}
        </p>
      ) : null}
      {paidButtons.length > 0 || paid.error ? (
        <CardActions
          buttons={paidButtons}
          onAct={paid.run}
          busyId={paid.busyId}
          error={paid.error}
          disabledAll={reason !== null || !commandId}
          disabledReason={reason}
        />
      ) : null}
      {reason && swappable.size > 0 && paidButtons.length === 0 ? (
        <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
          {reason}
        </p>
      ) : null}
      {hasAny && runs >= MAX_ALTERNATIVE_RUNS ? (
        <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
          {copyText("planAlt.limit")}
        </p>
      ) : null}
    </section>
  );
}

// What ContentPlanCard shows in its aboveActions slot inside a Work: the brand
// check and the other ideas, directly above Save so both are seen before the
// person decides. Nothing outside a Work and nothing for a replaced plan.
export function PlanCardExtras({
  card,
  commandId,
}: {
  card: PlanCard;
  commandId?: string;
}) {
  const host = useWorkCardHost();
  if (!host || card.state === "superseded") return null;
  return (
    <div data-plan-extras className="space-y-3">
      <BrandCheck card={card} commandId={commandId} host={host} />
      <OtherIdeas card={card} commandId={commandId} host={host} />
    </div>
  );
}
