import type { WebsiteReportVariant } from "./types";

// GA-F5 sabit metinleri ve tarih etiketleri (arayüz metni İngilizce). Kartın
// bölüm başlıkları ve açıklamaları burada toplanır; özet ve dışa aktarma
// aynı metinleri kullanır. Saf ve izomorfik.

export const WEBSITE_REPORT_COPY = {
  snapshotNote: "This report keeps the numbers as they were when it was sent.",
  preliminaryNote:
    "Numbers from the last 7 days may still change slightly as Google finalizes them.",
  missingDaysNote: "Some days in this period have no data.",
  noKeyEventsNote:
    "No key events were recorded. Set them up so reports can count leads and sales.",
  insightsPending: "Findings for this week are still being prepared.",
  narrativeLabel: "Summary (AI, checked against the numbers)",
  narrativeMock: "AI summary is not available in demo mode.",
  narrativeDemo: "AI summary is skipped for demo data.",
  narrativeDropped:
    "The AI summary was left out because it named numbers the report does not hold.",
  narrativeFailed: "The AI summary could not be written this time.",
  forecastShort: "Forecasts start after 8 weeks of data.",
  forecastEarly: "Too early in the month for a forecast.",
  planNeedMonths: "Targets need two full months of data.",
  planNoMetrics: "Not enough visits yet to suggest targets.",
  alertBody:
    "Agentelse found a tracking problem that stops reports from being accurate. Open it to see how to fix it.",
  reconnectBody:
    "Google Analytics needs to be reconnected before reports can continue. Open it to reconnect.",
  sourceLine:
    "Google Analytics, property time ({tz}). Totals come from Google Analytics daily totals.",
  holidayNote: "Yesterday was a public holiday.",
  suspectNote:
    "Yesterday had a tracking problem, so it is not compared with a usual day.",
  reportUnavailable: "This report can't be shown.",
  archiveEmpty:
    "Your first weekly report arrives on Monday after Google Analytics has the week's data.",
} as const;

export type WebsiteReportCopyKey = keyof typeof WEBSITE_REPORT_COPY;

function dayDate(day: string): Date | null {
  const date = new Date(`${day}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function format(
  day: string,
  options: Intl.DateTimeFormatOptions,
): string {
  const date = dayDate(day);
  if (!date) return day;
  return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(
    date,
  );
}

// "2026-10-05" → "Oct 5".
export function dayLabel(day: string): string {
  return format(day, { month: "short", day: "numeric" });
}

// "2026-10-05" → "Mon, Oct 5".
export function weekdayDayLabel(day: string): string {
  return format(day, { weekday: "short", month: "short", day: "numeric" });
}

// "2026-09-28", "2026-10-04" → "Sep 28 – Oct 4"; yıllar farklıysa her iki
// uca da yıl eklenir.
export function rangeLabel(from: string, to: string): string {
  if (from.slice(0, 4) === to.slice(0, 4)) {
    return `${dayLabel(from)} – ${dayLabel(to)}`;
  }
  const withYear = (day: string) =>
    format(day, { month: "short", day: "numeric", year: "numeric" });
  return `${withYear(from)} – ${withYear(to)}`;
}

// "2026-09" → "September 2026".
export function monthLabel(month: string): string {
  return format(`${month}-01`, { month: "long", year: "numeric" });
}

// Kart başlığı.
export function reportTitle(
  variant: WebsiteReportVariant,
  input: {
    day?: string;
    from?: string;
    to?: string;
    month?: string;
    alertTitle?: string;
  },
): string {
  switch (variant) {
    case "pulse":
      return `Website pulse · ${input.day ? weekdayDayLabel(input.day) : ""}`.trimEnd();
    case "weekly":
      return `Weekly website report · ${
        input.from && input.to ? rangeLabel(input.from, input.to) : ""
      }`.trimEnd();
    case "monthly":
      return `Monthly website report · ${
        input.month ? monthLabel(input.month) : ""
      }`.trimEnd();
    case "plan":
      return `Next month plan · ${
        input.month ? monthLabel(input.month) : ""
      }`.trimEnd();
    case "alert":
      return `Tracking alert: ${input.alertTitle ?? ""}`.trimEnd();
  }
}

// Command.summary: rakam içermez (sohbet bağlamına girer).
export function workSummaryOf(variant: WebsiteReportVariant): string {
  switch (variant) {
    case "pulse":
      return "Website pulse";
    case "weekly":
      return "Weekly website report";
    case "monthly":
      return "Monthly website report";
    case "plan":
      return "Next month plan";
    case "alert":
      return "Tracking alert";
  }
}
