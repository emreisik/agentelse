import {
  format,
  formatDistanceToNow,
  isThisWeek,
  isToday,
  isYesterday,
} from "date-fns";
import { tr } from "date-fns/locale";

// Single point for Turkish-locale date rendering — never call date-fns with
// a locale inline; use these.
export function timeAgo(date: Date | string | null | undefined): string {
  if (!date) return "—";
  return formatDistanceToNow(new Date(date), { addSuffix: true, locale: tr });
}

export function shortDate(date: Date | string | null | undefined): string {
  if (!date) return "—";
  return format(new Date(date), "d MMM yyyy HH:mm", { locale: tr });
}

// Dosya gezgini tarzı "değiştirilme" gösterimi: bugünse saat, dünse "Dün",
// bu haftaysa gün adı, daha eskiyse kısa tarih (Kütüphane paneli için).
export function smartDate(date: Date | string | null | undefined): string {
  if (!date) return "—";
  const d = new Date(date);
  if (isToday(d)) return format(d, "HH:mm", { locale: tr });
  if (isYesterday(d)) return "Dün";
  if (isThisWeek(d, { weekStartsOn: 1 }))
    return format(d, "EEEE", { locale: tr });
  return format(d, "d MMM yyyy", { locale: tr });
}
