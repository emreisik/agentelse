import "server-only";

import { buildMonthlyCard } from "@/lib/website-analytics/reports/build";
import { workSummaryOf } from "@/lib/website-analytics/reports/copy";
import { reportCommandId } from "@/lib/website-analytics/reports/ids";
import { buildPlanCard } from "@/lib/website-analytics/reports/plan";
import { websiteReportChatDigest } from "@/lib/website-analytics/reports/text";
import type {
  NarrativeMode,
  ReportStepResult,
  ReportWriteResult,
} from "@/lib/website-analytics/reports/types";
import { ReasoningService } from "@/server/reasoning/reasoning-service";

import {
  loadMonthlyReportInput,
  loadPlanReportInput,
  type GaReportContext,
} from "./inputs";
import { narrateCard } from "./narrative";
import {
  postToWebsiteChat,
  stepResultOf,
  websiteReportExists,
} from "./website-chat";

// GA-F5 aylık rapor ve "Next month plan" (docs/website-reports.md "Aylık
// rapor", "Plan"). Aylık rapor önceki takvim ayıdır (mülk günleri); plan
// hedef ayın önerilen hedefleridir ve LLM kullanmaz. İkisi de yalnız
// ambardan okunur, Google çağrısı yoktur, kimlikleri sabittir.

export const GaMonthlyReport = {
  async write(
    ctx: GaReportContext,
    month: string,
    insights: "on" | "pending" | "off",
    options: { narrative: NarrativeMode },
  ): Promise<ReportWriteResult> {
    const commandId = reportCommandId("monthly", ctx.projectId, month);
    if (await websiteReportExists(commandId)) {
      return { result: "exists", narrative: null };
    }
    const llmNeeded = !ctx.link.isMock && !ReasoningService.isMockMode();
    if (options.narrative === "defer" && llmNeeded) {
      return { result: "deferred", narrative: null };
    }

    const input = await loadMonthlyReportInput(ctx, month, insights);
    if (
      input.current.totals.sessions === 0 &&
      input.previous.totals.sessions === 0
    ) {
      return { result: "empty", narrative: null };
    }
    const built = buildMonthlyCard(input);
    const { card, status } = await narrateCard({
      ctx,
      card: built,
      findings: [...input.findings.changed, ...input.findings.opportunities],
      mode: options.narrative,
    });
    const post = await postToWebsiteChat({
      projectId: ctx.projectId,
      linkId: ctx.link.id,
      commandId,
      card,
      text: websiteReportChatDigest(card),
      summary: workSummaryOf("monthly"),
      reopen: true,
      now: ctx.now,
    });
    return { result: stepResultOf(post), narrative: status };
  },

  async writePlan(
    ctx: GaReportContext,
    month: string,
  ): Promise<ReportStepResult> {
    const commandId = reportCommandId("plan", ctx.projectId, month);
    if (await websiteReportExists(commandId)) return "exists";

    const input = await loadPlanReportInput(ctx, month);
    const card = buildPlanCard(input);
    // Önerilecek hedef de öne çıkan fırsat da yoksa kart boş olurdu.
    if (
      card.body.variant !== "plan" ||
      (card.body.proposals.length === 0 && card.body.topFindings.length === 0)
    ) {
      return "empty";
    }
    const post = await postToWebsiteChat({
      projectId: ctx.projectId,
      linkId: ctx.link.id,
      commandId,
      card,
      text: websiteReportChatDigest(card),
      summary: workSummaryOf("plan"),
      reopen: true,
      now: ctx.now,
    });
    return stepResultOf(post);
  },
};
