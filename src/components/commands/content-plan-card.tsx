"use client";

import { useMemo, useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Sparkles,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button, buttonVariants } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useChatPackage } from "@/components/commands/chat-package-context";
import { useChatSend } from "@/components/commands/chat-send-context";
import { WsStatusPill, WsTag } from "@/components/commands/ws-event-card";
import {
  ChannelBadge,
  ConnectionDot,
  FormatGlyphIcon,
} from "@/components/commands/channel-badge";
import {
  CHANNELS,
  PLAN_GOAL_LABEL,
  PUBLISH_MODE_LABEL,
  isPlanGoal,
  type ChannelConnections,
  type ChannelKey,
  type PublishMode,
} from "@/lib/content-channels";
import {
  STAGE_LABEL,
  buildWeeks,
  countStages,
  planChannels,
  publishSummary,
  stageSummary,
  toViewItems,
  type PlanViewItem,
} from "@/lib/content-plan-view";
import { selectProductionBatch, type PlanItemStage } from "@/lib/journey";
import { SOCIAL_PLATFORM } from "@/lib/labels";
import {
  disabledReasonOf,
  useWorkCardHost,
} from "@/components/works/work-card-host";
import { copyText } from "@/lib/works/copy";
import { produceCostNote } from "@/lib/works/cost";
import {
  worksPlanSummary,
  worksPublishMode,
  worksPublishTone,
} from "@/lib/works/plan-publish-truth";
import { saveContentPlanAction } from "@/server/actions/content-plan-actions";
import { approvePlanItemsAction } from "@/server/actions/plan-progress-actions";
import type { IdeaEventCardData } from "@/types/idea-event-card";

type PlanCard = Extract<IdeaEventCardData, { kind: "content-plan-draft" }>;

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

// The dot on a saved piece: one colour per stage, the same ones the status
// line under the plan uses.
const STAGE_COLOR: Record<PlanItemStage, string> = {
  PLANNED: "var(--ws-text-3)",
  PRODUCING: "var(--ws-olive)",
  FAILED: "var(--destructive)",
  IN_REVIEW: "var(--ws-accent)",
  REJECTED: "var(--destructive)",
  APPROVED: "var(--ws-approved)",
  PUBLISHED: "var(--ws-approved)",
};

function StageDot({ stage }: { stage: PlanItemStage }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        stage === "PRODUCING" && "animate-pulse",
      )}
      style={{ background: STAGE_COLOR[stage] }}
    />
  );
}

function formatDay(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

function formatShort(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

type ChannelStatus = {
  state: "connected" | "missing" | "manual";
  text: string;
  connect: boolean;
};

// One line per channel above the calendar: where this plan goes and whether
// that destination works right now.
function channelStatus(
  channel: ChannelKey,
  connections: ChannelConnections | undefined,
): ChannelStatus {
  if (CHANNELS[channel].group === "seo") {
    return { state: "manual", text: "You publish", connect: false };
  }
  const connection = connections?.[channel];
  if (!connections) return { state: "manual", text: "", connect: false };
  if (connection?.connected) {
    return {
      state: "connected",
      text: connection.accountLabel ?? "Connected",
      connect: false,
    };
  }
  return {
    state: "missing",
    text: CHANNELS[channel].group === "ads" ? "Connect Meta Ads" : "Connect",
    connect: true,
  };
}

const PUBLISH_TONE: Record<PublishMode, string> = {
  auto: "Publishes itself",
  manual: "You publish it",
  approval: "Waits for your approval",
};

function summaryText(items: readonly PlanViewItem[]): string {
  const counts = publishSummary(items);
  return (Object.keys(counts) as PublishMode[])
    .filter((mode) => counts[mode] > 0)
    .map((mode) => `${counts[mode]} ${PUBLISH_MODE_LABEL[mode].toLowerCase()}`)
    .join(" · ");
}

// Touch size and kit radius of the card buttons inside a Work (the old h-7
// "sm" size was the smallest tap target of the product).
const WORKS_BUTTON = "min-h-11 rounded-lg px-4";

// The save action answers a stale plan with code STALE (Works only).
function isStale(result: object): boolean {
  return "code" in result && result.code === "STALE";
}

// A content plan the chat agent drafted (propose_content_plan): a compact,
// tabbed calendar instead of a long list. Week = a Monday-first mini grid with
// one small chip per piece (channel colour + format icon), List = one line per
// piece; both open the same detail line. Save stores the slots as dated DRAFT
// creatives on the content calendar (no images yet). A newer proposal in the
// same chat marks this one "superseded" so only the latest can be saved.
export function ContentPlanCard({
  card,
  commandId,
  aboveActions,
}: {
  card: PlanCard;
  commandId?: string;
  // Only the Works plan card passes this (its brand check and other ideas);
  // it sits where the person decides, between the tabs and the buttons.
  aboveActions?: ReactNode;
}) {
  // Null outside a Work: every Works change below is gated on it.
  const host = useWorkCardHost();
  const sendChat = useChatSend();
  const buttonClass = host ? WORKS_BUTTON : undefined;
  const router = useRouter();
  const params = useParams<{ projectId?: string }>();
  const projectId =
    typeof params?.projectId === "string" ? params.projectId : undefined;
  const chatPackage = useChatPackage();
  const [pending, startTransition] = useTransition();
  const [tab, setTab] = useState<"week" | "list">("week");
  const [selected, setSelected] = useState(0);
  const [weekIndex, setWeekIndex] = useState(0);
  const [stale, setStale] = useState(false);

  const items = useMemo(
    () => toViewItems(card.items, card.connections, card.slots),
    [card.items, card.connections, card.slots],
  );
  const weeks = useMemo(() => buildWeeks(items), [items]);
  const channels = useMemo(() => planChannels(items), [items]);
  const week = weeks[Math.min(weekIndex, weeks.length - 1)];
  const current = items[selected] ?? items[0];
  const open = card.state === "draft";
  const integrationsHref = projectId
    ? `/projects/${projectId}/integrations`
    : undefined;

  // "Save & produce" saves the plan and then produces its nearest week right
  // here in the chat; "Save only" just writes the calendar.
  const save = (produce: boolean) => {
    if (!commandId) return;
    startTransition(async () => {
      const result = await saveContentPlanAction(commandId);
      if (!result.ok) {
        toast.error(result.message);
        if (host && isStale(result)) setStale(true);
        router.refresh();
        return;
      }
      toast.success(
        `Plan saved (${result.saved ?? card.items.length} posts).`,
      );
      router.refresh();
      // The run streams for a while: start it without holding this
      // transition (the chat shows each piece live).
      if (produce && chatPackage) void chatPackage.startPlan({ commandId });
    });
  };

  const produce = () => {
    if (!commandId || !chatPackage) return;
    void chatPackage.startPlan({ commandId });
  };

  const approveAll = () => {
    if (!commandId) return;
    startTransition(async () => {
      const result = await approvePlanItemsAction(commandId);
      if (result.ok) {
        toast.success(
          result.failed > 0
            ? `${result.approved} approved, ${result.failed} could not be.`
            : `${result.approved} approved.`,
        );
      } else {
        toast.error(result.message);
      }
      router.refresh();
    });
  };

  // What one click can produce: the nearest week of the slots with no content.
  const producible = useMemo(
    () =>
      selectProductionBatch(
        items.flatMap((item) =>
          item.slot
            ? [
                {
                  id: item.slot.id,
                  planId: "plan",
                  stage: item.slot.stage,
                  date: item.date,
                },
              ]
            : [],
        ),
      ).length,
    [items],
  );
  const stageCounts = useMemo(() => countStages(items), [items]);
  const producing = chatPackage?.runs[commandId ?? ""]?.phase === "running";
  const draftBatch = useMemo(
    () =>
      selectProductionBatch(
        items.map((item) => ({
          id: String(item.index),
          planId: "plan",
          stage: "PLANNED" as const,
          date: item.date,
        })),
      ).length,
    [items],
  );

  // The quiet "about $0.24 in pictures" line of a Work: what the next batch
  // of Save & produce / Produce would paint.
  const costNote = useMemo(() => {
    if (!host) return null;
    const note = (pieces: PlanViewItem[]) =>
      produceCostNote(
        pieces.map((item) => ({
          formatKey: item.format?.key,
          channel: item.channel,
        })),
      );
    if (card.state === "draft") {
      const ids = new Set(
        selectProductionBatch(
          items.map((item) => ({
            id: String(item.index),
            planId: "plan",
            stage: "PLANNED" as const,
            date: item.date,
          })),
        ),
      );
      return note(items.filter((item) => ids.has(String(item.index))));
    }
    const ids = new Set(
      selectProductionBatch(
        items.flatMap((item) =>
          item.slot
            ? [
                {
                  id: item.slot.id,
                  planId: "plan",
                  stage: item.slot.stage,
                  date: item.date,
                },
              ]
            : [],
        ),
      ),
    );
    return note(items.filter((item) => item.slot && ids.has(item.slot.id)));
  }, [host, card.state, items]);
  const costLine = costNote
    ? copyText("plan.costNote", { cost: costNote.replace(/^about /, "") })
    : null;

  const planAgain = () => {
    if (!sendChat) return;
    const labels = channels.map((channel) => CHANNELS[channel].label);
    void sendChat(`Plan the week for ${labels.join(", ")}.`);
  };
  const planAgainReason = disabledReasonOf(host, { kind: "send" });

  const goToWeek = (next: number) => {
    const bounded = Math.max(0, Math.min(weeks.length - 1, next));
    setWeekIndex(bounded);
    const target = weeks[bounded];
    const first = items.find((item) => target?.days.includes(item.date));
    if (first) setSelected(first.index);
  };

  return (
    <div
      className="mt-1 w-full max-w-xl space-y-3 rounded-2xl border p-3.5"
      style={{
        borderColor: "var(--ws-border)",
        background: "var(--ws-surface)",
        boxShadow: "var(--ws-card-shadow)",
        opacity: card.state === "superseded" ? 0.6 : 1,
      }}
    >
      <div className="flex items-center gap-2.5">
        <span
          className="flex size-7 shrink-0 items-center justify-center rounded-lg"
          style={{ background: "var(--ws-hover)" }}
        >
          <CalendarClock
            className="size-3.5"
            style={{ color: "var(--ws-text)" }}
          />
        </span>
        <p
          className="min-w-0 flex-1 truncate text-sm font-semibold"
          style={{ color: "var(--ws-text)" }}
        >
          {card.title}
        </p>
        {card.goal && isPlanGoal(card.goal) ? (
          <WsTag>{PLAN_GOAL_LABEL[card.goal].label}</WsTag>
        ) : null}
        {card.state === "saved" ? (
          <WsStatusPill label="Saved" tone="positive" />
        ) : card.state === "superseded" ? (
          <WsStatusPill label="Replaced by a newer version" tone="waiting" />
        ) : (
          <WsTag>{card.items.length} posts</WsTag>
        )}
      </div>

      {channels.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {channels.map((channel) => {
            const status = channelStatus(channel, card.connections);
            const body = (
              <>
                <ChannelBadge channel={channel} />
                <span className="font-medium">{CHANNELS[channel].label}</span>
                {status.text ? (
                  <>
                    <ConnectionDot state={status.state} />
                    <span style={{ color: "var(--ws-text-2)" }}>
                      {status.text}
                    </span>
                  </>
                ) : null}
              </>
            );
            const className =
              "inline-flex items-center gap-1.5 rounded-full border py-0.5 pr-2.5 pl-1 text-[11px]";
            return (
              <li key={channel}>
                {status.connect && integrationsHref ? (
                  <Link
                    href={integrationsHref}
                    className={cn(className, "hover:bg-[var(--ws-hover)]")}
                    style={{
                      borderColor: "var(--ws-border)",
                      color: "var(--ws-text)",
                    }}
                  >
                    {body}
                  </Link>
                ) : (
                  <span
                    className={className}
                    style={{
                      borderColor: "var(--ws-border)",
                      color: "var(--ws-text)",
                    }}
                  >
                    {body}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}

      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as "week" | "list")}
      >
        <TabsList>
          <TabsTrigger value="week">Week</TabsTrigger>
          <TabsTrigger value="list">List</TabsTrigger>
        </TabsList>

        <TabsContent value="week" className="space-y-2.5">
          {week ? (
            <>
              <div className="flex items-center justify-between gap-2">
                <span
                  className="text-xs font-medium"
                  style={{ color: "var(--ws-text-2)" }}
                >
                  {formatShort(week.days[0]!)} – {formatShort(week.days[6]!)}
                </span>
                {weeks.length > 1 ? (
                  <span className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Previous week"
                      disabled={weekIndex === 0}
                      onClick={() => goToWeek(weekIndex - 1)}
                    >
                      <ChevronLeft className="size-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Next week"
                      disabled={weekIndex >= weeks.length - 1}
                      onClick={() => goToWeek(weekIndex + 1)}
                    >
                      <ChevronRight className="size-4" />
                    </Button>
                  </span>
                ) : null}
              </div>
              <div className="grid grid-cols-7 gap-1">
                {week.days.map((day, dayIndex) => {
                  const dayItems = items.filter((item) => item.date === day);
                  return (
                    <div
                      key={day}
                      className="min-h-[60px] rounded-lg border p-1"
                      style={{
                        borderColor: "var(--ws-border)",
                        background:
                          dayItems.length > 0
                            ? "transparent"
                            : "var(--ws-hover)",
                      }}
                    >
                      <p
                        className="mb-1 text-center text-[10px] leading-none"
                        style={{ color: "var(--ws-text-2)" }}
                      >
                        {WEEKDAYS[dayIndex]}{" "}
                        <span className="font-semibold">
                          {Number(day.slice(8))}
                        </span>
                      </p>
                      <div className="flex flex-col gap-1">
                        {dayItems.map((item) => (
                          <button
                            key={item.index}
                            type="button"
                            onClick={() => setSelected(item.index)}
                            aria-label={`${item.topic}, ${formatDay(item.date)} ${item.time}`}
                            aria-pressed={selected === item.index}
                            className="relative flex items-center justify-center gap-0.5 rounded-md border px-0.5 py-0.5 transition-colors"
                            style={{
                              borderColor:
                                selected === item.index
                                  ? "var(--ws-accent)"
                                  : "var(--ws-border)",
                              background:
                                selected === item.index
                                  ? "var(--ws-hover)"
                                  : "transparent",
                            }}
                          >
                            {item.channel ? (
                              <ChannelBadge
                                channel={item.channel}
                                className="h-4 min-w-4 text-[9px]"
                              />
                            ) : (
                              <span className="text-[9px] font-semibold">
                                {item.platform?.slice(0, 2)}
                              </span>
                            )}
                            {item.format ? (
                              <FormatGlyphIcon
                                glyph={item.format.glyph}
                                className="size-3"
                              />
                            ) : null}
                            {item.slot ? (
                              <span className="absolute -top-0.5 -right-0.5">
                                <StageDot stage={item.slot.stage} />
                              </span>
                            ) : null}
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
              {current ? (
                <PlanItemDetail item={current} projectId={projectId} />
              ) : null}
            </>
          ) : null}
        </TabsContent>

        <TabsContent value="list">
          <ul className="space-y-1">
            {items.map((item) => (
              <li key={item.index}>
                <button
                  type="button"
                  onClick={() =>
                    setSelected(selected === item.index ? -1 : item.index)
                  }
                  aria-expanded={selected === item.index}
                  className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-[var(--ws-hover)]"
                >
                  <span
                    className="w-[74px] shrink-0 text-[11px] font-medium"
                    style={{ color: "var(--ws-text-2)" }}
                  >
                    {formatDay(item.date)}
                  </span>
                  {item.channel ? (
                    <ChannelBadge channel={item.channel} />
                  ) : null}
                  {item.format ? (
                    <FormatGlyphIcon glyph={item.format.glyph} />
                  ) : null}
                  <span
                    className="min-w-0 flex-1 truncate text-xs font-medium"
                    style={{ color: "var(--ws-text)" }}
                  >
                    {item.topic}
                  </span>
                  {item.slot ? <StageDot stage={item.slot.stage} /> : null}
                </button>
                {selected === item.index ? (
                  <div className="px-1.5 pb-1.5">
                    <PlanItemDetail
                      item={item}
                      projectId={projectId}
                      compact
                    />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </TabsContent>
      </Tabs>

      {aboveActions}

      {open ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {host ? (
            worksPlanSummary(items) ? (
              <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
                {worksPlanSummary(items)}
              </p>
            ) : null
          ) : (
            <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
              {summaryText(items) || "Ask me to change anything, or save it."}
            </p>
          )}
          <span className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              className={buttonClass}
              onClick={() => save(false)}
              disabled={pending || !commandId}
            >
              Save only
            </Button>
            <Button
              size="sm"
              className={buttonClass}
              onClick={() => save(true)}
              disabled={pending || !commandId || !chatPackage}
            >
              {pending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Sparkles className="size-3.5" />
              )}
              Save &amp; produce{draftBatch > 0 ? ` (${draftBatch})` : ""}
            </Button>
          </span>
        </div>
      ) : null}

      {host && open && costLine ? (
        <p className="text-xs" style={{ color: "var(--ws-text-3)" }}>
          {costLine}
        </p>
      ) : null}

      {host && stale ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
            {copyText("plan.stale")}
          </p>
          {sendChat ? (
            <Button
              size="sm"
              variant="ghost"
              className={buttonClass}
              onClick={planAgain}
              disabled={planAgainReason !== null}
              title={planAgainReason ?? undefined}
            >
              {copyText("plan.again")}
            </Button>
          ) : null}
        </div>
      ) : null}

      {card.state === "saved" ? (
        <div className="space-y-2">
          {card.slots && stageSummary(items) ? (
            <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
              {stageSummary(items)}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            {card.slots && stageCounts.IN_REVIEW > 0 ? (
              <Button
                size="sm"
                variant="outline"
                className={buttonClass}
                onClick={approveAll}
                disabled={pending}
              >
                Approve all ({stageCounts.IN_REVIEW})
              </Button>
            ) : null}
            {card.slots && producible > 0 && chatPackage ? (
              <Button
                size="sm"
                className={buttonClass}
                onClick={produce}
                disabled={pending || producing}
              >
                {producing ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Sparkles className="size-3.5" />
                )}
                {stageCounts.FAILED > 0 ? "Try again" : "Produce"} ({producible})
              </Button>
            ) : null}
            {projectId ? (
              <Link
                href={`/projects/${projectId}/takvim`}
                className={
                  host
                    ? cn(
                        buttonVariants({ variant: "outline", size: "sm" }),
                        WORKS_BUTTON,
                      )
                    : buttonVariants({ variant: "outline", size: "sm" })
                }
              >
                Open calendar
              </Link>
            ) : null}
          </div>
          {host && costLine && card.slots && producible > 0 && chatPackage ? (
            <p className="text-xs" style={{ color: "var(--ws-text-3)" }}>
              {costLine}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// The selected piece: where it goes, what it is about, what happens to it.
function PlanItemDetail({
  item,
  projectId,
  compact = false,
}: {
  item: PlanViewItem;
  projectId?: string;
  compact?: boolean;
}) {
  const host = useWorkCardHost();
  const channelLabel = item.channel
    ? CHANNELS[item.channel].label
    : (SOCIAL_PLATFORM[item.platform as keyof typeof SOCIAL_PLATFORM]?.label ??
      item.platform);
  return (
    <div
      className={cn("rounded-xl border p-2.5", compact && "bg-transparent")}
      style={{ borderColor: "var(--ws-border)" }}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          className="text-xs font-semibold"
          style={{ color: "var(--ws-text)" }}
        >
          {formatDay(item.date)} · {item.time}
        </span>
        <WsTag>
          {channelLabel}
          {item.format ? ` · ${item.format.label}` : ""}
        </WsTag>
        {item.publish ? (
          <span className="text-[11px]" style={{ color: "var(--ws-text-2)" }}>
            {host
              ? worksPublishTone(
                  worksPublishMode({ ...item, publish: item.publish }),
                )
              : PUBLISH_TONE[item.publish]}
          </span>
        ) : null}
      </div>
      <p
        className="mt-1 text-sm font-medium"
        style={{ color: "var(--ws-text)" }}
      >
        {item.topic}
      </p>
      <p
        className="mt-0.5 text-xs leading-relaxed"
        style={{ color: "var(--ws-text-2)" }}
      >
        {item.captionIdea}
      </p>
      {item.slot ? (
        <div className="mt-2 flex items-center gap-2">
          {item.slot.assetId ? (
            // eslint-disable-next-line @next/next/no-img-element -- source is /api/assets/<id>, next/image cannot optimize it
            <img
              src={`/api/assets/${item.slot.assetId}`}
              alt=""
              className="size-12 shrink-0 rounded-md object-cover"
            />
          ) : null}
          <span
            className="flex items-center gap-1.5 text-xs"
            style={{ color: "var(--ws-text-2)" }}
          >
            <StageDot stage={item.slot.stage} />
            {STAGE_LABEL[item.slot.stage]}
          </span>
          {projectId && item.slot.stage !== "PLANNED" ? (
            <Link
              href={`/projects/${projectId}/takvim?creative=${item.slot.id}`}
              className="ml-auto text-xs underline underline-offset-2"
              style={{ color: "var(--ws-text-2)" }}
            >
              Open
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
