"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { ChevronLeft, ChevronRight, Minus, Plus } from "lucide-react";

import { addDaysToKey } from "@/lib/calendar/grid";
import {
  dayInRange,
  keyboardDayStep,
  monthShortName,
  monthTitle,
  nudgeTime,
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

// Saat seçimi KAYDIRMASIZ ve tek bakışta: ortada yazılan/gösterilen saat, iki
// yanında adım düğmeleri (−/+), altında tek dokunuşluk sık saatler. Başka bir
// dakika (18:45) elle yazılır; yukarı/aşağı ok tuşları da adım atar.

const NUDGE_BUTTON =
  "inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-input text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-40";

// "30 minutes" / "1 hour": adım düğmelerinin erişilebilir adı.
function stepWords(step: number): string {
  return step === 60 ? "1 hour" : `${step} minutes`;
}

export function TimePanel({
  value,
  onChange,
  step,
  presets,
  onPreset,
  onEnter,
}: {
  // "HH:mm" ya da boş.
  value: string;
  onChange: (time: string) => void;
  // −/+ düğmelerinin ve ok tuşlarının adımı (dakika).
  step: number;
  presets: readonly string[];
  // Bir kısayol saate dokunuldu (değer onChange ile zaten iletildi). Başka
  // seçilecek şeyi olmayan alan burada kapanır; gün de seçiliyorsa açık kalır.
  onPreset?: (time: string) => void;
  // Yazıp Enter: seçimi uygula. Değer, yazılan (anlaşılan) saattir; çağıran
  // bunu kullansın, çünkü onChange'in state'i bu olayda henüz yenilenmemiştir.
  onEnter?: (time: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  // Yazılmakta olan metin anlaşılıyorsa o, yoksa değer: düğmeler buradan adım atar.
  const base = (draft !== null ? parseTimeInput(draft) : null) ?? value;
  const earlier = nudgeTime(base, -1, step);
  const later = nudgeTime(base, 1, step);

  function nudge(next: string | null) {
    if (!next) return;
    setDraft(null);
    onChange(next);
  }

  function commitDraft(): string | null {
    if (draft === null) return value || null;
    const parsed = parseTimeInput(draft);
    setDraft(null);
    if (parsed) onChange(parsed);
    return parsed ?? (value || null);
  }

  return (
    <div className="w-48 space-y-2.5" data-slot="time-panel">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          aria-label={`${stepWords(step)} earlier`}
          disabled={!earlier}
          onClick={() => nudge(earlier)}
          className={NUDGE_BUTTON}
        >
          <Minus aria-hidden className="size-4" />
        </button>
        <input
          data-time-input
          inputMode="numeric"
          autoComplete="off"
          aria-label="Time (HH:mm)"
          placeholder="HH:mm"
          value={draft ?? value}
          onChange={(event) => {
            const text = event.target.value;
            setDraft(text);
            // Anlaşılan her saat hemen iletilir: panel Enter'a basılmadan
            // (dışarı tıklayarak) kapansa da yazılan saat kaybolmaz.
            const parsed = parseTimeInput(text);
            if (parsed && parsed !== value) onChange(parsed);
          }}
          onBlur={commitDraft}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              const time = commitDraft();
              if (time) onEnter?.(time);
            } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
              event.preventDefault();
              nudge(event.key === "ArrowUp" ? later : earlier);
            }
          }}
          className="h-9 min-w-0 flex-1 rounded-lg border border-input bg-transparent px-2 text-center text-base font-medium tabular-nums transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
        />
        <button
          type="button"
          aria-label={`${stepWords(step)} later`}
          disabled={!later}
          onClick={() => nudge(later)}
          className={NUDGE_BUTTON}
        >
          <Plus aria-hidden className="size-4" />
        </button>
      </div>
      {presets.length > 0 ? (
        <div className="grid grid-cols-3 gap-1.5">
          {presets.map((preset) => (
            <button
              key={preset}
              type="button"
              aria-pressed={preset === value}
              onClick={() => {
                setDraft(null);
                onChange(preset);
                onPreset?.(preset);
              }}
              className={cn(
                "h-8 rounded-lg border text-xs font-medium tabular-nums outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
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
