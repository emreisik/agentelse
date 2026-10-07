import type { DidMetric, EvaluationReason } from "@/lib/seo/actions/types";

import type { SplitChangeKind, SplitEvaluation, SplitStatus } from "./types";

// Bölünmüş test metinleri (sabit İngilizce şablonlar). Sayılar yalnız
// SplitEvaluation'dan gelir; hiçbir metin Google verisi ya da LLM çıktısı
// taşımaz.

export const SPLIT_KIND_LABEL: Record<SplitChangeKind, string> = {
  TITLE_META: "Titles and descriptions",
  SCHEMA: "Structured data",
  INTERNAL_LINKS_BLOCK: "Internal links block",
  CONTENT_BLOCK: "Content block",
  TEMPLATE_CHANGE: "Template change",
  OTHER: "Something else",
};

export const SPLIT_STATUS_LABEL: Record<SplitStatus, string> = {
  DRAFT: "Ready to apply",
  APPLIED: "Waiting for the change",
  EVALUATING: "Measuring",
  WORKED: "Worked",
  DIDNT: "Didn't work",
  INCONCLUSIVE: "No clear result",
  CANCELLED: "Cancelled",
  EXPIRED: "Expired",
};

export const SPLIT_REASON_TEXT: Record<EvaluationReason | "PRE_TREND", string> =
  {
    LOW_DATA: "These pages didn't get enough search traffic to tell.",
    NO_DATA: "There wasn't enough Search Console data for the test period.",
    NO_SEARCH_DATA: "There is no Search Console data for this site yet.",
    NO_PAGE: "The test pages weren't found in your Search Console data.",
    GOOGLE_UPDATE:
      "A Google ranking update overlapped the test, so the result can't be trusted.",
    OVERLAPPING_CHANGE:
      "Another change touched the same pages during the test.",
    ALERT_GONE: "The related alert is gone, so there was nothing to measure.",
    PRE_TREND: "The two groups already moved differently before the change.",
  };

export const SPLIT_METRIC_LABEL: Record<DidMetric, string> = {
  ctr_adj: "click-through rate for their position",
  clicks: "clicks",
  impressions: "impressions",
};

export const SPLIT_PLACEBO_NOTE =
  "The test pages are not resampled, so the range is widened by a placebo check.";

export const SPLIT_CMS_NOTE =
  "Changes go through your approvals. Large tests can take a few days to finish.";

// Her tür için 2-4 adım; sayı içermez.
export const SPLIT_INSTRUCTIONS: Record<SplitChangeKind, string[]> = {
  TITLE_META: [
    "Change the title or description only on the test pages.",
    "Leave every control page exactly as it is.",
    "Publish, then tell us the day it went live.",
  ],
  SCHEMA: [
    "Add the structured data only to the test pages.",
    "Leave the control pages without it.",
    "Check the test pages with a rich results test, then tell us the day it went live.",
  ],
  INTERNAL_LINKS_BLOCK: [
    "Add the links block only to the test pages.",
    "Do not add it to any control page.",
    "Publish, then tell us the day it went live.",
  ],
  CONTENT_BLOCK: [
    "Add or change the content block only on the test pages.",
    "Keep the control pages unchanged.",
    "Publish, then tell us the day it went live.",
  ],
  TEMPLATE_CHANGE: [
    "Apply the template change only to the test pages.",
    "Make sure no control page uses the changed template.",
    "Release it, then tell us the day it went live.",
  ],
  OTHER: [
    "Make your change only on the test pages.",
    "Leave every control page untouched.",
    "Publish, then tell us the day it went live.",
  ],
};

// Kesir -> "+12.3%" / "-4.0%" (tek ondalık).
function percent(value: number): string {
  const rounded = Math.round(value * 1000) / 10;
  const sign = rounded > 0 ? "+" : "";
  return `${sign}${rounded.toFixed(1)}%`;
}

export function splitHeadline(evaluation: SplitEvaluation): string {
  const metric = SPLIT_METRIC_LABEL[evaluation.metric];
  const effect = evaluation.effect;
  switch (evaluation.outcome) {
    case "WORKED":
      return effect === null
        ? "The change worked"
        : `The test pages gained ${percent(effect)} in ${metric}`;
    case "DIDNT":
      return effect === null
        ? "The change didn't help"
        : `The change didn't help: ${percent(effect)} in ${metric}`;
    case "INCONCLUSIVE":
      return evaluation.reason
        ? SPLIT_REASON_TEXT[evaluation.reason]
        : "No clear difference between the test pages and the control pages";
  }
}

export function splitDetail(evaluation: SplitEvaluation): string {
  const lines: string[] = [];
  lines.push(
    `We compared ${evaluation.usedTest} test pages with ${evaluation.usedControl} control pages.`,
  );
  if (
    evaluation.low !== null &&
    evaluation.high !== null &&
    evaluation.effect !== null
  ) {
    lines.push(
      `Best estimate ${percent(evaluation.effect)}, likely between ${percent(evaluation.low)} and ${percent(evaluation.high)}.`,
    );
  }
  if (evaluation.reason && evaluation.outcome !== "INCONCLUSIVE") {
    lines.push(SPLIT_REASON_TEXT[evaluation.reason]);
  }
  if (evaluation.excluded > 0) {
    lines.push(
      `${evaluation.excluded} pages were left out because other changes touched them.`,
    );
  }
  if (evaluation.confidence === "DIRECTIONAL") {
    lines.push("Treat this as a hint, not a proof.");
  }
  lines.push(SPLIT_PLACEBO_NOTE);
  return lines.join(" ");
}
