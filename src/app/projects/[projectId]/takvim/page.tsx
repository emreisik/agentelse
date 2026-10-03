import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, ChevronRight, ImageOff } from "lucide-react";

import { prisma } from "@/lib/prisma";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import { isAgentelseError } from "@/server/security/errors";
import { isFalImageConfigured } from "@/server/reasoning/fal-image-client";
import { CreativeRepository } from "@/server/repositories/creative.repository";
import { assignCreativeDateAction } from "@/server/actions/creative-calendar-actions";
import {
  approveApprovalAction,
  rejectApprovalAction,
} from "@/server/actions/approval-actions";
import { getCreativePlatformFormat } from "@/lib/creative-platform-format";
import {
  CHANNELS,
  CHANNEL_KEYS,
  isChannelKey,
  resolveFormat,
  type ChannelKey,
} from "@/lib/content-channels";
import { CREATIVE_STATUS, SOCIAL_PLATFORM } from "@/lib/labels";
import type { NextStep } from "@/lib/journey";
import { NextStepBanner } from "@/components/commands/next-step-banner";
import { computeNextSteps } from "@/server/agency/journey/next-steps";
import { loadJourneySnapshot } from "@/server/agency/journey/snapshot";
import { workIdOfStep } from "@/server/agency/journey/step-work";
import { isWorksEnabled } from "@/server/works/flag";
import {
  dayKeyInTimezone,
  utcToZonedDateTimeLocal,
  zonedDateTimeToUtc,
} from "@/lib/timezone";
import { AppShell } from "@/components/layout/app-shell";
import { ActionForm } from "@/components/shared/action-form";
import { EntityDialog } from "@/components/shared/entity-dialog";
import { ImageLightbox } from "@/components/shared/image-lightbox";
import { StatusBadge } from "@/components/shared/status-badge";
import {
  ChannelBadge,
  FormatGlyphIcon,
} from "@/components/commands/channel-badge";
import { SubmitButton } from "@/components/shared/submit-button";
import { CreativeImageStudio } from "@/components/creative/creative-image-studio";
import { Card, CardContent } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Prisma } from "@prisma/client";

type CalendarCreative = Prisma.CreativeGetPayload<{
  include: {
    versions: {
      include: { asset: true };
    };
  };
}>;

// Content calendar (spec: takvim) — day-by-day view over creatives the
// agency's normal task flow already produced, so their creation date/task
// is never touched here, only WHICH DAY+TIME each is planned to publish
// at (Creative.scheduledFor) and, via the embedded CreativeImageStudio,
// quick prompt-driven revision without leaving this page. Same RSC-first,
// searchParam-driven architecture as ads/page.tsx: month navigation via
// `?month=`, a creative's detail via `?creative=` opening an EntityDialog
// — no client-side calendar state.
//
// Two different kinds of "date" are in play here, deliberately kept
// separate: the GRID is pure Gregorian calendar arithmetic (year/month/day
// integers — "what's the Monday before Oct 1" has no timezone, it's the
// same answer everywhere on Earth), while each Creative.scheduledFor is a
// real UTC instant that only becomes a calendar day once you ask "as seen
// in which timezone" (src/lib/timezone.ts's dayKeyInTimezone). Mixing
// these up — e.g. computing the grid via Date.UTC and then calling
// `.getUTCDate()` on it as if that were the project-local day number — is
// exactly the bug this split avoids: a positive-offset project timezone
// makes local midnight fall on the PREVIOUS UTC calendar day.
type GridDay = { year: number; month: number; day: number; key: string };

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
function ymdKey(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}
// `month` is 1-indexed throughout this file's calendar math (unlike
// JS Date's 0-indexed months) — Date.UTC below is used only as a
// Gregorian calendar calculator (via explicit UTC getters/setters so the
// runtime's own local TZ never leaks in), never as a real instant.
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
function weekdayMonFirst(year: number, month: number, day: number): number {
  return (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
}
function addDays(
  year: number,
  month: number,
  day: number,
  delta: number,
): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + delta);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}
function shiftMonthParam(year: number, month: number, delta: number): string {
  const total = year * 12 + (month - 1) + delta;
  const y = Math.floor(total / 12);
  const m = ((total % 12) + 12) % 12;
  return `${y}-${pad2(m + 1)}`;
}

function monthGrid(monthParam: string | undefined, timeZone: string) {
  const todayKey = dayKeyInTimezone(new Date(), timeZone);
  const [todayYear, todayMonth] = todayKey.split("-").map(Number) as [
    number,
    number,
  ];
  const [yearRaw, monthRaw] = (monthParam ?? "").split("-");
  const year = Number(yearRaw) || todayYear;
  const month = monthRaw ? Number(monthRaw) : todayMonth;

  const lastDay = daysInMonth(year, month);
  const gridStartYmd = addDays(
    year,
    month,
    1,
    -weekdayMonFirst(year, month, 1),
  );
  const gridEndYmd = addDays(
    year,
    month,
    lastDay,
    6 - weekdayMonFirst(year, month, lastDay),
  );

  const days: GridDay[] = [];
  let cursor = gridStartYmd;
  for (;;) {
    days.push({
      ...cursor,
      key: ymdKey(cursor.year, cursor.month, cursor.day),
    });
    if (
      cursor.year === gridEndYmd.year &&
      cursor.month === gridEndYmd.month &&
      cursor.day === gridEndYmd.day
    ) {
      break;
    }
    cursor = addDays(cursor.year, cursor.month, cursor.day, 1);
  }

  const monthLabel = new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, 1)));

  // The Prisma query range DOES need real instants (scheduledFor is a
  // timestamp column) — this is the one place the grid's calendar-only
  // boundaries get converted, via the project's actual timezone.
  const rangeFrom = zonedDateTimeToUtc(
    `${ymdKey(gridStartYmd.year, gridStartYmd.month, gridStartYmd.day)}T00:00`,
    timeZone,
  );
  const rangeTo = zonedDateTimeToUtc(
    `${ymdKey(gridEndYmd.year, gridEndYmd.month, gridEndYmd.day)}T23:59`,
    timeZone,
  );

  return {
    year,
    month,
    days,
    monthLabel,
    rangeFrom,
    rangeTo,
    todayKey,
    prevMonthParam: shiftMonthParam(year, month, -1),
    nextMonthParam: shiftMonthParam(year, month, 1),
    thisMonthParam: shiftMonthParam(todayYear, todayMonth, 0),
  };
}

export default async function ContentCalendarPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  const sp = await searchParams;
  const { userId } = await requireUser();

  try {
    await requireProjectAccess(userId, projectId);
  } catch (error) {
    if (
      isAgentelseError(error) &&
      (error.code === "NOT_FOUND" || error.code === "PERMISSION_DENIED")
    ) {
      notFound();
    }
    throw error;
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { name: true },
  });
  if (!project) notFound();

  // Same "Publishing tab" lookup as settings-panel.tsx/approval-decisions.ts
  // — the calendar's day boundaries and the datetime-local input both need
  // to agree with whatever timezone the project's Instagram publish
  // schedule is configured in.
  const schedule = await prisma.projectSchedule.findFirst({
    where: { projectId, capability: "INSTAGRAM_PUBLISH" },
    select: { timezone: true },
  });
  const timezone = schedule?.timezone ?? "Europe/Istanbul";

  const monthParam = typeof sp.month === "string" ? sp.month : undefined;
  const channelParam: ChannelKey | undefined =
    typeof sp.channel === "string" && isChannelKey(sp.channel)
      ? sp.channel
      : undefined;
  const grid = monthGrid(monthParam, timezone);
  const base = `/projects/${projectId}/takvim`;
  const monthHref = (m: string) =>
    calendarHref(base, {
      month: m === grid.thisMonthParam ? undefined : m,
      channel: channelParam,
    });

  const [allCreatives, snapshot] = await Promise.all([
    CreativeRepository.listForCalendarRange(projectId, {
      from: grid.rangeFrom,
      to: grid.rangeTo,
    }) as Promise<CalendarCreative[]>,
    // What to do next on the content plan (the same answer the chat bar gives).
    loadJourneySnapshot(projectId),
  ]);
  const nextSteps = snapshot ? computeNextSteps(snapshot) : [];
  // With Works on, the banner opens the chat that holds the plan: the bare
  // project URL would start a new chat, where the step runs nothing.
  const bannerWorkId =
    snapshot && nextSteps[0] && isWorksEnabled()
      ? await workIdOfStep(projectId, snapshot, nextSteps[0])
      : undefined;

  // Channel filter chips: only the channels that have something in view, in
  // catalog order. Creatives made outside a plan carry no channel and show
  // under "All" only.
  const channelCounts = new Map<ChannelKey, number>();
  for (const creative of allCreatives) {
    if (isChannelKey(creative.channel)) {
      channelCounts.set(
        creative.channel,
        (channelCounts.get(creative.channel) ?? 0) + 1,
      );
    }
  }
  const creatives = channelParam
    ? allCreatives.filter((creative) => creative.channel === channelParam)
    : allCreatives;

  const byDay = new Map<string, CalendarCreative[]>();
  const unscheduled: CalendarCreative[] = [];
  for (const creative of creatives) {
    if (!creative.scheduledFor) {
      unscheduled.push(creative);
      continue;
    }
    const key = dayKeyInTimezone(creative.scheduledFor, timezone);
    const bucket = byDay.get(key);
    if (bucket) bucket.push(creative);
    else byDay.set(key, [creative]);
  }

  const openId = typeof sp.creative === "string" ? sp.creative : undefined;
  let openCreative: CalendarCreative | null = null;
  let pendingApproval: { id: string } | null = null;
  if (openId) {
    openCreative =
      creatives.find((c) => c.id === openId) ??
      ((await prisma.creative.findFirst({
        where: { id: openId, projectId },
        include: {
          versions: { orderBy: { version: "desc" }, include: { asset: true } },
        },
      })) as CalendarCreative | null);
    if (openCreative) {
      pendingApproval = await prisma.approval.findFirst({
        where: {
          entityType: "Creative",
          entityId: openCreative.id,
          status: "PENDING",
        },
        select: { id: true },
      });
    }
  }
  const closeHref = calendarHref(base, {
    month:
      monthParam && monthParam !== grid.thisMonthParam ? monthParam : undefined,
    channel: channelParam,
  });

  return (
    <AppShell projectId={projectId}>
      <div className="space-y-6 p-6 pb-16">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="font-heading text-2xl font-semibold tracking-tight">
              Content Calendar
            </h1>
            <p className="text-sm text-muted-foreground">
              {project.name} — plan which day each creative goes out, revise it
              in place
            </p>
          </div>
          <div className="flex items-center gap-1">
            <Link
              href={monthHref(grid.prevMonthParam)}
              className={cn(
                buttonVariants({ variant: "outline", size: "icon-sm" }),
              )}
              aria-label="Previous month"
            >
              <ChevronLeft className="size-4" />
            </Link>
            <span className="w-36 text-center text-sm font-medium">
              {grid.monthLabel}
            </span>
            <Link
              href={monthHref(grid.nextMonthParam)}
              className={cn(
                buttonVariants({ variant: "outline", size: "icon-sm" }),
              )}
              aria-label="Next month"
            >
              <ChevronRight className="size-4" />
            </Link>
          </div>
        </div>

        {nextSteps[0] ? (
          <NextStepBanner
            projectId={projectId}
            step={nextSteps[0]}
            workId={bannerWorkId}
          />
        ) : null}

        {channelCounts.size > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <ChannelFilterChip
              href={calendarHref(base, {
                month:
                  monthParam && monthParam !== grid.thisMonthParam
                    ? monthParam
                    : undefined,
              })}
              active={!channelParam}
              label="All"
            />
            {CHANNEL_KEYS.filter((key) => channelCounts.has(key)).map(
              (key) => (
                <ChannelFilterChip
                  key={key}
                  href={calendarHref(base, {
                    month:
                      monthParam && monthParam !== grid.thisMonthParam
                        ? monthParam
                        : undefined,
                    channel: key,
                  })}
                  active={channelParam === key}
                  label={`${CHANNELS[key].label} · ${channelCounts.get(key)}`}
                  channel={key}
                />
              ),
            )}
          </div>
        ) : null}

        <UnscheduledTray
          creatives={unscheduled}
          base={base}
          monthParam={monthParam}
          channelParam={channelParam}
        />

        <div className="grid grid-cols-7 gap-px overflow-hidden rounded-xl border border-border bg-border">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((label) => (
            <div
              key={label}
              className="bg-muted/50 px-2 py-1.5 text-center text-[11px] font-medium text-muted-foreground uppercase"
            >
              {label}
            </div>
          ))}
          {grid.days.map((day) => {
            const items = byDay.get(day.key) ?? [];
            const inMonth = day.month === grid.month;
            const isToday = day.key === grid.todayKey;
            return (
              <DayCell
                key={day.key}
                day={day}
                items={items}
                inMonth={inMonth}
                isToday={isToday}
                base={base}
                monthParam={monthParam}
                channelParam={channelParam}
              />
            );
          })}
        </div>
      </div>

      {openCreative ? (
        <CreativeDetailDialog
          creative={openCreative}
          pendingApproval={pendingApproval}
          closeHref={closeHref}
          timezone={timezone}
        />
      ) : null}
    </AppShell>
  );
}

// The calendar's own searchParams (month, channel filter, open creative) in
// one place, so navigating never drops the others.
function calendarHref(
  base: string,
  params: { month?: string; channel?: ChannelKey; creative?: string },
) {
  const search = new URLSearchParams();
  if (params.month) search.set("month", params.month);
  if (params.channel) search.set("channel", params.channel);
  if (params.creative) search.set("creative", params.creative);
  const query = search.toString();
  return query ? `${base}?${query}` : base;
}

function creativeHref(
  base: string,
  monthParam: string | undefined,
  creativeId: string,
  channelParam: ChannelKey | undefined,
) {
  return calendarHref(base, {
    month: monthParam,
    channel: channelParam,
    creative: creativeId,
  });
}

function ChannelFilterChip({
  href,
  active,
  label,
  channel,
}: {
  href: string;
  active: boolean;
  label: string;
  channel?: ChannelKey;
}) {
  return (
    <Link
      href={href}
      scroll={false}
      aria-current={active ? "true" : undefined}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
        active
          ? "border-foreground bg-foreground text-background"
          : "border-border text-muted-foreground hover:bg-accent",
      )}
    >
      {channel ? <ChannelBadge channel={channel} className="h-4 min-w-4 text-[9px]" /> : null}
      {label}
    </Link>
  );
}

// "Instagram · Carousel" for a planned piece, the plain platform name for
// anything made outside a plan.
function creativeLabel(creative: CalendarCreative): string {
  if (isChannelKey(creative.channel)) {
    const format = creative.formatKey
      ? resolveFormat(creative.channel, creative.formatKey)
      : undefined;
    return format
      ? `${CHANNELS[creative.channel].label} · ${format.label}`
      : CHANNELS[creative.channel].label;
  }
  return creative.platform ? SOCIAL_PLATFORM[creative.platform].label : "—";
}

function DayCell({
  day,
  items,
  inMonth,
  isToday,
  base,
  monthParam,
  channelParam,
}: {
  day: GridDay;
  items: CalendarCreative[];
  inMonth: boolean;
  isToday: boolean;
  base: string;
  monthParam: string | undefined;
  channelParam: ChannelKey | undefined;
}) {
  const dayNumber = day.day;
  const shown = items.slice(0, 3);
  const overflow = items.length - shown.length;
  return (
    <div
      className={cn(
        "min-h-28 space-y-1 bg-background p-1.5",
        !inMonth && "bg-muted/20",
      )}
    >
      <span
        className={cn(
          "inline-flex size-5 items-center justify-center rounded-full text-[11px]",
          isToday
            ? "bg-primary font-semibold text-primary-foreground"
            : inMonth
              ? "text-foreground"
              : "text-muted-foreground/50",
        )}
      >
        {dayNumber}
      </span>
      <div className="space-y-1">
        {shown.map((creative) => (
          <CreativeThumb
            key={creative.id}
            creative={creative}
            href={creativeHref(base, monthParam, creative.id, channelParam)}
          />
        ))}
        {overflow > 0 ? (
          <p className="px-0.5 text-[10px] text-muted-foreground">
            +{overflow} more
          </p>
        ) : null}
      </div>
    </div>
  );
}

function CreativeThumb({
  creative,
  href,
}: {
  creative: CalendarCreative;
  href: string;
}) {
  const version = creative.versions[0];
  const asset = version?.asset;
  const hasImage = Boolean(asset && !asset.storageKey.startsWith("mock://"));
  // A plan slot nothing has been made for yet.
  const needsContent = creative.status === "DRAFT" && !creative.currentVersionId;
  return (
    <Link
      href={href}
      scroll={false}
      title={
        needsContent
          ? `${creative.title ?? "Planned piece"} · needs content`
          : (creative.title ?? undefined)
      }
      className="flex items-center gap-1 rounded-md px-1 py-0.5 text-left ring-1 ring-foreground/10 transition-colors hover:bg-accent"
    >
      {hasImage && asset ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/assets/${asset.id}`}
          alt=""
          className="size-6 shrink-0 rounded object-cover"
        />
      ) : isChannelKey(creative.channel) ? (
        <ChannelBadge channel={creative.channel} className="size-6" />
      ) : (
        <span className="flex size-6 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
          <ImageOff className="size-3" />
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-[11px]">
        {creativeLabel(creative)}
      </span>
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          needsContent
            ? "bg-muted-foreground/40"
            : creative.status === "APPROVED" || creative.status === "PUBLISHED"
              ? "bg-success"
              : creative.status === "REJECTED"
                ? "bg-destructive"
                : "bg-warning",
        )}
      />
    </Link>
  );
}

function UnscheduledTray({
  creatives,
  base,
  monthParam,
  channelParam,
}: {
  creatives: CalendarCreative[];
  base: string;
  monthParam: string | undefined;
  channelParam: ChannelKey | undefined;
}) {
  if (creatives.length === 0) return null;
  return (
    <Card size="sm">
      <CardContent className="flex items-center gap-3 overflow-x-auto p-3">
        <p className="shrink-0 text-xs font-medium text-muted-foreground">
          Unscheduled ({creatives.length})
        </p>
        <div className="flex gap-2">
          {creatives.map((creative) => {
            const version = creative.versions[0];
            const asset = version?.asset;
            const hasImage = Boolean(
              asset && !asset.storageKey.startsWith("mock://"),
            );
            return (
              <Link
                key={creative.id}
                href={creativeHref(base, monthParam, creative.id, channelParam)}
                scroll={false}
                className="flex shrink-0 flex-col items-center gap-1"
                title={creative.title ?? undefined}
              >
                {hasImage && asset ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/assets/${asset.id}`}
                    alt=""
                    className="size-12 rounded-md object-cover ring-1 ring-foreground/10"
                  />
                ) : (
                  <span className="flex size-12 items-center justify-center rounded-md bg-muted text-muted-foreground ring-1 ring-foreground/10">
                    <ImageOff className="size-4" />
                  </span>
                )}
                <span className="max-w-14 truncate text-[10px] text-muted-foreground">
                  {creativeLabel(creative)}
                </span>
              </Link>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function CreativeDetailDialog({
  creative,
  pendingApproval,
  closeHref,
  timezone,
}: {
  creative: CalendarCreative;
  pendingApproval: { id: string } | null;
  closeHref: string;
  timezone: string;
}) {
  const version = creative.versions[0];
  const asset = version?.asset;
  const hasImage = Boolean(asset && !asset.storageKey.startsWith("mock://"));
  const format = getCreativePlatformFormat(
    creative.platform,
    version?.contentFormat,
  );
  const scheduledValue = creative.scheduledFor
    ? utcToZonedDateTimeLocal(creative.scheduledFor, timezone)
    : "";

  return (
    <EntityDialog
      closeHref={closeHref}
      title={creative.title ?? "Creative"}
      size="full"
      bodyClassName="space-y-4 overflow-y-auto p-4 md:p-6"
    >
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge
          meta={CREATIVE_STATUS[creative.status]}
          fallback={creative.status}
        />
        {isChannelKey(creative.channel) ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium">
            <ChannelBadge channel={creative.channel} />
            {creativeLabel(creative)}
            {creative.formatKey &&
            resolveFormat(creative.channel, creative.formatKey) ? (
              <FormatGlyphIcon
                glyph={resolveFormat(creative.channel, creative.formatKey)!.glyph}
              />
            ) : null}
          </span>
        ) : creative.platform ? (
          <StatusBadge
            meta={SOCIAL_PLATFORM[creative.platform]}
            fallback={creative.platform}
          />
        ) : null}
        <span className="text-xs text-muted-foreground">
          {format.label} · {format.contentFormatLabel}
        </span>
      </div>

      {pendingApproval ? (
        <Card size="sm">
          <CardContent className="flex items-center justify-between p-3">
            <p className="text-xs text-muted-foreground">Awaiting approval.</p>
            <div className="flex gap-2">
              <ActionForm
                action={rejectApprovalAction}
                successMessage="Rejected"
              >
                <input
                  type="hidden"
                  name="approvalId"
                  value={pendingApproval.id}
                />
                <SubmitButton variant="outline" size="sm">
                  Reject
                </SubmitButton>
              </ActionForm>
              <ActionForm
                action={approveApprovalAction}
                successMessage="Approved"
              >
                <input
                  type="hidden"
                  name="approvalId"
                  value={pendingApproval.id}
                />
                <SubmitButton size="sm">Approve</SubmitButton>
              </ActionForm>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {hasImage && asset ? (
        <ImageLightbox
          src={`/api/assets/${asset.id}`}
          alt={asset.filename}
          title={creative.title ?? undefined}
          className="block"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/assets/${asset.id}`}
            alt=""
            className="max-h-80 w-full rounded-md border border-border object-contain"
          />
        </ImageLightbox>
      ) : (
        <div className="flex h-40 items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground">
          No image yet
        </div>
      )}

      <ActionForm
        action={assignCreativeDateAction}
        successMessage="Schedule updated"
        className="flex items-end gap-2"
      >
        <input type="hidden" name="creativeId" value={creative.id} />
        <label className="block flex-1 space-y-1">
          <span className="text-xs font-medium text-muted-foreground">
            Scheduled day & time ({timezone})
          </span>
          <input
            type="datetime-local"
            name="date"
            defaultValue={scheduledValue}
            className="h-8 w-full rounded-md border border-input bg-transparent px-2.5 text-xs"
          />
        </label>
        <SubmitButton size="sm" variant="outline">
          Save day
        </SubmitButton>
      </ActionForm>

      <CreativeImageStudio
        creativeId={creative.id}
        hasImage={hasImage}
        platform={creative.platform}
        isFalConfigured={isFalImageConfigured()}
      />
    </EntityDialog>
  );
}
