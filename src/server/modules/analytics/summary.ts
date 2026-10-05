import "server-only";

import { ANALYTICS_COPY as COPY } from "@/lib/module-flows/analytics/copy";
import { summaryFactsOf } from "@/lib/module-flows/analytics/facts";
import {
  allowedNumbersOf,
  checkSummaryNumbers,
} from "@/lib/module-flows/analytics/number-check";
import {
  SUMMARY_LIMITS,
  type ReportData,
  type ReportSummary,
} from "@/lib/module-flows/analytics/report";
import { cleanWorksTextOrNull } from "@/lib/works/clean-text";
import {
  limitNoticeFromError,
  limitNoticeReplyText,
} from "@/server/commands/limit-notice";
import { ReasoningService } from "@/server/reasoning/reasoning-service";

import { reportSummaryDef, type ReportSummaryOutput } from "./summary-prompt";

// The honest AI summary of a collected report (docs/modules.md "Analytics"):
// ONE reasoning call given only the report's numbers (facts.ts), in the
// project's language (ReasoningService adds it), budget-capped and audited
// like every engine call. The answer is cleaned, clipped, and every sentence
// naming a number the data does not hold is dropped (number-check.ts). Never
// throws: without a summary the report still stands, and `note` says why.

export type SummaryScope = {
  workspaceId: string;
  projectId: string;
  brandId: string;
};

export type SummaryOutcome =
  { summary: ReportSummary; note: null } | { summary: null; note: string };

function cleanList(items: readonly string[], max: number): string[] {
  const out: string[] = [];
  for (const item of items) {
    const text = cleanWorksTextOrNull(item, SUMMARY_LIMITS.item);
    if (text) out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

// Model text made safe to store and show: one line, no markup or links,
// nothing instruction-shaped, clipped to the card's limits.
export function cleanSummary(output: ReportSummaryOutput): ReportSummary {
  return {
    headline:
      cleanWorksTextOrNull(output.headline, SUMMARY_LIMITS.headline) ?? "",
    highlights: cleanList(output.highlights, SUMMARY_LIMITS.highlights),
    watchouts: cleanList(output.watchouts, SUMMARY_LIMITS.watchouts),
    nextSteps: cleanList(output.nextSteps, SUMMARY_LIMITS.nextSteps),
  };
}

export async function summarizeReport(
  scope: SummaryScope,
  report: ReportData,
): Promise<SummaryOutcome> {
  const facts = summaryFactsOf(report);
  if (facts.sections.length === 0) {
    return { summary: null, note: COPY.summaryNoNumbers };
  }
  // A mock answer must never be stored as a real summary.
  if (ReasoningService.isMockMode()) {
    return { summary: null, note: COPY.summaryUnavailable };
  }
  try {
    const { output } = await ReasoningService.run(reportSummaryDef, {
      ...scope,
      context: { facts },
    });
    const checked = checkSummaryNumbers(
      cleanSummary(output),
      allowedNumbersOf(facts),
    );
    return checked
      ? { summary: checked, note: null }
      : { summary: null, note: COPY.summaryDropped };
  } catch (error) {
    const notice = limitNoticeFromError(error);
    if (notice) return { summary: null, note: limitNoticeReplyText(notice) };
    console.error(
      "[analytics] report summary failed:",
      error instanceof Error ? error.message : error,
    );
    return { summary: null, note: COPY.summaryFailed };
  }
}
