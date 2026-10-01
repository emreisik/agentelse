import { dayKeyInTimezone, utcToZonedDateTimeLocal } from "@/lib/timezone";

// Fallback clock times (project-local) when a channel has no preferred ones.
export const DEFAULT_SLOT_TIMES = ["10:00", "12:00", "15:00", "18:00"];

export type OccupiedSlot = {
  // Project-local "YYYY-MM-DD" and "HH:mm".
  date: string;
  time: string;
  // Missing channel = the piece blocks every channel (conservative).
  channel?: string;
};

export type SuggestSlotsInput = {
  now: Date;
  timezone: string;
  channel: string;
  occupied: OccupiedSlot[];
  // Preferred Instagram clock times ("HH:mm"), tried before the defaults.
  publishTimes?: string[];
  // Local "YYYY-MM-DD"; days before it are never offered.
  startFrom?: string;
  count?: number;
  minLeadMinutes?: number;
  horizonDays?: number;
};

// "30 9 * * *" -> "09:30"; null for anything that is not a plain M H cron.
export function parseCronTime(cron: string | null | undefined): string | null {
  if (!cron) return null;
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const [m, h] = parts;
  if (!/^\d{1,2}$/.test(m!) || !/^\d{1,2}$/.test(h!)) return null;
  const minute = Number(m);
  const hour = Number(h);
  if (minute > 59 || hour > 23) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

// Calendar arithmetic on a "YYYY-MM-DD" key (no timezone involved).
function addDaysToKey(key: string, days: number): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

export function suggestSlots(input: SuggestSlotsInput): {
  date: string;
  time: string;
}[] {
  const {
    now,
    timezone,
    channel,
    occupied,
    publishTimes,
    startFrom,
    count = 3,
    minLeadMinutes = 60,
    horizonDays = 60,
  } = input;

  const today = dayKeyInTimezone(now, timezone);
  const first = startFrom && startFrom > today ? startFrom : today;
  const last = addDaysToKey(today, horizonDays);
  // Earliest allowed local wall-clock moment; "YYYY-MM-DDTHH:mm" strings
  // compare correctly as text.
  const earliest = utcToZonedDateTimeLocal(
    new Date(now.getTime() + minLeadMinutes * 60_000),
    timezone,
  );

  const candidates =
    channel === "instagram"
      ? [...new Set([...(publishTimes ?? []), ...DEFAULT_SLOT_TIMES])]
      : DEFAULT_SLOT_TIMES;

  const usedByDay = new Map<string, string[]>();
  for (const o of occupied) {
    if (o.channel !== undefined && o.channel !== channel) continue;
    const list = usedByDay.get(o.date) ?? [];
    list.push(o.time);
    usedByDay.set(o.date, list);
  }

  const pass1: { date: string; time: string }[] = [];
  const pass2: { date: string; time: string }[] = [];
  for (
    let day = first;
    day <= last && pass1.length < count;
    day = addDaysToKey(day, 1)
  ) {
    const used = usedByDay.get(day) ?? [];
    if (used.length > 1) continue;
    const time = candidates.find(
      (t) => !used.includes(t) && `${day}T${t}` >= earliest,
    );
    if (!time) continue;
    (used.length === 0 ? pass1 : pass2).push({ date: day, time });
  }

  const picked = [...pass1, ...pass2.slice(0, Math.max(0, count - pass1.length))]
    .slice(0, count)
    .sort((a, b) => a.date.localeCompare(b.date));
  return picked;
}
