import {
  EMPTY_COPY,
  PLAN_COPY,
  SEO_CAP_MESSAGE,
  STATE_LABEL,
  type SlotState,
} from "./copy";
import type { PlanGap, PlanSlotStatus } from "./types";

// Planın ekran yardımcıları (SC-F7): slot durumu, "neden" satırları, yazma
// bağlantısı, ay ve kullanım etiketleri. Saf ve izomorfik.

export { EMPTY_COPY, PLAN_COPY, SEO_CAP_MESSAGE, STATE_LABEL };
export type { SlotState };

const DAY_MS = 86_400_000;

// Slotun canlı durumu HER ZAMAN Creative'den okunur; plan JSON'u yalnız slotun
// kaldırılıp kaldırılmadığını söyler.
export function slotStateOf(input: {
  creativeStatus: string | null;
  scheduledFor: Date | null;
  hasActiveCard: boolean;
  slotStatus: PlanSlotStatus;
  now: Date;
}): SlotState {
  const { creativeStatus, scheduledFor, now } = input;
  if (
    input.slotStatus !== "PLANNED" ||
    creativeStatus === null ||
    creativeStatus === "ARCHIVED" ||
    creativeStatus === "REJECTED"
  ) {
    return "SKIPPED";
  }
  if (creativeStatus === "PUBLISHED") return "PUBLISHED";
  if (creativeStatus === "APPROVED") {
    return scheduledFor !== null && scheduledFor.getTime() < now.getTime()
      ? "OVERDUE"
      : "SCHEDULED";
  }
  // DRAFT / IN_REVIEW
  if (input.hasActiveCard) return "IN_PROGRESS";
  if (
    scheduledFor !== null &&
    scheduledFor.getTime() < now.getTime() - DAY_MS
  ) {
    return "OVERDUE";
  }
  return "PLANNED";
}

// En çok 3 sabit cümle; yalnız pay yüzdesi, boşluk türü ve yükseliş açılır.
export function whyLines(slot: {
  share: number;
  gap: PlanGap;
  rising: boolean;
}): string[] {
  const lines: string[] = [];
  const percent = Math.round(slot.share * 100);
  lines.push(
    percent < 1
      ? "Under 1% of your non-brand search impressions"
      : `About ${percent}% of your non-brand search impressions`,
  );
  lines.push(
    slot.gap === "NO_PILLAR"
      ? "Your site has no strong main page for this topic yet"
      : "No page on your site ranks in the top 20 for it yet",
  );
  if (slot.rising) lines.push("Searches for it are rising");
  return lines.slice(0, 3);
}

export function seoWriteHref(projectId: string, ideaId: string): string {
  return `/projects/${projectId}?module=seo&idea=${encodeURIComponent(ideaId)}`;
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

// "2026-10" -> "October 2026"; tanınmayan değer olduğu gibi döner.
export function monthLabel(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  const name = match ? MONTH_NAMES[Number(match[2]) - 1] : undefined;
  return match && name ? `${name} ${match[1]}` : month;
}

// "3 of 4 articles this month"
export function usageLine(used: number, cap: number): string {
  return `${used} of ${cap} ${cap === 1 ? "article" : "articles"} this month`;
}
