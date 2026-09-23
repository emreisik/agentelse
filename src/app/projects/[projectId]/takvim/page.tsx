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
import { CREATIVE_STATUS, SOCIAL_PLATFORM } from "@/lib/labels";
import { AppShell } from "@/components/layout/app-shell";
import { ActionForm } from "@/components/shared/action-form";
import { EntityDialog } from "@/components/shared/entity-dialog";
import { ImageLightbox } from "@/components/shared/image-lightbox";
import { StatusBadge } from "@/components/shared/status-badge";
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
// is never touched here, only WHICH DAY each is planned to publish on
// (Creative.scheduledFor) and, via the embedded CreativeImageStudio, quick
// prompt-driven revision without leaving this page. Same RSC-first,
// searchParam-driven architecture as ads/page.tsx: month navigation via
// `?month=`, a creative's detail via `?creative=` opening an EntityDialog
// — no client-side calendar state.
function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// Pure UTC math on purpose — Creative.scheduledFor is a @db.Date column
// (date-only, no time component), so the grid must bucket by the SAME UTC
// calendar day it was stored as. Routing this through date-fns's
// local-timezone-aware helpers (format/startOfWeek/etc.) would silently
// shift days whenever the server's local TZ isn't UTC — plain Date.UTC
// arithmetic has no such footgun.
function monthGrid(monthParam: string | undefined) {
  const now = new Date();
  const [yearRaw, monthRaw] = (monthParam ?? "").split("-");
  const year = Number(yearRaw) || now.getUTCFullYear();
  const monthIndex = monthRaw ? Number(monthRaw) - 1 : now.getUTCMonth();

  const monthStart = new Date(Date.UTC(year, monthIndex, 1));
  const monthEnd = new Date(Date.UTC(year, monthIndex + 1, 0));

  // ISO weeks (Monday first): back up to the Monday on/before day 1, and
  // forward to the Sunday on/after the last day.
  const startWeekday = (monthStart.getUTCDay() + 6) % 7; // 0 = Monday
  const gridStart = new Date(monthStart);
  gridStart.setUTCDate(gridStart.getUTCDate() - startWeekday);

  const endWeekday = (monthEnd.getUTCDay() + 6) % 7;
  const gridEnd = new Date(monthEnd);
  gridEnd.setUTCDate(gridEnd.getUTCDate() + (6 - endWeekday));

  const days: Date[] = [];
  for (
    let d = new Date(gridStart);
    d <= gridEnd;
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    days.push(new Date(d));
  }

  const monthLabel = new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(monthStart);

  const prevMonth = new Date(Date.UTC(year, monthIndex - 1, 1));
  const nextMonth = new Date(Date.UTC(year, monthIndex + 1, 1));
  const toParam = (d: Date) =>
    `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

  return {
    year,
    monthIndex,
    monthStart,
    monthEnd,
    gridStart,
    gridEnd,
    days,
    monthLabel,
    prevMonthParam: toParam(prevMonth),
    nextMonthParam: toParam(nextMonth),
    thisMonthParam: toParam(now),
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

  const monthParam = typeof sp.month === "string" ? sp.month : undefined;
  const grid = monthGrid(monthParam);
  const base = `/projects/${projectId}/takvim`;
  const monthHref = (m: string) =>
    m === grid.thisMonthParam ? base : `${base}?month=${m}`;

  const creatives = (await CreativeRepository.listForCalendarRange(projectId, {
    from: grid.gridStart,
    to: grid.gridEnd,
  })) as CalendarCreative[];

  const byDay = new Map<string, CalendarCreative[]>();
  const unscheduled: CalendarCreative[] = [];
  for (const creative of creatives) {
    if (!creative.scheduledFor) {
      unscheduled.push(creative);
      continue;
    }
    const key = dayKey(creative.scheduledFor);
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
  const closeHref =
    monthParam && monthParam !== grid.thisMonthParam
      ? `${base}?month=${monthParam}`
      : base;

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

        <UnscheduledTray
          creatives={unscheduled}
          base={base}
          monthParam={monthParam}
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
            const key = dayKey(day);
            const items = byDay.get(key) ?? [];
            const inMonth = day.getUTCMonth() === grid.monthIndex;
            const isToday = key === dayKey(new Date());
            return (
              <DayCell
                key={key}
                day={day}
                items={items}
                inMonth={inMonth}
                isToday={isToday}
                base={base}
                monthParam={monthParam}
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
        />
      ) : null}
    </AppShell>
  );
}

function creativeHref(
  base: string,
  monthParam: string | undefined,
  creativeId: string,
) {
  const params = new URLSearchParams();
  if (monthParam) params.set("month", monthParam);
  params.set("creative", creativeId);
  return `${base}?${params.toString()}`;
}

function DayCell({
  day,
  items,
  inMonth,
  isToday,
  base,
  monthParam,
}: {
  day: Date;
  items: CalendarCreative[];
  inMonth: boolean;
  isToday: boolean;
  base: string;
  monthParam: string | undefined;
}) {
  const dayNumber = day.getUTCDate();
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
            href={creativeHref(base, monthParam, creative.id)}
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
  return (
    <Link
      href={href}
      scroll={false}
      className="flex items-center gap-1 rounded-md px-1 py-0.5 text-left ring-1 ring-foreground/10 transition-colors hover:bg-accent"
    >
      {hasImage && asset ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/assets/${asset.id}`}
          alt=""
          className="size-6 shrink-0 rounded object-cover"
        />
      ) : (
        <span className="flex size-6 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
          <ImageOff className="size-3" />
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-[11px]">
        {creative.platform ? SOCIAL_PLATFORM[creative.platform].label : "—"}
      </span>
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          creative.status === "APPROVED" || creative.status === "PUBLISHED"
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
}: {
  creatives: CalendarCreative[];
  base: string;
  monthParam: string | undefined;
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
                href={creativeHref(base, monthParam, creative.id)}
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
                  {creative.platform
                    ? SOCIAL_PLATFORM[creative.platform].label
                    : "—"}
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
}: {
  creative: CalendarCreative;
  pendingApproval: { id: string } | null;
  closeHref: string;
}) {
  const version = creative.versions[0];
  const asset = version?.asset;
  const hasImage = Boolean(asset && !asset.storageKey.startsWith("mock://"));
  const format = getCreativePlatformFormat(
    creative.platform,
    version?.contentFormat,
  );
  const scheduledValue = creative.scheduledFor
    ? dayKey(creative.scheduledFor)
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
        {creative.platform ? (
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
            Scheduled day
          </span>
          <input
            type="date"
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
