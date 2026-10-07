// Mesai saatlerinde yayın (docs/meta-ads-plan.md F5b, "adset_schedule").
// Meta bunu yalnız toplam (lifetime) bütçeli ad set'te kabul eder; gün 0 =
// Pazar, dakikalar saat başı (60'ın katı). Saat hesap saatine göredir
// (timezone_type ADVERTISER). Saf.

export type DayPart = {
  // 0 = Pazar … 6 = Cumartesi.
  days: number[];
  startMinute: number;
  endMinute: number;
};

export type BusinessHours = {
  // Başlangıç saati 0-23, bitiş 1-24 (bitiş başlangıçtan büyük).
  from: number;
  to: number;
  weekdaysOnly: boolean;
};

const WEEKDAYS = [1, 2, 3, 4, 5];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

export function validHours(hours: BusinessHours): boolean {
  return (
    Number.isInteger(hours.from) &&
    Number.isInteger(hours.to) &&
    hours.from >= 0 &&
    hours.from <= 23 &&
    hours.to >= 1 &&
    hours.to <= 24 &&
    hours.to > hours.from
  );
}

export function dayPartOf(hours: BusinessHours): DayPart {
  return {
    days: hours.weekdaysOnly ? [...WEEKDAYS] : [...ALL_DAYS],
    startMinute: hours.from * 60,
    endMinute: hours.to * 60,
  };
}

// Meta'nın `adset_schedule` alanı.
export function adsetScheduleParam(part: DayPart) {
  return [
    {
      start_minute: part.startMinute,
      end_minute: part.endMinute,
      days: part.days,
      timezone_type: "ADVERTISER",
    },
  ];
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function clock(minute: number): string {
  const hour = Math.floor(minute / 60);
  return `${String(hour === 24 ? 24 : hour).padStart(2, "0")}:00`;
}

// "Mon–Fri 09:00–18:00".
export function dayPartLabel(part: DayPart): string {
  const days = [...part.days].sort((a, b) => a - b);
  const range =
    days.length === 7
      ? "Every day"
      : days.length === 5 && days.join() === WEEKDAYS.join()
        ? "Mon–Fri"
        : days.map((day) => DAY_NAMES[day]).join(", ");
  return `${range} ${clock(part.startMinute)}–${clock(part.endMinute)}`;
}

export function hoursPerWeek(part: DayPart): number {
  return (part.days.length * (part.endMinute - part.startMinute)) / 60;
}
