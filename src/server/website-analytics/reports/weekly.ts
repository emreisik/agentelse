import "server-only";

import { buildWeeklyCard } from "@/lib/website-analytics/reports/build";
import { workSummaryOf } from "@/lib/website-analytics/reports/copy";
import {
  reportCommandId,
  reportScopeKey,
} from "@/lib/website-analytics/reports/ids";
import { websiteReportChatDigest } from "@/lib/website-analytics/reports/text";
import type {
  NarrativeMode,
  ReportWriteResult,
} from "@/lib/website-analytics/reports/types";
import { ReasoningService } from "@/server/reasoning/reasoning-service";

import { loadWeeklyReportInput, type GaReportContext } from "./inputs";
import { narrateCard } from "./narrative";
import {
  postToWebsiteChat,
  stepResultOf,
  websiteReportExists,
} from "./website-chat";

// GA-F5 haftalık rapor (docs/website-reports.md "Haftalık rapor"): önceki ISO
// haftası (mülk günleri), yalnız ambardan; Google çağrısı yok. Kimlik sabit
// (`garep_weekly_<proje>_<Pazartesi>`): yazılmış rapor bir daha kurulmaz ve
// LLM'e gidilmez. Kart yazıldıktan sonra değişmez.

export const GaWeeklyReport = {
  async write(
    ctx: GaReportContext,
    week: { monday: string; sunday: string },
    insights: "on" | "pending" | "off",
    options: { narrative: NarrativeMode },
  ): Promise<ReportWriteResult> {
    // GA-F8: ek mülkün kartı `<proje>_s_<bağ>` kapsamıyla ayrı kimlik alır.
    const commandId = reportCommandId(
      "weekly",
      reportScopeKey(ctx.projectId, ctx.link),
      week.monday,
    );
    if (await websiteReportExists(commandId)) {
      return { result: "exists", narrative: null };
    }
    // LLM bütçesi bittiyse ambar bile yüklenmeden ertelenir.
    const llmNeeded = !ctx.link.isMock && !ReasoningService.isMockMode();
    if (options.narrative === "defer" && llmNeeded) {
      return { result: "deferred", narrative: null };
    }

    const input = await loadWeeklyReportInput(ctx, week, insights);
    if (
      input.current.totals.sessions === 0 &&
      input.previous.totals.sessions === 0
    ) {
      return { result: "empty", narrative: null };
    }
    const built = buildWeeklyCard(input);
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
      summary: workSummaryOf("weekly"),
      reopen: true,
      now: ctx.now,
    });
    return { result: stepResultOf(post), narrative: status };
  },
};
