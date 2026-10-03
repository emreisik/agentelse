import Link from "next/link";
import { ChevronLeft, ChevronRight, ImageOff, X } from "lucide-react";
import type { CreativeStatus, SocialPlatform } from "@prisma/client";

import { submitProjectCommandAction } from "@/server/actions/command-actions";
import { assignCreativeDateAction } from "@/server/actions/creative-calendar-actions";
import { ActionForm } from "@/components/shared/action-form";
import { SubmitButton } from "@/components/shared/submit-button";
import { CREATIVE_STATUS, SOCIAL_PLATFORM } from "@/lib/labels";
import { utcToZonedDateTimeLocal } from "@/lib/timezone";
import type {
  WorkspaceCalendarItem,
  WorkspaceOutputItem,
} from "./workspace-right-panel-data";

// Monday-first, matching buildMonthGrid below.
const WEEKDAY_LABELS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

// Grid cells for `month` ("YYYY-MM"), Monday-first — `items`' local dates
// (already resolved to the project's scheduling timezone by the caller)
// mark which day numbers get a dot indicator.
function buildMonthGrid(
  month: string,
  localDatesWithItems: Set<string>,
  todayLocalDate: string,
) {
  const [yearStr, monStr] = month.split("-");
  const year = Number(yearStr);
  const mon = Number(monStr);
  const firstOfMonth = new Date(Date.UTC(year, mon - 1, 1));
  // getUTCDay(): 0=Sun..6=Sat -> Monday-first offset (0=Mon..6=Sun).
  const leadingBlanks = (firstOfMonth.getUTCDay() + 6) % 7;
  const daysInMonth = new Date(Date.UTC(year, mon, 0)).getUTCDate();

  const cells: {
    day: number | null;
    localDate: string;
    isToday: boolean;
    hasItems: boolean;
  }[] = [];
  for (let i = 0; i < leadingBlanks; i++) {
    cells.push({ day: null, localDate: "", isToday: false, hasItems: false });
  }
  for (let day = 1; day <= daysInMonth; day++) {
    const localDate = `${month}-${String(day).padStart(2, "0")}`;
    cells.push({
      day,
      localDate,
      isToday: localDate === todayLocalDate,
      hasItems: localDatesWithItems.has(localDate),
    });
  }
  return cells;
}

function shiftMonth(month: string, delta: number): string {
  const [yearStr, monStr] = month.split("-");
  const total = Number(yearStr) * 12 + (Number(monStr) - 1) + delta;
  const y = Math.floor(total / 12);
  const m = ((total % 12) + 12) % 12;
  return `${y}-${String(m + 1).padStart(2, "0")}`;
}

function Thumb({
  assetId,
  size = "size-9",
}: {
  assetId: string | null;
  size?: string;
}) {
  if (assetId) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- source is /api/assets/<id>, next/image cannot optimize it
      <img
        src={`/api/assets/${assetId}`}
        alt=""
        className={`${size} shrink-0 rounded-lg object-cover`}
      />
    );
  }
  return (
    <span
      className={`flex ${size} shrink-0 items-center justify-center rounded-lg`}
      style={{ background: "var(--ws-hover)", color: "var(--ws-text-3)" }}
    >
      <ImageOff className="size-3.5" />
    </span>
  );
}

// Brand Workspace right panel's Calendar tab — real month navigation and
// inline day/time scheduling, entirely within this 400px panel (no link
// out to /takvim). `?calMonth=YYYY-MM` pages the month; `?calItem=id`
// opens the inline quick-edit block for one creative (see page.tsx, which
// resolves it tenant-scoped before passing it in as `selectedItem`).
// Day cells stay a compact visual overview (day number + dot) rather than
// individually clickable — at this width, every item is already reachable
// (with its real day/time) from the list below, so a second click target
// per cell would just duplicate that without adding real information.
export function CalendarPanel({
  projectId,
  workId,
  calendar,
  selectedItem,
}: {
  projectId: string;
  // The Work on screen (Works only). The calendar's own links keep it: the bare
  // project URL starts a new chat, so dropping it would leave the conversation.
  workId?: string;
  calendar: {
    items: WorkspaceCalendarItem[];
    unscheduled: WorkspaceOutputItem[];
    timezone: string;
    month: string;
  };
  selectedItem?: {
    id: string;
    title: string | null;
    platform: SocialPlatform | null;
    status: CreativeStatus;
    assetId: string | null;
    scheduledFor: string | null;
  };
}) {
  const todayLocalDate = utcToZonedDateTimeLocal(
    new Date(),
    calendar.timezone,
  ).slice(0, 10);

  const itemsWithLocalDate = calendar.items
    .map((item) => ({
      item,
      localDateTime: utcToZonedDateTimeLocal(
        new Date(item.scheduledFor),
        calendar.timezone,
      ),
    }))
    .sort((a, b) => a.localDateTime.localeCompare(b.localDateTime));
  const localDatesWithItems = new Set(
    itemsWithLocalDate.map((i) => i.localDateTime.slice(0, 10)),
  );
  const grid = buildMonthGrid(
    calendar.month,
    localDatesWithItems,
    todayLocalDate,
  );

  const monthLabel = new Date(
    `${calendar.month}-01T00:00:00Z`,
  ).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  const workQuery = workId ? `work=${encodeURIComponent(workId)}&` : "";
  const monthHref = (month: string) =>
    `/projects/${projectId}?${workQuery}calMonth=${month}`;
  const itemHref = (creativeId: string) =>
    `/projects/${projectId}?${workQuery}calMonth=${calendar.month}&calItem=${creativeId}`;
  const closeItemHref = `/projects/${projectId}?${workQuery}calMonth=${calendar.month}`;

  return (
    <div className="flex flex-col gap-4 px-4 py-4 text-sm">
      <div>
        <div
          className="text-[10px] font-semibold tracking-[0.1em]"
          style={{ color: "var(--ws-text-3)" }}
        >
          YOUR BRAND&apos;S RHYTHM
        </div>
        <div
          className="mt-0.5 text-base font-semibold"
          style={{ color: "var(--ws-text)" }}
        >
          Everything, on time.
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <Link
            href={monthHref(shiftMonth(calendar.month, -1))}
            scroll={false}
            aria-label="Previous month"
            className="flex size-6 items-center justify-center rounded-full transition-colors hover:bg-[var(--ws-hover)]"
            style={{ color: "var(--ws-text-2)" }}
          >
            <ChevronLeft className="size-3.5" />
          </Link>
          <span
            className="text-xs font-medium"
            style={{ color: "var(--ws-text-2)" }}
          >
            {monthLabel}
          </span>
          <Link
            href={monthHref(shiftMonth(calendar.month, 1))}
            scroll={false}
            aria-label="Next month"
            className="flex size-6 items-center justify-center rounded-full transition-colors hover:bg-[var(--ws-hover)]"
            style={{ color: "var(--ws-text-2)" }}
          >
            <ChevronRight className="size-3.5" />
          </Link>
        </div>
        <div className="grid grid-cols-7 gap-y-1 text-center">
          {WEEKDAY_LABELS.map((label) => (
            <span
              key={label}
              className="text-[9px] font-medium"
              style={{ color: "var(--ws-text-3)" }}
            >
              {label[0]}
            </span>
          ))}
          {grid.map((cell, index) =>
            cell.day === null ? (
              <span key={`blank-${index}`} />
            ) : (
              <div
                key={cell.localDate}
                className="flex flex-col items-center justify-center gap-0.5 py-1"
              >
                <span
                  className="flex size-6 items-center justify-center rounded-full text-[11px]"
                  style={
                    cell.isToday
                      ? {
                          background: "var(--ws-accent)",
                          color: "var(--ws-on-accent)",
                          fontWeight: 600,
                        }
                      : { color: "var(--ws-text-2)" }
                  }
                >
                  {cell.day}
                </span>
                <span
                  className="size-1 rounded-full"
                  style={{
                    background: cell.hasItems
                      ? "var(--ws-accent)"
                      : "transparent",
                  }}
                />
              </div>
            ),
          )}
        </div>
      </div>

      {selectedItem ? (
        <ScheduleQuickEdit
          item={selectedItem}
          timezone={calendar.timezone}
          closeHref={closeItemHref}
        />
      ) : null}

      {calendar.unscheduled.length > 0 ? (
        <div>
          <div
            className="mb-2 text-[10px] font-semibold tracking-[0.1em]"
            style={{ color: "var(--ws-text-3)" }}
          >
            Unscheduled ({calendar.unscheduled.length})
          </div>
          <div className="scrollbar-none flex gap-2 overflow-x-auto pb-1">
            {calendar.unscheduled.map((item) => (
              <Link
                key={item.id}
                href={itemHref(item.id)}
                scroll={false}
                className="flex shrink-0 flex-col items-center gap-1"
                title={item.title ?? undefined}
              >
                <Thumb assetId={item.assetId} size="size-11" />
                <span
                  className="max-w-13 truncate text-[9px]"
                  style={{ color: "var(--ws-text-3)" }}
                >
                  {item.platform ? SOCIAL_PLATFORM[item.platform].label : "—"}
                </span>
              </Link>
            ))}
          </div>
        </div>
      ) : null}

      <div>
        <div
          className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.1em]"
          style={{ color: "var(--ws-text-3)" }}
        >
          Planned content
          {itemsWithLocalDate.length > 0 ? (
            <span>{itemsWithLocalDate.length}</span>
          ) : null}
        </div>

        {itemsWithLocalDate.length === 0 ? (
          <p className="px-0.5 text-sm" style={{ color: "var(--ws-text-3)" }}>
            Nothing scheduled this month.
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {itemsWithLocalDate.map(({ item, localDateTime }) => {
              const dayName = new Date(
                `${localDateTime.slice(0, 10)}T00:00:00Z`,
              )
                .toLocaleDateString("en-US", {
                  weekday: "short",
                  timeZone: "UTC",
                })
                .toUpperCase();
              const dayNumber = localDateTime.slice(8, 10);
              const time = localDateTime.slice(11, 16);
              const isSelected = selectedItem?.id === item.id;

              return (
                <Link
                  key={item.id}
                  href={itemHref(item.id)}
                  scroll={false}
                  className="flex items-center gap-3 rounded-2xl border p-3 shadow-[0_1px_3px_rgba(52,75,29,0.04)] transition-colors hover:bg-[var(--ws-hover)]"
                  style={{
                    borderColor: isSelected
                      ? "var(--ws-text)"
                      : "var(--ws-border)",
                    background: isSelected ? "var(--ws-hover)" : undefined,
                  }}
                >
                  <div
                    className="flex size-11 shrink-0 flex-col items-center justify-center rounded-xl"
                    style={{ background: "var(--ws-surface-2)" }}
                  >
                    <span
                      className="text-[9px] font-medium"
                      style={{ color: "var(--ws-text-3)" }}
                    >
                      {dayName}
                    </span>
                    <span
                      className="text-sm font-semibold"
                      style={{ color: "var(--ws-text)" }}
                    >
                      {dayNumber}
                    </span>
                  </div>
                  <Thumb assetId={item.assetId} />
                  <div className="min-w-0 flex-1">
                    <div
                      className="truncate text-xs font-medium"
                      style={{ color: "var(--ws-text)" }}
                    >
                      {item.platform
                        ? SOCIAL_PLATFORM[item.platform].label
                        : item.type}
                    </div>
                    <div
                      className="mt-0.5 text-[10px]"
                      style={{ color: "var(--ws-text-3)" }}
                    >
                      {time} · {CREATIVE_STATUS[item.status].label}
                    </div>
                  </div>
                  <ChevronRight
                    className="size-3.5 shrink-0"
                    style={{ color: "var(--ws-text-3)" }}
                  />
                </Link>
              );
            })}
          </div>
        )}
      </div>

      <form action={submitProjectCommandAction}>
        <input type="hidden" name="projectId" value={projectId} />
        <input type="hidden" name="text" value="Plan this week" />
        <button
          type="submit"
          className="w-full rounded-xl border px-3 py-2.5 text-center text-xs font-medium transition-colors hover:bg-[var(--ws-hover)]"
          style={{ borderColor: "var(--ws-border)", color: "var(--ws-text)" }}
        >
          + Prepare a weekly plan
        </button>
      </form>
    </div>
  );
}

// Inline day/time assignment for one creative — the calendar's one real
// write path (assignCreativeDateAction, shared with /takvim's own
// dialog), reached without ever leaving this panel. Deliberately narrow:
// no approve/reject (the creative-ready chat card already has live
// Approve/Reject buttons) and no image regeneration (same — the chat
// card's Revise button covers that) — this block's only job is WHEN it
// goes out, not what it looks like or whether it's approved.
function ScheduleQuickEdit({
  item,
  timezone,
  closeHref,
}: {
  item: {
    id: string;
    title: string | null;
    platform: SocialPlatform | null;
    status: CreativeStatus;
    assetId: string | null;
    scheduledFor: string | null;
  };
  timezone: string;
  closeHref: string;
}) {
  const scheduledValue = item.scheduledFor
    ? utcToZonedDateTimeLocal(new Date(item.scheduledFor), timezone)
    : "";

  return (
    <div
      className="space-y-2.5 rounded-2xl border p-3"
      style={{
        borderColor: "var(--ws-border)",
        background: "var(--ws-surface)",
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <Thumb assetId={item.assetId} />
          <div className="min-w-0">
            <p
              className="truncate text-xs font-medium"
              style={{ color: "var(--ws-text)" }}
            >
              {item.title ?? "Creative"}
            </p>
            <p className="text-[10px]" style={{ color: "var(--ws-text-3)" }}>
              {item.platform ? SOCIAL_PLATFORM[item.platform].label : "—"} ·{" "}
              {CREATIVE_STATUS[item.status].label}
            </p>
          </div>
        </div>
        <Link
          href={closeHref}
          scroll={false}
          aria-label="Close"
          className="flex size-6 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-[var(--ws-hover)]"
          style={{ color: "var(--ws-text-3)" }}
        >
          <X className="size-3.5" />
        </Link>
      </div>
      <ActionForm
        action={assignCreativeDateAction}
        successMessage="Schedule updated"
        className="flex items-end gap-1.5"
      >
        <input type="hidden" name="creativeId" value={item.id} />
        <label className="block flex-1 space-y-1">
          <span
            className="text-[10px] font-medium"
            style={{ color: "var(--ws-text-3)" }}
          >
            Day &amp; time ({timezone})
          </span>
          <input
            // Keyed on the value itself: this page polls every 7s
            // (LiveRefresh) and this is an uncontrolled input, so without a
            // key tied to the real value, a background refresh that
            // changes item.scheduledFor (another tab, another session)
            // would silently NOT update what's shown here — React only
            // honors defaultValue on a fresh mount, not on a re-render of
            // the same element.
            key={scheduledValue}
            type="datetime-local"
            name="date"
            defaultValue={scheduledValue}
            className="h-8 w-full rounded-lg border px-2 text-xs"
            style={{ borderColor: "var(--ws-border)", color: "var(--ws-text)" }}
          />
        </label>
        <SubmitButton size="sm" variant="outline">
          Save
        </SubmitButton>
      </ActionForm>
    </div>
  );
}
