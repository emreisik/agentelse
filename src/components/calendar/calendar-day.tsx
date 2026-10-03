"use client";

import { memo, type DragEvent } from "react";

import { formatDayLong, type CalendarView } from "@/lib/calendar/grid";
import { isDroppableDay } from "@/lib/calendar/move";
import { STAGE_META, type StageTone } from "@/lib/calendar/stage";
import { cn } from "@/lib/utils";

import {
  CompactChip,
  RichCard,
  type BoardItem,
  type DragHandlers,
} from "./calendar-items";

export type BoardDay = {
  key: string;
  day: number;
  month: number;
  // 0 = Pazartesi ... 6 = Pazar
  weekday: number;
};

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// Sürüklenen parçanın kimliğini taşıyan özel tür: dragover sırasında veri
// okunamaz ama `types` okunur; böylece dışarıdan gelen bir dosya/metin
// sürüklemesi hücrelerde bırakma hedefi gibi davranmaz.
export const DRAG_TYPE = "application/x-calendar-item";

const MONTH_CHIP_LIMIT = 3;

const TONE_DOT: Record<StageTone, string> = {
  positive: "bg-success",
  active: "bg-primary",
  waiting: "bg-warning",
  neutral: "bg-muted-foreground/50",
  danger: "bg-destructive",
  special: "bg-special",
};

export type DayCellProps = {
  day: BoardDay;
  view: CalendarView;
  items: BoardItem[];
  inFocus: boolean;
  todayKey: string;
  // Bir sürükleme sürerken bu gün bırakmaya uygun değil (geçmiş).
  dimmed: boolean;
  over: boolean;
  selected: boolean;
  expanded: boolean;
  // Yalnız bu hücredeki açık / sürüklenen parçanın kimliği (başka hücrelerde
  // null): yoksa açık parça değişince bütün hücreler yeniden render olur.
  activeId: string | null;
  draggingId: string | null;
  hrefPrefix: string;
  drag: DragHandlers;
  onOpen: (id: string) => void;
  onSelect: (dayKey: string) => void;
  onToggleExpand: (dayKey: string) => void;
  onOver: (key: string | null) => void;
  onDropDay: (event: DragEvent, dayKey: string) => void;
};

function DayCellView(props: DayCellProps) {
  const { day, view, items, todayKey, dimmed, over } = props;
  const isToday = day.key === todayKey;
  const droppable = isDroppableDay(day.key, todayKey);
  const weekend = day.weekday >= 5;
  const month = view === "month";
  const shown =
    month && !props.expanded ? items.slice(0, MONTH_CHIP_LIMIT) : items;
  const overflow = items.length - shown.length;

  const chip = (
    item: BoardItem,
    Chip: typeof CompactChip | typeof RichCard,
  ) => (
    <Chip
      key={item.id}
      item={item}
      href={`${props.hrefPrefix}${item.id}`}
      active={item.id === props.activeId}
      dragging={item.id === props.draggingId}
      drag={props.drag}
      onOpen={props.onOpen}
    />
  );

  return (
    <div
      role="gridcell"
      aria-selected={month ? props.selected : undefined}
      onDragOver={(event) => {
        if (!droppable || !event.dataTransfer.types.includes(DRAG_TYPE)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        props.onOver(day.key);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          props.onOver(null);
      }}
      onDrop={(event) => props.onDropDay(event, day.key)}
      className={cn(
        "bg-background p-1.5 transition-colors",
        month ? "min-h-14 md:min-h-32" : "min-h-20 md:min-h-44",
        weekend && "bg-muted/25",
        !props.inFocus && "bg-muted/40",
        dimmed && "opacity-50",
        over && "bg-primary/10 ring-2 ring-primary ring-inset",
        month &&
          props.selected &&
          "ring-2 ring-foreground/40 ring-inset md:ring-0",
      )}
    >
      <div className="flex items-center justify-between gap-1">
        <button
          type="button"
          onClick={() => props.onSelect(day.key)}
          aria-label={formatDayLong(day.key)}
          className="inline-flex items-center gap-1.5 rounded-full text-left"
        >
          <span
            className={cn(
              "inline-flex size-6 items-center justify-center rounded-full text-[11px]",
              isToday
                ? "bg-primary font-semibold text-primary-foreground"
                : props.inFocus
                  ? "text-foreground"
                  : "text-muted-foreground/50",
            )}
          >
            {day.day}
          </span>
          {!month ? (
            <span className="text-[11px] font-medium text-muted-foreground uppercase">
              {WEEKDAYS[day.weekday]}
            </span>
          ) : null}
        </button>
        {items.length > 0 ? (
          <span
            className={cn(
              "text-[10px] text-muted-foreground tabular-nums",
              month && "md:hidden",
            )}
          >
            {items.length}
          </span>
        ) : null}
      </div>

      {month ? (
        <>
          <div className="mt-1 hidden space-y-1 md:block">
            {shown.map((item) => chip(item, CompactChip))}
            {overflow > 0 ? (
              <button
                type="button"
                onClick={() => props.onToggleExpand(day.key)}
                className="px-0.5 text-[10px] font-medium text-muted-foreground hover:text-foreground"
              >
                +{overflow} more
              </button>
            ) : props.expanded && items.length > MONTH_CHIP_LIMIT ? (
              <button
                type="button"
                onClick={() => props.onToggleExpand(day.key)}
                className="px-0.5 text-[10px] font-medium text-muted-foreground hover:text-foreground"
              >
                Show less
              </button>
            ) : null}
          </div>
          <div className="mt-1 flex flex-wrap gap-0.5 md:hidden">
            {items.slice(0, 6).map((item) => (
              <span
                key={item.id}
                aria-hidden
                className={cn(
                  "size-1.5 rounded-full",
                  TONE_DOT[STAGE_META[item.stage].tone],
                )}
              />
            ))}
          </div>
        </>
      ) : (
        <div className="mt-1.5 space-y-1.5">
          {items.map((item) => chip(item, RichCard))}
        </div>
      )}
    </div>
  );
}

function sameItems(a: readonly BoardItem[], b: readonly BoardItem[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// Özel karşılaştırma: gün kovaları her yeni veride yeni dizi olur, ama içindeki
// parça NESNELERİ değişmediyse hücre yeniden render edilmez.
export const DayCell = memo(DayCellView, (prev, next) => {
  const keys = Object.keys(next) as (keyof DayCellProps)[];
  for (const key of keys) {
    if (key === "items") {
      if (!sameItems(prev.items, next.items)) return false;
    } else if (prev[key] !== next[key]) {
      return false;
    }
  }
  return true;
});
