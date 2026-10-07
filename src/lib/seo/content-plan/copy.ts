import type { PlanEmptyReason } from "./types";

// Aylık içerik planının sabit İngilizce metinleri (SC-F7). Rakam yalnız
// girdilerden biçimlenir. Saf ve izomorfik.

export type SlotState =
  | "PLANNED"
  | "IN_PROGRESS"
  | "SCHEDULED"
  | "PUBLISHED"
  | "OVERDUE"
  | "SKIPPED";

export const STATE_LABEL: Record<SlotState, string> = {
  PLANNED: "Planned",
  IN_PROGRESS: "Writing",
  SCHEDULED: "Scheduled",
  PUBLISHED: "Published",
  OVERDUE: "Overdue",
  SKIPPED: "Skipped",
};

export const EMPTY_COPY: Record<PlanEmptyReason, string> = {
  NO_DATA:
    "Not enough search data yet. The plan starts once Search Console has a few weeks of data.",
  NO_CLUSTERS:
    "No topic groups yet. They appear after the weekly search analysis.",
  NO_GAPS:
    "Your site already answers the topics people search for. No new articles needed this month.",
  CAP_FULL: "You already have all the articles this month's limit allows.",
  NO_ROOM:
    "Too few days are left this month for a good plan. The next plan comes at the start of next month.",
  AI_LIMIT: "The daily AI limit was reached. The plan comes tomorrow.",
  ALL_FILTERED:
    "The remaining topics were too close to articles you already have.",
};

// Aylık sınıra takılan yerleştirme/üretim için tek mesaj.
export function SEO_CAP_MESSAGE(cap: number): string {
  return `The limit of ${cap} articles for that month is reached. Change the limit on the Search page, or pick another month.`;
}

export const PLAN_COPY = {
  sectionTitle: "This month's articles",
  writeButton: "Write this article",
  continueButton: "Continue writing",
  skip: "Skip",
  replace: "Replace",
  move: "Move",
  refresh: "Refresh plan",
  planNow: "Plan this month",
  limitLabel: "Monthly limit",
  autoLabel: "Plan articles automatically each month",
  basicWording: "Titles use basic wording",
  aiLimitNote:
    "The AI limit was reached, so titles use basic wording. Refresh the plan later.",
  noCrawlNote:
    "Link suggestions come from search data only; turn on the site scan to check them.",
  noStrongMain: "No strong main page yet",
  skipNote:
    "Skip excludes this topic for three months and removes its idea from your pool.",
  relaxedNote:
    "Some topic groups have more than one article because few groups had a clear gap.",
} as const;
