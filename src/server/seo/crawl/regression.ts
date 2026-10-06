import "server-only";

import {
  CRAWL_PAUSE_MIN_MS,
  REGRESSION_EVERY_MS,
} from "@/lib/seo/audit-constants";
import { prisma } from "@/lib/prisma";
import { appendInspectQueue } from "@/server/seo/site/inspect-queue";
import type { KeyPage } from "@/server/seo/site/key-pages";

import { siteFetch } from "./fetcher";
import { writePageResult } from "./pages";
import { crawlIntervalMs, robotsGate, type SiteRunContext } from "./robots";

// 6 saatlik gerileme bekçisi (docs/search-health.md "Gerileme bekçisi").
// robots.txt'yi önbelleksiz yeniden okumak çağıranın (crawler) işidir;
// burada kilit sayfalar koşulsuz (304'süz) getirilir ve bir REGRESSION
// SeoCrawl altında yazılır. crawlBlocked iken de koşar: ana sayfadan 2xx
// engeli kaldırır. status, fetchError, noindex, canonical ya da title'ı
// değişen sayfa (birincil GSC bağı varsa) P1 inceleme kuyruğuna girer.

export type RegressionResult = {
  fetched: number;
  unknown: number;
  changed: number;
  complete: boolean;
  homepageStatus: number | null;
};

export async function runRegression(
  ctx: SiteRunContext,
  keyPages: readonly KeyPage[],
): Promise<RegressionResult> {
  const outcome: RegressionResult = {
    fetched: 0,
    unknown: 0,
    changed: 0,
    complete: true,
    homepageStatus: null,
  };
  await ctx.guard();
  const crawl = await prisma.seoCrawl.create({
    data: {
      siteId: ctx.site.id,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      kind: "REGRESSION",
      status: "RUNNING",
      startedAt: ctx.now,
      budget: keyPages.length,
      robotsHash: ctx.site.robotsHash,
    },
  });
  const gate = robotsGate(ctx);
  const intervalMs = crawlIntervalMs(ctx);
  let errors = 0;
  let throttled = false;
  // Süresi dolan bir önceki tur kaldığı yerden sürer: bekçi vadesinden sonra
  // getirilmiş kilit sayfalar yeniden istenmez (uzun Crawl-delay'de bile tur
  // biter).
  const dueAt = ctx.site.regressionDueAt;
  const checked = new Set<string>();
  if (dueAt && keyPages.length > 0) {
    const rows = await prisma.seoPage.findMany({
      where: {
        siteId: ctx.site.id,
        urlHash: { in: keyPages.map((page) => page.urlHash) },
        lastCrawledAt: { gte: dueAt },
      },
      select: { urlHash: true },
    });
    for (const row of rows) checked.add(row.urlHash);
  }
  // Tur yarıda istisnayla biterse (kapsam değişti, DB hatası) satır RUNNING
  // kalmasın: FAILED kapatılır, hata çağırana (crawler) geçer.
  try {
    for (const page of keyPages) {
      if (checked.has(page.urlHash)) continue;
      if (ctx.remaining() <= 0) {
        outcome.complete = false;
        break;
      }
      const result = await siteFetch(
        page.url,
        {
          scope: ctx.scope,
          originHost: ctx.originHost,
          accept: "html",
          isAllowed: gate,
          intervalMs,
        },
        ctx.deps,
      );
      if (result.blockedByRobots) {
        outcome.unknown += 1;
        continue;
      }
      outcome.fetched += 1;
      if (result.errorKind) errors += 1;
      const existing = await prisma.seoPage.findUnique({
        where: {
          siteId_urlHash: { siteId: ctx.site.id, urlHash: page.urlHash },
        },
      });
      const written = await writePageResult(ctx, {
        crawlId: crawl.id,
        url: page.url,
        urlHash: page.urlHash,
        result,
        source: "SEED",
        isKeyPage: true,
        isHomepage: page.isHomepage,
        existing,
        // Süren çok turlu tam taramanın "getirildi" işareti bozulmasın
        // (frontier geri yükleme ve markGone ona bakar).
        keepCrawlMarker: true,
      });
      if (page.isHomepage) outcome.homepageStatus = result.status;
      if (written.criticalChanged) {
        outcome.changed += 1;
        if (ctx.linkId) {
          await appendInspectQueue(
            ctx.site.id,
            { url: page.url, urlHash: page.urlHash, by: "watchdog" },
            ctx.now,
          );
        }
      }
      // WAF/oran sınırı: bekçi de kibar davranır, kalan sayfalar sonraki tura.
      if (result.status === 429 || result.status === 503) {
        outcome.complete = false;
        throttled = true;
        break;
      }
    }

    const nextDue = outcome.complete
      ? new Date(ctx.now.getTime() + REGRESSION_EVERY_MS)
      : throttled
        ? new Date(ctx.now.getTime() + CRAWL_PAUSE_MIN_MS)
        : null;
    const homeOk =
      outcome.homepageStatus !== null &&
      outcome.homepageStatus >= 200 &&
      outcome.homepageStatus < 300;
    await ctx.guard();
    await prisma.$transaction([
      prisma.seoCrawl.update({
        where: { id: crawl.id },
        data: {
          status: outcome.complete ? "DONE" : "PARTIAL",
          finishedAt: ctx.now,
          pagesFetched: outcome.fetched,
          errors,
          stats: {
            keyPages: keyPages.length,
            unknown: outcome.unknown,
            changed: outcome.changed,
          },
        },
      }),
      prisma.seoSite.update({
        where: { id: ctx.site.id },
        data: {
          lastRegressionAt: ctx.now,
          // Süresi biten bekçi bir sonraki turda tamamlanır; 429/503'te 30 dk
          // beklenir.
          ...(nextDue ? { regressionDueAt: nextDue } : {}),
          ...(homeOk ? { crawlBlocked: false, crawlThrottles: 0 } : {}),
          ...(outcome.homepageStatus === 403 ? { crawlBlocked: true } : {}),
        },
      }),
    ]);
    if (nextDue) ctx.site.regressionDueAt = nextDue;
    ctx.site.lastRegressionAt = ctx.now;
    if (homeOk) {
      ctx.site.crawlBlocked = false;
      ctx.site.crawlThrottles = 0;
    }
    if (outcome.homepageStatus === 403) ctx.site.crawlBlocked = true;
  } catch (error) {
    await prisma.seoCrawl
      .update({
        where: { id: crawl.id },
        data: {
          status: "FAILED",
          finishedAt: ctx.now,
          pagesFetched: outcome.fetched,
          errors,
        },
      })
      .catch(() => undefined);
    throw error;
  }
  return outcome;
}
