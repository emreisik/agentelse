import {
  format,
  formatDistanceToNow,
  isThisWeek,
  isToday,
  isYesterday,
} from "date-fns";
import { enUS } from "date-fns/locale";

// Single point for English-locale date rendering — never call date-fns with
// a locale inline; use these.
export function timeAgo(date: Date | string | null | undefined): string {
  if (!date) return "—";
  return formatDistanceToNow(new Date(date), {
    addSuffix: true,
    locale: enUS,
  });
}

export function shortDate(date: Date | string | null | undefined): string {
  if (!date) return "—";
  return format(new Date(date), "d MMM yyyy HH:mm", { locale: enUS });
}

// File-explorer-style "modified" display: time if today, "Yesterday" if
// yesterday, day name if this week, short date if older (for the Library
// panel).
export function smartDate(date: Date | string | null | undefined): string {
  if (!date) return "—";
  const d = new Date(date);
  if (isToday(d)) return format(d, "HH:mm", { locale: enUS });
  if (isYesterday(d)) return "Yesterday";
  if (isThisWeek(d, { weekStartsOn: 1 }))
    return format(d, "EEEE", { locale: enUS });
  return format(d, "d MMM yyyy", { locale: enUS });
}
