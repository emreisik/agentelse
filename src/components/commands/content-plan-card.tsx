"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  Loader2,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button, buttonVariants } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
  buildWeeks,
  planChannels,
  publishSummary,
  toViewItems,
  type PlanViewItem,
} from "@/lib/content-plan-view";
import { SOCIAL_PLATFORM } from "@/lib/labels";
import { saveContentPlanAction } from "@/server/actions/content-plan-actions";
import type { IdeaEventCardData } from "@/types/idea-event-card";

type PlanCard = Extract<IdeaEventCardData, { kind: "content-plan-draft" }>;

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

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

// A content plan the chat agent drafted (propose_content_plan): a compact,
// tabbed calendar instead of a long list. Week = a Monday-first mini grid with
// one small chip per piece (channel colour + format icon), List = one line per
// piece; both open the same detail line. Save stores the slots as dated DRAFT
// creatives on the content calendar (no images yet). A newer proposal in the
// same chat marks this one "superseded" so only the latest can be saved.
export function ContentPlanCard({
  card,
  commandId,
}: {
  card: PlanCard;
  commandId?: string;
}) {
  const router = useRouter();
  const params = useParams<{ projectId?: string }>();
  const projectId =
    typeof params?.projectId === "string" ? params.projectId : undefined;
  const [pending, startTransition] = useTransition();
  const [tab, setTab] = useState<"week" | "list">("week");
  const [selected, setSelected] = useState(0);
  const [weekIndex, setWeekIndex] = useState(0);

  const items = useMemo(
    () => toViewItems(card.items, card.connections),
    [card.items, card.connections],
  );
  const weeks = useMemo(() => buildWeeks(items), [items]);
  const channels = useMemo(() => planChannels(items), [items]);
  const week = weeks[Math.min(weekIndex, weeks.length - 1)];
  const current = items[selected] ?? items[0];
  const open = card.state === "draft";
  const integrationsHref = projectId
    ? `/projects/${projectId}/integrations`
    : undefined;

  const save = () => {
    if (!commandId) return;
    startTransition(async () => {
      const result = await saveContentPlanAction(commandId);
      if (result.ok) {
        toast.success(
          `Plan saved (${result.saved ?? card.items.length} posts).`,
        );
      } else {
        toast.error(result.message);
      }
      router.refresh();
    });
  };

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
                            className="flex items-center justify-center gap-0.5 rounded-md border px-0.5 py-0.5 transition-colors"
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
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
              {current ? <PlanItemDetail item={current} /> : null}
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
                </button>
                {selected === item.index ? (
                  <div className="px-1.5 pb-1.5">
                    <PlanItemDetail item={item} compact />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </TabsContent>
      </Tabs>

      {open ? (
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
            {summaryText(items) || "Ask me to change anything, or save it."}
          </p>
          <Button size="sm" onClick={save} disabled={pending || !commandId}>
            {pending ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Save to calendar
          </Button>
        </div>
      ) : null}

      {card.state === "saved" && projectId ? (
        <Link
          href={`/projects/${projectId}/takvim`}
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          Open calendar
        </Link>
      ) : null}
    </div>
  );
}

// The selected piece: where it goes, what it is about, what happens to it.
function PlanItemDetail({
  item,
  compact = false,
}: {
  item: PlanViewItem;
  compact?: boolean;
}) {
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
            {PUBLISH_TONE[item.publish]}
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
    </div>
  );
}
