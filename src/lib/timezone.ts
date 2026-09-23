// IANA-timezone-aware date conversion without a library dependency
// (date-fns-tz isn't installed, and adding it for three small functions
// wasn't worth it). Used by the content calendar (takvim) once
// Creative.scheduledFor carries a time-of-day, not just a day: a
// `datetime-local` form input gives a naive "YYYY-MM-DDTHH:mm" wall-clock
// string with no timezone info, which has to be interpreted in the
// project's configured timezone (see ProjectSchedule.timezone) to get the
// correct UTC instant to store — and back again to populate the form's
// defaultValue.
//
// The naive approach (`new Date(localeString)` after formatting through
// toLocaleString) is a well-known trap: re-parsing a locale string with no
// explicit timezone falls back to the RUNNING PROCESS's local timezone,
// not the target one — it only "works" by coincidence when the process's
// own TZ happens to match. Verified broken on this exact case locally
// (dev machine's TZ resolves to Europe/Istanbul, so it silently produced
// a 0ms offset for Istanbul input and would have been wrong on Railway's
// TZ=UTC container). This instead uses Intl.DateTimeFormat.formatToParts,
// which is independent of the process's own timezone by construction.

function offsetPartsAsUtcMs(utcMs: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(utcMs)
      .map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  return Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
}

// dateTimeLocal: "YYYY-MM-DDTHH:mm" (a <input type="datetime-local">
// value) interpreted as wall-clock time IN timeZone -> the correct UTC
// instant. One correction pass (standard technique): guess the instant is
// UTC, see what wall-clock that guess reads as in timeZone, and shift by
// the difference. A second pass isn't needed here — the curated slot
// times this feeds aren't landing inside a DST transition's doubled/
// skipped hour, and being off by that transition's own offset (max ~1h,
// only during the transition window) is an acceptable edge case for a
// content-scheduling field.
export function zonedDateTimeToUtc(
  dateTimeLocal: string,
  timeZone: string,
): Date {
  const [datePart, timePart] = dateTimeLocal.split("T");
  const [year, month, day] = datePart!.split("-").map(Number);
  const [hour, minute] = (timePart ?? "00:00").split(":").map(Number);
  const guessUtcMs = Date.UTC(year!, month! - 1, day!, hour ?? 0, minute ?? 0);
  const asIfUtcInZone = offsetPartsAsUtcMs(guessUtcMs, timeZone);
  return new Date(guessUtcMs + (guessUtcMs - asIfUtcInZone));
}

// Reverse of the above — a UTC Date to the "YYYY-MM-DDTHH:mm" wall-clock
// string a datetime-local input's defaultValue expects, as seen in
// timeZone.
export function utcToZonedDateTimeLocal(date: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

// The calendar day (YYYY-MM-DD) a UTC instant falls on AS SEEN in
// timeZone — the content calendar's grid-bucketing key. "en-CA" is a
// locale-formatting trick, not a locale choice: it's the one built-in
// Intl locale that formats dates as YYYY-MM-DD.
export function dayKeyInTimezone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(date);
}
