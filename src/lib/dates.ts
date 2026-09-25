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

// Day-divider label for the single project chat's chronological timeline
// (project-chat.tsx / thread.tsx DateDivider) — always date-level, unlike
// smartDate above which shows a time for today because it answers "when
// was this modified", not "which day does this divider mark".
export function dayLabel(date: Date | string): string {
  const d = new Date(date);
  if (isToday(d)) return "TODAY";
  if (isYesterday(d)) return "YESTERDAY";
  if (isThisWeek(d, { weekStartsOn: 1 }))
    return format(d, "EEEE", { locale: enUS }).toUpperCase();
  return format(d, "d MMMM yyyy", { locale: enUS });
}

// Local-timezone day key (YYYY-MM-DD) for grouping chat turns into day
// buckets — grouping must follow the viewer's local day boundary, not UTC,
// so this goes through Date/format rather than slicing the ISO string.
export function dayKey(date: Date | string): string {
  return format(new Date(date), "yyyy-MM-dd");
}
