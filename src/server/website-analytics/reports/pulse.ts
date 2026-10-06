import "server-only";

import { prisma } from "@/lib/prisma";
import {
  buildAlertCard,
  buildPulseCard,
} from "@/lib/website-analytics/reports/build";
import { workSummaryOf } from "@/lib/website-analytics/reports/copy";
import {
  alertPeriodKey,
  reportCommandId,
} from "@/lib/website-analytics/reports/ids";
import { pulseWorthy } from "@/lib/website-analytics/reports/pulse";
import { websiteReportChatDigest } from "@/lib/website-analytics/reports/text";
import type { ReportStepResult } from "@/lib/website-analytics/reports/types";

import { loadPulseInput, reportLinkInfo, type GaReportContext } from "./inputs";
import { GA_REPORT_RETENTION_DAYS } from "./retention";
import {
  postToWebsiteChat,
  stepResultOf,
  websiteReportExists,
} from "./website-chat";

// GA-F5 günlük nabız ve kritik uyarı kartları (docs/website-reports.md
// "Nabız", "Kritik uyarılar"). İkisi de sabit kimlikli kart olarak
// "Website analytics" sohbetine yazılır; kimlik aynıysa iki kez yazılmaz.
// Nabız şablon metindir (LLM yok) ve yalnız kayda değer bir şey varsa
// gönderilir. Nabız kapalı (arşivlenmiş) sohbeti yeniden açmaz; uyarı kartı
// açar.

// Bir turda en çok bu kadar uyarı kartı (kimlik zaten tekrarı önler).
const MAX_ALERT_CARDS = 5;

export const GaPulse = {
  async write(
    ctx: GaReportContext,
    day: string,
    alertsSince: Date,
  ): Promise<ReportStepResult> {
    const commandId = reportCommandId("pulse", ctx.projectId, day);
    if (await websiteReportExists(commandId)) return "exists";

    const input = await loadPulseInput(ctx, day, alertsSince);
    const card = buildPulseCard(input);
    if (card.body.variant !== "pulse" || !pulseWorthy(card.body)) {
      return "quiet";
    }
    const post = await postToWebsiteChat({
      projectId: ctx.projectId,
      linkId: ctx.link.id,
      commandId,
      card,
      text: websiteReportChatDigest(card),
      summary: workSummaryOf("pulse"),
      reopen: false,
      now: ctx.now,
    });
    return stepResultOf(post);
  },

  // Son taramadan beri açılan ya da KRİTİK'e yükselen GA4 uyarıları. Kimlik
  // önem derecesini taşır: WARN → CRITICAL yükselmesi (firstSeenAt aynı
  // kalır) yeni bir kart yazar. detail ve data hiç okunmaz.
  async postAlertCards(ctx: GaReportContext, since: Date): Promise<number> {
    // Uyarı kartları 95 gün sonra saklamadan silinir; ondan eski bir uyarı
    // açık kalsa bile kart yeniden yazılmaz (silinen kart geri gelmesin,
    // arşivlenmiş sohbet yeniden açılmasın).
    const oldest = new Date(
      ctx.now.getTime() - GA_REPORT_RETENTION_DAYS.alert * 86_400_000,
    );
    const rows = await prisma.adsAlert.findMany({
      where: {
        projectId: ctx.projectId,
        source: "GA4",
        severity: "CRITICAL",
        status: "OPEN",
        firstSeenAt: { gt: oldest },
        OR: [{ firstSeenAt: { gt: since } }, { updatedAt: { gt: since } }],
      },
      select: {
        id: true,
        kind: true,
        title: true,
        severity: true,
        firstSeenAt: true,
      },
      orderBy: { firstSeenAt: "desc" },
      take: MAX_ALERT_CARDS,
    });
    let posted = 0;
    for (const row of rows) {
      const commandId = reportCommandId(
        "alert",
        ctx.projectId,
        alertPeriodKey(row.id, row.firstSeenAt, row.severity),
      );
      if (await websiteReportExists(commandId)) continue;
      const card = buildAlertCard({
        link: reportLinkInfo(ctx),
        builtAt: ctx.now.toISOString(),
        websitePage: ctx.websitePage,
        alert: {
          id: row.id,
          kind: row.kind,
          title: row.title,
          firstSeenAt: row.firstSeenAt.toISOString(),
        },
      });
      const post = await postToWebsiteChat({
        projectId: ctx.projectId,
        linkId: ctx.link.id,
        commandId,
        card,
        text: websiteReportChatDigest(card),
        summary: workSummaryOf("alert"),
        reopen: true,
        now: ctx.now,
      });
      if (post === "posted") posted += 1;
      // Bağ ya da proje gitti: kalan kartlar da yazılamaz.
      if (post === "gone" || post === "no_project") break;
    }
    return posted;
  },
};
