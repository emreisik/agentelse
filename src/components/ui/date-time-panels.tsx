"use client";

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { addDaysToKey } from "@/lib/calendar/grid";
import {
  dayInRange,
  DEFAULT_PICKER_TIME,
  HOUR_OPTIONS,
  keyboardDayStep,
  minuteOptions,
  monthShortName,
  monthTitle,
  parseTimeInput,
  shiftDayByMonths,
  shiftView,
  sixWeekGrid,
  viewOfDay,
  weekEdge,
  type ViewMonth,
} from "@/lib/date-picker";
import { cn } from "@/lib/utils";

// Sitenin tek tarih/saat seçicisinin iç panelleri. Dışarıdan doğrudan
// kullanılmaz: DatePicker / TimePicker / DateTimePicker (date-time-picker.tsx)
// bunları aynı şekilde yan yana koyar, böylece hiçbir yerde farklı görünmez.

const WEEKDAYS = ["M", "T", "W", "T", "F", "S", "S"];

const ICON_BUTTON =
  "inline-flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-40";

// ── Takvim ──────────────────────────────────────────────────────────────────

export function CalendarPanel({
  selected,
  today,
  min,
  max,
  marks,
  view,
  onViewChange,
  onSelect,
}: {
  selected: string | null;
  today: string;
  min?: string | null;
  max?: string | null;
  // Gün başına planlı parça sayısı: "planner" noktaları.
  marks?: Record<string, number>;
  view: ViewMonth;
  onViewChange: (view: ViewMonth) => void;
  onSelect: (day: string) => void;
}) {
  const [mode, setMode] = useState<"days" | "months">("days");
  const [pickedFocus, setPickedFocus] = useState<string | null>(null);
  const [yearView, setYearView] = useState(view.year);
  const gridRef = useRef<HTMLDivElement>(null);
  // Odak, klavyeyle (ok tuşları) taşındığında butona gerçekten verilir; ay
  // düğmeleriyle gezerken odak çalınmaz.
  const moveFocus = useRef(false);

  const days = useMemo(() => sixWeekGrid(view), [view]);

  // Tab ile girince odaklanacak gün: seçili, yoksa bugün, yoksa ayın ilki.
  const inView = (key: string | null) =>
    key !== null &&
    viewOfDay(key)?.year === view.year &&
    viewOfDay(key)?.month === view.month;
  const firstOfMonth = `${view.year}-${String(view.month).padStart(2, "0")}-01`;
  const anchor = inView(pickedFocus)
    ? pickedFocus!
    : inView(selected)
      ? selected!
      : inView(today)
        ? today
        : firstOfMonth;

  useEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    gridRef.current
      ?.querySelector<HTMLButtonElement>(`[data-day="${anchor}"]`)
      ?.focus();
  }, [anchor]);

  function onKeyDown(event: KeyboardEvent) {
    let next: string | null = null;
    const step = keyboardDayStep(event.key);
    if (step !== null) next = addDaysToKey(anchor, step);
    else if (event.key === "Home") next = weekEdge(anchor, "start");
    else if (event.key === "End") next = weekEdge(anchor, "end");
    else if (event.key === "PageUp") {
      next = shiftDayByMonths(anchor, event.shiftKey ? -12 : -1);
    } else if (event.key === "PageDown") {
      next = shiftDayByMonths(anchor, event.shiftKey ? 12 : 1);
    }
    if (!next) return;
    event.preventDefault();
    moveFocus.current = true;
    setPickedFocus(next);
    const nextView = viewOfDay(next);
    if (
      nextView &&
      (nextView.year !== view.year || nextView.month !== view.month)
    ) {
      onViewChange(nextView);
    }
  }

  if (mode === "months") {
    return (
      <div className="w-[17.5rem] space-y-2" data-slot="date-months">
        <div className="flex items-center justify-between">
          <button
            type="button"
            className="h-7 rounded-lg px-1.5 text-sm font-semibold tabular-nums outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
            onClick={() => setMode("days")}
          >
            {yearView}
          </button>
          <div className="flex items-center">
            <button
              type="button"
              aria-label="Previous year"
              className={ICON_BUTTON}
              onClick={() => setYearView((y) => y - 1)}
            >
              <ChevronLeft className="size-4" />
            </button>
            <button
              type="button"
              aria-label="Next year"
              className={ICON_BUTTON}
              onClick={() => setYearView((y) => y + 1)}
            >
              <ChevronRight className="size-4" />
            </button>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-1">
          {Array.from({ length: 12 }, (_, i) => i + 1).map((month) => {
            const current = view.year === yearView && view.month === month;
            return (
              <button
                key={month}
                type="button"
                aria-pressed={current}
                onClick={() => {
                  onViewChange({ year: yearView, month });
                  setMode("days");
                }}
                className={cn(
                  "h-9 rounded-lg text-xs font-medium outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50",
                  current &&
                    "bg-primary text-primary-foreground hover:bg-primary/90",
                )}
              >
                {monthShortName(month)}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="w-[17.5rem] space-y-2" data-slot="date-days">
      <div className="flex items-center justify-between gap-1">
        <button
          type="button"
          aria-label="Choose month and year"
          className="h-7 rounded-lg px-1.5 text-sm font-semibold outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
          onClick={() => {
            setYearView(view.year);
            setMode("months");
          }}
        >
          {monthTitle(view)}
        </button>
        <div className="flex items-center">
          <button
            type="button"
            aria-label="Previous month"
            className={ICON_BUTTON}
            onClick={() => onViewChange(shiftView(view, -1))}
          >
            <ChevronLeft className="size-4" />
          </button>
          <button
            type="button"
            aria-label="Next month"
            className={ICON_BUTTON}
            onClick={() => onViewChange(shiftView(view, 1))}
          >
            <ChevronRight className="size-4" />
          </button>
        </div>
      </div>

      <div
        ref={gridRef}
        role="grid"
        aria-label={monthTitle(view)}
        onKeyDown={onKeyDown}
        className="grid grid-cols-7 gap-y-0.5"
      >
        {WEEKDAYS.map((label, index) => (
          <div
            key={index}
            aria-hidden
            className="flex h-6 items-center justify-center text-[11px] font-medium text-muted-foreground"
          >
            {label}
          </div>
        ))}
        {days.map((day) => {
          const isSelected = day.key === selected;
          const isToday = day.key === today;
          const outside = day.month !== view.month;
          const enabled = dayInRange(day.key, min, max);
          const count = marks?.[day.key] ?? 0;
          return (
            <button
              key={day.key}
              type="button"
              role="gridcell"
              data-day={day.key}
              tabIndex={day.key === anchor ? 0 : -1}
              disabled={!enabled}
              aria-selected={isSelected}
              aria-current={isToday ? "date" : undefined}
              title={count > 0 ? `${count} planned` : undefined}
              onClick={() => onSelect(day.key)}
              className={cn(
                "relative mx-auto flex size-8 items-center justify-center rounded-lg text-xs tabular-nums outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60",
                outside && "text-muted-foreground/50",
                isToday &&
                  !isSelected &&
                  "font-semibold ring-1 ring-primary/50 ring-inset",
                isSelected &&
                  "bg-primary font-semibold text-primary-foreground hover:bg-primary/90",
                !enabled && "pointer-events-none opacity-30",
              )}
            >
              {day.day}
              {count > 0 ? (
                <span aria-hidden className="absolute bottom-0.5 flex gap-px">
                  {Array.from({ length: Math.min(count, 3) }, (_, i) => (
                    <span
                      key={i}
                      className={cn(
                        "size-[3px] rounded-full",
                        isSelected ? "bg-primary-foreground" : "bg-primary/70",
                      )}
                    />
                  ))}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Saat ────────────────────────────────────────────────────────────────────

const COLUMN_ITEM =
  "flex h-7 w-full items-center justify-center rounded-md text-xs tabular-nums outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60";

function TimeColumn({
  label,
  options,
  current,
  onPick,
}: {
  label: string;
  options: readonly string[];
  current: string | null;
  onPick: (option: string) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  // Açılışta seçili satır ortada görünsün. scrollIntoView YOK: o, sayfanın
  // kendisini de kaydırırdı; yalnız bu listenin scrollTop'u ayarlanır.
  useLayoutEffect(() => {
    const list = listRef.current;
    const active = list?.querySelector<HTMLElement>("[data-active='true']");
    if (list && active) {
      list.scrollTop =
        active.offsetTop - list.clientHeight / 2 + active.clientHeight / 2;
    }
    // Yalnız ilk yerleşimde (boş bağımlılık): tıklarken liste kaymasın.
  }, []);

  return (
    <div className="min-w-0 flex-1">
      <div className="mb-1 text-center text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </div>
      <div
        ref={listRef}
        role="listbox"
        aria-label={label}
        className="h-36 space-y-0.5 overflow-y-auto overscroll-contain rounded-lg border border-border p-0.5"
      >
        {options.map((option) => {
          const active = option === current;
          return (
            <button
              key={option}
              type="button"
              role="option"
              aria-selected={active}
              data-active={active}
              onClick={() => onPick(option)}
              className={cn(
                COLUMN_ITEM,
                active &&
                  "bg-primary font-semibold text-primary-foreground hover:bg-primary/90",
              )}
            >
              {option}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function TimePanel({
  value,
  onChange,
  step,
  presets,
  onEnter,
}: {
  // "HH:mm" ya da boş.
  value: string;
  onChange: (time: string) => void;
  step: number;
  presets: readonly string[];
  // Yazarken Enter: seçimi uygula ve seçiciyi kapat.
  onEnter?: () => void;
}) {
  const [hour, minute] = value ? value.split(":") : [null, null];
  const [draft, setDraft] = useState<string | null>(null);

  function commitDraft(): string | null {
    if (draft === null) return value || null;
    const parsed = parseTimeInput(draft);
    setDraft(null);
    if (parsed) onChange(parsed);
    return parsed ?? (value || null);
  }

  return (
    <div className="w-44 space-y-2" data-slot="time-panel">
      <input
        data-time-input
        inputMode="numeric"
        autoComplete="off"
        aria-label="Time (HH:mm)"
        placeholder="HH:mm"
        value={draft ?? value}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commitDraft}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          if (commitDraft()) onEnter?.();
        }}
        className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-center text-sm tabular-nums transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
      />
      <div className="flex gap-1.5">
        <TimeColumn
          label="Hour"
          options={HOUR_OPTIONS}
          current={hour}
          onPick={(h) => onChange(`${h}:${minute ?? "00"}`)}
        />
        <TimeColumn
          label="Min"
          options={minuteOptions(step, minute ?? undefined)}
          current={minute}
          onPick={(m) =>
            onChange(`${hour ?? DEFAULT_PICKER_TIME.slice(0, 2)}:${m}`)
          }
        />
      </div>
      {presets.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {presets.map((preset) => (
            <button
              key={preset}
              type="button"
              aria-pressed={preset === value}
              onClick={() => onChange(preset)}
              className={cn(
                "h-6 rounded-full border px-2 text-[11px] font-medium tabular-nums outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
                preset === value
                  ? "border-foreground bg-foreground text-background"
                  : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {preset}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
