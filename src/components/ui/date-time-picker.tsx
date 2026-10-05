"use client";

import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { CalendarDays, Clock } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { CalendarPanel, TimePanel } from "@/components/ui/date-time-panels";
import {
  DEFAULT_PICKER_TIME,
  DEFAULT_TIME_PRESETS,
  DEFAULT_TIME_STEP,
  dayInRange,
  dayPresets,
  formatPickerValue,
  gridRange,
  isDayValue,
  isTimeValue,
  fallbackDayFor,
  splitDateTime,
  todayKeyIn,
  viewOfDay,
  withDay,
  withTime,
  type DayPreset,
  type ViewMonth,
} from "@/lib/date-picker";
import { cn } from "@/lib/utils";

// ╔═════════════════════════════════════════════════════════════════════════╗
// ║ Sitenin TEK tarih/saat seçicisi. Hiçbir yerde yerel <input type="date |  ║
// ║ time | datetime-local"> kullanılmaz (eslint de engeller): alan, takvim,  ║
// ║ saat paneli ve gösterim biçimi her yerde AYNI. Tarihe/saate (alanın      ║
// ║ kendisine) tıklanınca açılır; ikon tek başına düğme değildir.            ║
// ║ Değerler duvar saatidir (saat dilimsiz): "YYYY-MM-DD", "HH:mm",          ║
// ║ "YYYY-MM-DDTHH:mm". `name` verilirse gizli bir alan yazılır: FormData    ║
// ║ ile gönderilen formlar eski yerel alanlarla birebir aynı değeri alır.    ║
// ╚═════════════════════════════════════════════════════════════════════════╝

type FieldProps = {
  id?: string;
  // Verilirse gizli bir <input> ile forma yazılır.
  name?: string;
  disabled?: boolean;
  // Okunur ama değiştirilemez: aynı görünüm, açılmaz.
  readOnly?: boolean;
  placeholder?: string;
  className?: string;
  "aria-label"?: string;
  "aria-invalid"?: boolean;
  align?: "start" | "center" | "end";
  // Saat dilimi (IANA): "bugün" o dilimde hesaplanır ve panelde "Times in …"
  // diye yazılır. Verilmezse tarayıcının dilimi.
  timezone?: string;
};

type DayOptions = {
  min?: string;
  max?: string;
  // Bugünden önceki günleri kapatır (min = bugün, `timezone`da).
  disablePast?: boolean;
  // Gün başına planlı parça sayısı: takvimde "planner" noktaları.
  marks?: Record<string, number>;
  // Görünür ay değişince (ve açılışta) görünen ızgara aralığı: planlı gün
  // sayılarını yüklemek için.
  onViewChange?: (range: { first: string; last: string }) => void;
};

function useControlled(
  value: string | undefined,
  defaultValue: string | undefined,
  onChange: ((value: string) => void) | undefined,
): [string, (next: string) => void] {
  const [inner, setInner] = useState(defaultValue ?? "");
  const current = value ?? inner;
  return [
    current,
    (next) => {
      if (value === undefined) setInner(next);
      onChange?.(next);
    },
  ];
}

const FIELD_CLASS =
  "flex h-8 w-full min-w-0 items-center gap-2 rounded-lg border border-input bg-transparent px-2.5 text-left text-sm transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 data-popup-open:border-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40";

// Alan + açılır panel: üç seçicinin ortak kabuğu.
function PickerField({
  icon: Icon,
  text,
  placeholder,
  open,
  onOpenChange,
  id,
  name,
  hiddenValue,
  disabled,
  readOnly,
  className,
  align = "start",
  contentRef,
  focusSelector,
  children,
  ...aria
}: {
  icon: typeof CalendarDays;
  text: string;
  placeholder: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hiddenValue: string;
  contentRef: RefObject<HTMLDivElement | null>;
  // Açılınca odaklanacak öğe (klavye ile hemen kullanılabilsin).
  focusSelector: string;
  children: ReactNode;
} & Pick<
  FieldProps,
  | "id"
  | "name"
  | "disabled"
  | "readOnly"
  | "className"
  | "align"
  | "aria-label"
  | "aria-invalid"
>) {
  const face = (
    <>
      <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span
        className={cn(
          "min-w-0 flex-1 truncate tabular-nums",
          !text && "text-muted-foreground",
        )}
      >
        {text || placeholder}
      </span>
    </>
  );
  return (
    <>
      {name ? <input type="hidden" name={name} value={hiddenValue} /> : null}
      {readOnly ? (
        <div
          role="textbox"
          aria-readonly
          aria-label={aria["aria-label"]}
          id={id}
          className={cn(FIELD_CLASS, "cursor-default", className)}
        >
          {face}
        </div>
      ) : (
        <Popover open={open} onOpenChange={onOpenChange}>
          <PopoverTrigger
            id={id}
            disabled={disabled}
            aria-label={aria["aria-label"]}
            aria-invalid={aria["aria-invalid"]}
            className={cn(FIELD_CLASS, "cursor-pointer", className)}
          >
            {face}
          </PopoverTrigger>
          <PopoverContent
            align={align}
            className="max-h-[min(85dvh,40rem)] w-auto max-w-[calc(100vw-1.5rem)] gap-0 overflow-y-auto p-3"
            initialFocus={() =>
              contentRef.current?.querySelector<HTMLElement>(focusSelector) ??
              true
            }
          >
            <div ref={contentRef}>{children}</div>
          </PopoverContent>
        </Popover>
      )}
    </>
  );
}

// [ipucu ya da eylem]  [Clear] [Done]
function Footer({
  lead,
  canClear,
  onClear,
  onDone,
}: {
  // Solda: genelde "Times in Europe/Istanbul"; çağıran kendi eylemini de koyabilir.
  lead?: ReactNode;
  canClear: boolean;
  onClear: () => void;
  onDone: () => void;
}) {
  return (
    <div className="mt-3 flex items-center justify-between gap-3 border-t border-border pt-2.5">
      <div className="min-w-0 truncate text-[11px] text-muted-foreground">
        {lead}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {canClear ? (
          <Button type="button" variant="ghost" size="xs" onClick={onClear}>
            Clear
          </Button>
        ) : null}
        <Button type="button" size="xs" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}

// Gün seçimi: kısayollar + takvim. Seçilen ay (görünüm) burada durur ve panel
// her açılışta seçili günün (yoksa bugünün) ayından başlar.
function DayPane({
  selected,
  today,
  min,
  max,
  marks,
  presets,
  onViewChange,
  onSelect,
}: {
  selected: string | null;
  today: string;
  min?: string | null;
  max?: string | null;
  marks?: Record<string, number>;
  // Takvimin üstündeki gün kısayolları; verilmezse bugünden hesaplanan dört
  // genel kısayol (Today, Tomorrow, ...).
  presets?: readonly DayPreset[];
  onViewChange?: DayOptions["onViewChange"];
  onSelect: (day: string) => void;
}) {
  const [view, setView] = useState<ViewMonth>(
    () =>
      (selected ? viewOfDay(selected) : null) ??
      viewOfDay(today) ?? { year: 2000, month: 1 },
  );

  // Görünen ay değişince çağıranı haberdar et (planlı gün sayıları için).
  const notify = useRef(onViewChange);
  useEffect(() => {
    notify.current = onViewChange;
  });
  useEffect(() => {
    notify.current?.(gridRange(view));
  }, [view]);

  return (
    <div className="space-y-2.5">
      {/* Takvimle aynı genişlik: yedi gün çipi tek satıra yayılıp paneli
          takvimden geniş yapmasın, iki satıra sarılsın. */}
      <div className="flex max-w-[17.5rem] flex-wrap gap-1">
        {(presets ?? dayPresets(today)).map((preset) => {
          const enabled = dayInRange(preset.key, min, max);
          const active = preset.key === selected;
          return (
            <button
              key={preset.label}
              type="button"
              disabled={!enabled}
              aria-pressed={active}
              onClick={() => {
                onSelect(preset.key);
                const next = viewOfDay(preset.key);
                if (next) setView(next);
              }}
              className={cn(
                "h-6 rounded-full border px-2 text-[11px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-40",
                active
                  ? "border-foreground bg-foreground text-background"
                  : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {preset.label}
            </button>
          );
        })}
      </div>
      <CalendarPanel
        selected={selected}
        today={today}
        min={min}
        max={max}
        marks={marks}
        view={view}
        onViewChange={setView}
        onSelect={onSelect}
      />
    </div>
  );
}

function resolveMin(
  props: DayOptions,
  today: string,
): string | null | undefined {
  return props.min ?? (props.disablePast ? today : undefined);
}

// ── Gün ─────────────────────────────────────────────────────────────────────

export function DatePicker({
  value,
  defaultValue,
  onChange,
  clearable,
  min,
  max,
  disablePast,
  marks,
  onViewChange,
  placeholder = "Pick a day",
  ...field
}: FieldProps &
  DayOptions & {
    value?: string;
    defaultValue?: string;
    onChange?: (day: string) => void;
    clearable?: boolean;
  }) {
  const [current, setCurrent] = useControlled(value, defaultValue, onChange);
  const [open, setOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const day = isDayValue(current) ? current : null;
  const todayAtRender = todayKeyIn(field.timezone);
  const referenceYear = Number(todayAtRender.slice(0, 4));

  return (
    <PickerField
      {...field}
      icon={CalendarDays}
      text={day ? formatPickerValue({ day }, referenceYear) : ""}
      placeholder={placeholder}
      open={open}
      onOpenChange={setOpen}
      hiddenValue={current}
      contentRef={contentRef}
      focusSelector='[data-day][tabindex="0"]'
    >
      <DayPane
        selected={day}
        today={todayAtRender}
        min={resolveMin({ min, disablePast }, todayAtRender)}
        max={max}
        marks={marks}
        onViewChange={onViewChange}
        onSelect={(next) => {
          setCurrent(next);
          setOpen(false);
        }}
      />
      <Footer
        canClear={Boolean(clearable && day)}
        onClear={() => {
          setCurrent("");
          setOpen(false);
        }}
        onDone={() => setOpen(false)}
      />
    </PickerField>
  );
}

// ── Saat ────────────────────────────────────────────────────────────────────

export function TimePicker({
  value,
  defaultValue,
  onChange,
  onCommit,
  clearable,
  step = DEFAULT_TIME_STEP,
  presets = DEFAULT_TIME_PRESETS,
  placeholder = "Pick a time",
  ...field
}: FieldProps & {
  value?: string;
  defaultValue?: string;
  onChange?: (time: string) => void;
  // Panel kapanırken değer açıldığındakinden farklıysa: "kaydet" anı. (Her
  // tıklamada kaydetmek yerine, seçim bitince bir kez.)
  onCommit?: (time: string) => void;
  clearable?: boolean;
  // −/+ düğmelerinin adımı, dakika (1, 5, 10, 15, 30, 60).
  step?: number;
  presets?: readonly string[];
}) {
  const [current, setCurrent] = useControlled(value, defaultValue, onChange);
  const [open, setOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const openedWith = useRef(current);
  const time = isTimeValue(current) ? current : "";

  function handleOpenChange(next: boolean) {
    if (next) openedWith.current = current;
    else if (onCommit && current !== openedWith.current) onCommit(current);
    setOpen(next);
  }

  // Bir kısayola dokunuldu ya da yazıp Enter'a basıldı: seçim bitti. Saat
  // olayın kendisinden gelir (state bu olayda henüz yenilenmemiştir), kaydet
  // ve kapat.
  function settle(next: string) {
    if (onCommit && next !== openedWith.current) onCommit(next);
    setOpen(false);
  }

  return (
    <PickerField
      {...field}
      icon={Clock}
      text={time}
      placeholder={placeholder}
      open={open}
      onOpenChange={handleOpenChange}
      hiddenValue={current}
      contentRef={contentRef}
      focusSelector="[data-time-input]"
    >
      <TimePanel
        value={time}
        onChange={setCurrent}
        step={step}
        presets={presets}
        onPreset={settle}
        onEnter={settle}
      />
      <Footer
        lead={field.timezone ? `Times in ${field.timezone}` : undefined}
        canClear={Boolean(clearable && time)}
        onClear={() => {
          setCurrent("");
          handleOpenChange(false);
        }}
        onDone={() => handleOpenChange(false)}
      />
    </PickerField>
  );
}

// ── Gün + saat ──────────────────────────────────────────────────────────────

// Takvim + saat + alt çubuk: DateTimePicker'ın açılır paneli. Alan olmadan da
// kullanılabilsin diye ayrı dışa açılır (ör. bir tarih bloğuna dokununca
// açılan kendi popover'ı olan yerler): panel HER YERDE bu bileşendir.
export function DateTimePanel({
  value,
  onChange,
  onDone,
  clearable,
  onClear,
  footerLead,
  timezone,
  today: todayOverride,
  min,
  max,
  disablePast,
  marks,
  onViewChange,
  dayShortcuts,
  step = DEFAULT_TIME_STEP,
  timePresets = DEFAULT_TIME_PRESETS,
  defaultTime = DEFAULT_PICKER_TIME,
}: DayOptions & {
  // "YYYY-MM-DDTHH:mm" ya da boş.
  value: string;
  onChange: (value: string) => void;
  // Bitti (Done ya da saatte Enter). Değer, seçimin son halidir: çağıran onu
  // kullansın, çünkü onChange'in state'i Enter olayında henüz yenilenmemiştir.
  onDone: (value: string) => void;
  clearable?: boolean;
  onClear?: () => void;
  // Alt çubuğun solu; verilmezse "Times in <timezone>".
  footerLead?: ReactNode;
  timezone?: string;
  // "Bugün"ü çağıran bilir (ör. plan saat dilimi): verilirse timezone'dan
  // hesaplanmaz.
  today?: string;
  step?: number;
  timePresets?: readonly string[];
  defaultTime?: string;
  // Takvimin üstündeki gün kısayolları (ör. planın haftası); verilmezse genel
  // dört kısayol.
  dayShortcuts?: readonly DayPreset[];
}) {
  // Bugün, panel açıldığı anda bir kez okunur.
  const [today] = useState(() => todayOverride ?? todayKeyIn(timezone));
  const parts = splitDateTime(value);
  const lowest = resolveMin({ min, disablePast }, today);

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row">
        <DayPane
          selected={parts?.day ?? null}
          today={today}
          min={lowest}
          max={max}
          marks={marks}
          presets={dayShortcuts}
          onViewChange={onViewChange}
          onSelect={(day) => onChange(withDay(value, day, defaultTime))}
        />
        <div className="sm:border-l sm:border-border sm:pl-3">
          <TimePanel
            value={parts?.time ?? ""}
            onChange={(time) =>
              onChange(withTime(value, time, fallbackDayFor(today, lowest)))
            }
            step={step}
            presets={timePresets}
            onEnter={(time) => {
              const next = withTime(value, time, fallbackDayFor(today, lowest));
              onChange(next);
              onDone(next);
            }}
          />
        </div>
      </div>
      <Footer
        lead={
          footerLead ?? (timezone ? `Times in ${timezone}` : undefined)
        }
        canClear={Boolean(clearable && parts)}
        onClear={onClear ?? (() => onChange(""))}
        onDone={() => onDone(value)}
      />
    </>
  );
}

export function DateTimePicker({
  value,
  defaultValue,
  onChange,
  clearable,
  min,
  max,
  disablePast,
  marks,
  onViewChange,
  step,
  timePresets,
  defaultTime,
  placeholder = "Pick a day and time",
  ...field
}: FieldProps &
  DayOptions & {
    // "YYYY-MM-DDTHH:mm" ya da boş.
    value?: string;
    defaultValue?: string;
    onChange?: (value: string) => void;
    clearable?: boolean;
    step?: number;
    timePresets?: readonly string[];
    // Saati olmayan bir güne ilk seçimde verilen saat.
    defaultTime?: string;
  }) {
  const [current, setCurrent] = useControlled(value, defaultValue, onChange);
  const [open, setOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const parts = splitDateTime(current);
  const referenceYear = Number(todayKeyIn(field.timezone).slice(0, 4));

  return (
    <PickerField
      {...field}
      icon={CalendarDays}
      text={parts ? formatPickerValue(parts, referenceYear) : ""}
      placeholder={placeholder}
      open={open}
      onOpenChange={setOpen}
      hiddenValue={current}
      contentRef={contentRef}
      focusSelector='[data-day][tabindex="0"]'
    >
      <DateTimePanel
        value={current}
        onChange={setCurrent}
        onDone={() => setOpen(false)}
        clearable={clearable}
        onClear={() => {
          setCurrent("");
          setOpen(false);
        }}
        timezone={field.timezone}
        min={min}
        max={max}
        disablePast={disablePast}
        marks={marks}
        onViewChange={onViewChange}
        step={step}
        timePresets={timePresets}
        defaultTime={defaultTime}
      />
    </PickerField>
  );
}
