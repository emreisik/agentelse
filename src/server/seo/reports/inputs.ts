import "server-only";

import { Prisma, type GscSiteLink } from "@prisma/client";

import { safeTimezone } from "@/lib/ads/sync-plan";
import { siteLabel } from "@/lib/module-flows/analytics/catalog";
import { pickQuickWins } from "@/lib/module-flows/seo/quick-wins";
import { prisma } from "@/lib/prisma";
import {
  addDays,
  addMonths,
  dateToDayKey,
  daysInRange,
} from "@/lib/seo/dates";
import { SeoFlags, cwvEnabled } from "@/lib/seo/health-flags";
import {
  SeoInsightFlags,
  seoInsightsAllowedFor,
} from "@/lib/seo/insight-flags";
import type {
  DiagnosePair,
  RankedDeltaLike,
  SeoRange,
  SeoReportActions,
  SeoReportContentItem,
  SeoReportHealth,
  SeoReportOpportunity,
  SeoReportUpdate,
  SeoSeverity,
} from "@/lib/seo/reports/types";
import { updatesOverlapping } from "@/lib/seo/search-updates";
import {
  anonymousShare,
  sumGscDays,
  type GscSplit,
  type GscTotals,
} from "@/lib/seo/totals";
import { dayKeyInTimezone, zonedDateTimeToUtc } from "@/lib/timezone";
import { getProjectTimezone } from "@/server/chat/content-plan";
import { SEO_FORMAT_KEY } from "@/server/modules/seo/calendar";
import { brandSplitStatus } from "@/server/seo/brand-terms";
import { listSearchAlerts } from "@/server/seo/health/alerts";
import { readCoverage } from "@/server/seo/health/coverage";
import { readLatestCwv } from "@/server/seo/health/cwv";
import { readSearchHealthScore } from "@/server/seo/health/runner";
import { SearchUpdates } from "@/server/seo/health/updates";
import { listProjectFindings } from "@/server/seo/opportunities/findings-store";
import { ACTION_LABEL, EFFORT_LABEL } from "@/server/seo/opportunities/panel";
import { readQuickWinRows } from "@/server/seo/readers";
import {
  primaryGscLink,
  readGscDays,
  readPeriodCoverage,
  type GscDayRow,
} from "@/server/seo/store";

// SEO raporlarının ortak veri okuyucuları (docs/search-reports.md "Veri
// kaynakları"): Search Console ambarı (SC-F2), arama sağlığı (SC-F3) ve fırsat
// motoru (SC-F4) tablolarını okur. Google'a hiç çağrı yapmaz; yalnız geçerli
// kipin (mock/canlı) bağını ve sitesini görür. Kapılı okuyucular bayrak
// kapalıyken veritabanına dokunmadan null/0 döner.

const DAY_MS = 86_400_000;
const RANKED_DEFAULT_LIMIT = 200;
const RANKED_MAX_LIMIT = 500;
const PAIR_ROW_LIMIT = 500;
const PAIR_QUERY_LIMIT = 20;
const ALERT_SCAN_LIMIT = 50;
const HEALTH_ISSUE_LIMIT = 5;
const OPPORTUNITY_DEFAULT_LIMIT = 5;
const OPPORTUNITY_MAX_LIMIT = 10;
const ACTION_ITEM_LIMIT = 5;
const ACTION_SCAN_LIMIT = 50;
const UPDATE_LIMIT = 5;
const UPDATE_LEAD_DAYS = 3;
// SC-F7: 12 makalelik aylık plan özette eksiksiz görünsün diye 10 iken 12.
const CONTENT_LIMIT = 12;
const LATEST_WEEKS_WINDOW = 12;

// Rapora giren güncelleme ve olay türleri: sıralamayı etkileyen güncellemeler
// ile SERVING/CRAWLING/INDEXING olayları (DISCOVER ve OTHER dışarıda).
const REPORT_UPDATE_KINDS: ReadonlySet<string> = new Set([
  "CORE",
  "SPAM",
  "HELPFUL_CONTENT",
  "REVIEWS",
  "OTHER_RANKING",
  "SERVING",
  "CRAWLING",
  "INDEXING",
]);

const SEVERITY_RANK: Readonly<Record<SeoSeverity, number>> = {
  CRITICAL: 3,
  WARN: 2,
  INFO: 1,
};

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)));
}

// ---------------------------------------------------------------------------
// Rapor bağlamı
// ---------------------------------------------------------------------------

export type ReportLinkContext = {
  link: GscSiteLink;
  projectId: string;
  workspaceId: string;
  brandId: string;
  language: string;
  timezone: string;
  finalThrough: string;
  brandSplitReady: boolean;
  siteLabel: string;
};

// Kesinleşmiş gün ya da varsayılan marka yoksa rapor yazılamaz (null). Dil,
// ReasoningService ile aynı geri dönüşü kullanır (project.language || "tr").
export async function reportContextForLink(
  link: GscSiteLink,
): Promise<ReportLinkContext | null> {
  if (!link.lastFinalDate) return null;
  const project = await prisma.project.findUnique({
    where: { id: link.projectId },
    select: {
      language: true,
      brands: {
        where: { isDefault: true },
        select: { id: true },
        take: 1,
      },
    },
  });
  const brandId = project?.brands[0]?.id;
  if (!project || !brandId) return null;
  const timezone = safeTimezone(
    (await getProjectTimezone(link.projectId).catch(() => null)) ?? "UTC",
  );
  return {
    link,
    projectId: link.projectId,
    workspaceId: link.workspaceId,
    brandId,
    language: project.language || "tr",
    timezone,
    finalThrough: link.lastFinalDate,
    brandSplitReady: brandSplitStatus(link) === "ready",
    siteLabel: siteLabel(link.siteUrl),
  };
}

export async function reportContextFor(
  projectId: string,
): Promise<ReportLinkContext | null> {
  const link = await primaryGscLink(projectId);
  return link ? reportContextForLink(link) : null;
}

// ---------------------------------------------------------------------------
// Ambar okuyucuları
// ---------------------------------------------------------------------------

export type FinalWindow = {
  days: GscDayRow[];
  complete: boolean;
  split: GscSplit;
  missingDays: number;
  freshDays: number;
};

// Web günleri. Toplam yalnız kesinleşmiş günlerden kurulur; "tam" demek her
// günün ambarda olması ve hiçbirinin taze (dataState=all) olmamasıdır.
export async function readFinalWindow(
  linkId: string,
  range: SeoRange,
): Promise<FinalWindow> {
  const days = await readGscDays(linkId, range.from, range.to);
  const finals = days.filter((day) => !day.fresh);
  const missingDays = Math.max(
    0,
    daysInRange(range.from, range.to) - days.length,
  );
  const freshDays = days.length - finals.length;
  return {
    days,
    complete: missingDays === 0 && freshDays === 0,
    split: sumGscDays(finals),
    missingDays,
    freshDays,
  };
}

export type RankedDelta = RankedDeltaLike;

// Boyut × tane tablosu ve sözlük; Prisma.raw yalnız bu sabitlere uygulanır,
// değerlerin hepsi parametredir. Tarih sütunu dönemin başıdır (Pazartesi ya
// da ayın ilk günü), bu yüzden aralıklar dönem başı anahtarlarıdır.
type RankedSource = {
  table: string;
  dateColumn: string;
  dictionary: string;
  idColumn: string;
  labelExpr: string;
  urlExpr: string;
  brandExpr: string;
};

export const RANKED_SOURCES = {
  "query:WEEK": {
    table: "GscWeeklyQuery",
    dateColumn: "weekStart",
    dictionary: "GscQuery",
    idColumn: "queryId",
    labelExpr: 'd."text"',
    urlExpr: "NULL::text",
    brandExpr: 'd."isBrand"',
  },
  "query:MONTH": {
    table: "GscMonthlyQuery",
    dateColumn: "month",
    dictionary: "GscQuery",
    idColumn: "queryId",
    labelExpr: 'd."text"',
    urlExpr: "NULL::text",
    brandExpr: 'd."isBrand"',
  },
  "page:WEEK": {
    table: "GscWeeklyPage",
    dateColumn: "weekStart",
    dictionary: "GscPage",
    idColumn: "pageId",
    labelExpr: 'd."path"',
    urlExpr: 'd."url"',
    brandExpr: "false",
  },
  "page:MONTH": {
    table: "GscMonthlyPage",
    dateColumn: "month",
    dictionary: "GscPage",
    idColumn: "pageId",
    labelExpr: 'd."path"',
    urlExpr: 'd."url"',
    brandExpr: "false",
  },
} as const satisfies Record<string, RankedSource>;

type RankedSqlRow = {
  id: string;
  label: string;
  url: string | null;
  isBrand: boolean;
  firstSeenWeek: Date;
  curClicks: bigint | number | null;
  curImpressions: bigint | number | null;
  curPosition: number | null;
  prevClicks: bigint | number | null;
  prevImpressions: bigint | number | null;
  prevPosition: number | null;
};

function totalsOf(
  clicks: bigint | number | null,
  impressions: bigint | number | null,
  positionWeighted: number | null,
): GscTotals {
  return {
    clicks: Number(clicks ?? 0),
    impressions: Number(impressions ?? 0),
    positionWeighted: Number(positionWeighted ?? 0),
  };
}

// Dönem başına en büyük satırlar (tık ya da gösterimde en büyük olana göre):
// bir önceki dönemde olup bu dönemde hiç görünmeyen satır da sıfır değerle
// gelir. Tek ham SQL.
export async function readRankedDeltas(input: {
  linkId: string;
  dimension: "query" | "page";
  grain: "WEEK" | "MONTH";
  current: SeoRange;
  previous: SeoRange;
  nonBrandOnly?: boolean;
  limit?: number;
}): Promise<RankedDelta[]> {
  const source: RankedSource =
    RANKED_SOURCES[`${input.dimension}:${input.grain}`];
  const limit = clampInt(
    input.limit ?? RANKED_DEFAULT_LIMIT,
    1,
    RANKED_MAX_LIMIT,
  );
  const date = Prisma.raw(`w."${source.dateColumn}"`);
  const inCurrent = Prisma.sql`${date} BETWEEN ${input.current.from}::date AND ${input.current.to}::date`;
  const inPrevious = Prisma.sql`${date} BETWEEN ${input.previous.from}::date AND ${input.previous.to}::date`;
  // Marka ayrımı yalnız sorgu sözlüğünde vardır; sayfalarda süzgeç yoktur.
  const nonBrand =
    input.nonBrandOnly && input.dimension === "query"
      ? Prisma.sql`AND d."isBrand" = false`
      : Prisma.empty;
  const rows = await prisma.$queryRaw<RankedSqlRow[]>`
    SELECT t.* FROM (
      SELECT d."id" AS "id",
             ${Prisma.raw(source.labelExpr)} AS "label",
             ${Prisma.raw(source.urlExpr)} AS "url",
             ${Prisma.raw(source.brandExpr)} AS "isBrand",
             d."firstSeenWeek" AS "firstSeenWeek",
             COALESCE(SUM(w."clicks") FILTER (WHERE ${inCurrent}), 0)::bigint AS "curClicks",
             COALESCE(SUM(w."impressions") FILTER (WHERE ${inCurrent}), 0)::bigint AS "curImpressions",
             COALESCE(SUM(w."positionWeighted") FILTER (WHERE ${inCurrent}), 0)::float8 AS "curPosition",
             COALESCE(SUM(w."clicks") FILTER (WHERE ${inPrevious}), 0)::bigint AS "prevClicks",
             COALESCE(SUM(w."impressions") FILTER (WHERE ${inPrevious}), 0)::bigint AS "prevImpressions",
             COALESCE(SUM(w."positionWeighted") FILTER (WHERE ${inPrevious}), 0)::float8 AS "prevPosition"
        FROM ${Prisma.raw(`"${source.table}"`)} w
        JOIN ${Prisma.raw(`"${source.dictionary}"`)} d
          ON d."id" = w.${Prisma.raw(`"${source.idColumn}"`)}
       WHERE w."linkId" = ${input.linkId}
         AND (${inCurrent} OR ${inPrevious})
         ${nonBrand}
       GROUP BY d."id"
    ) t
    ORDER BY GREATEST(t."curClicks", t."prevClicks") DESC,
             GREATEST(t."curImpressions", t."prevImpressions") DESC,
             t."id" ASC
    LIMIT ${limit}
  `;
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    url: row.url,
    isBrand: row.isBrand,
    firstSeen: dateToDayKey(row.firstSeenWeek),
    current: totalsOf(row.curClicks, row.curImpressions, row.curPosition),
    previous: totalsOf(row.prevClicks, row.prevImpressions, row.prevPosition),
  }));
}

type PairSqlRow = {
  queryId: string;
  pageId: string;
  path: string;
  curClicks: bigint | number | null;
  curImpressions: bigint | number | null;
  curPosition: number | null;
  prevClicks: bigint | number | null;
  prevImpressions: bigint | number | null;
  prevPosition: number | null;
};

// Seçili sorguların (en çok 20) sayfa çiftleri: iki haftalık aralıkta
// (Pazartesi anahtarları) tıklama, gösterim ve konum.
export async function readPairDeltas(input: {
  linkId: string;
  queryIds: readonly string[];
  current: SeoRange;
  previous: SeoRange;
}): Promise<DiagnosePair[]> {
  const queryIds = [...new Set(input.queryIds)].slice(0, PAIR_QUERY_LIMIT);
  if (queryIds.length === 0) return [];
  const inCurrent = Prisma.sql`w."weekStart" BETWEEN ${input.current.from}::date AND ${input.current.to}::date`;
  const inPrevious = Prisma.sql`w."weekStart" BETWEEN ${input.previous.from}::date AND ${input.previous.to}::date`;
  const rows = await prisma.$queryRaw<PairSqlRow[]>`
    SELECT t.* FROM (
      SELECT w."queryId" AS "queryId",
             w."pageId" AS "pageId",
             p."path" AS "path",
             COALESCE(SUM(w."clicks") FILTER (WHERE ${inCurrent}), 0)::bigint AS "curClicks",
             COALESCE(SUM(w."impressions") FILTER (WHERE ${inCurrent}), 0)::bigint AS "curImpressions",
             COALESCE(SUM(w."positionWeighted") FILTER (WHERE ${inCurrent}), 0)::float8 AS "curPosition",
             COALESCE(SUM(w."clicks") FILTER (WHERE ${inPrevious}), 0)::bigint AS "prevClicks",
             COALESCE(SUM(w."impressions") FILTER (WHERE ${inPrevious}), 0)::bigint AS "prevImpressions",
             COALESCE(SUM(w."positionWeighted") FILTER (WHERE ${inPrevious}), 0)::float8 AS "prevPosition"
        FROM "GscWeeklyQueryPage" w
        JOIN "GscPage" p ON p."id" = w."pageId"
       WHERE w."linkId" = ${input.linkId}
         AND w."queryId" IN (${Prisma.join(queryIds)})
         AND (${inCurrent} OR ${inPrevious})
       GROUP BY w."queryId", w."pageId", p."path"
    ) t
    ORDER BY GREATEST(t."curClicks", t."prevClicks") DESC,
             t."queryId" ASC, t."pageId" ASC
    LIMIT ${PAIR_ROW_LIMIT}
  `;
  return rows.map((row) => ({
    queryId: row.queryId,
    pageId: row.pageId,
    path: row.path,
    current: totalsOf(row.curClicks, row.curImpressions, row.curPosition),
    previous: totalsOf(row.prevClicks, row.prevImpressions, row.prevPosition),
  }));
}

// `through` (dahil) tarihine kadar çekilmiş haftalık sorgu özetlerinin
// Pazartesi'leri, yeniden eskiye. Teşhis geri dönüşleri kullanır.
export async function latestFetchedWeeks(
  linkId: string,
  count: number,
  through: string,
): Promise<string[]> {
  const from = addDays(through, -7 * LATEST_WEEKS_WINDOW);
  const coverage = await readPeriodCoverage(
    linkId,
    "WEEK",
    "query",
    from,
    through,
  );
  return [...coverage.periods].reverse().slice(0, Math.max(0, count));
}

// Satırlarda görünmeyen (anonim ya da kırpılmış) tıklamaların payı; dönemin
// özeti hiç çekilmemişse null.
export async function readAnonymousShare(
  linkId: string,
  grain: "WEEK" | "MONTH",
  start: string,
  totalClicks: number,
): Promise<{ share: number | null; truncated: boolean }> {
  const coverage = await readPeriodCoverage(
    linkId,
    grain,
    "query",
    start,
    start,
  );
  if (coverage.periods.length === 0) return { share: null, truncated: false };
  return {
    share: anonymousShare(totalClicks, coverage.rowClicks),
    truncated: coverage.truncated,
  };
}

// ---------------------------------------------------------------------------
// Arama sağlığı (SC-F3)
// ---------------------------------------------------------------------------

// Uyarıların önem ve son görülme sırası (CRITICAL önce, sonra en yeni).
function rankAlerts<T extends { severity: SeoSeverity; lastSeenAt: Date }>(
  alerts: readonly T[],
): T[] {
  return [...alerts].sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      b.lastSeenAt.getTime() - a.lastSeenAt.getTime(),
  );
}

// SEO_HEALTH kapalıyken veritabanına dokunmadan null. Puan, açık uyarı ve
// kapsam tahmininin hiçbiri yoksa da null (boş bir bölüm yazılmaz).
export async function readHealthSummary(
  projectId: string,
): Promise<SeoReportHealth | null> {
  if (!SeoFlags.health()) return null;
  const [score, alerts, coverage, cwv] = await Promise.all([
    readSearchHealthScore(projectId),
    listSearchAlerts(projectId, ALERT_SCAN_LIMIT),
    readCoverage(projectId),
    cwvEnabled() ? readLatestCwv(projectId) : Promise.resolve(null),
  ]);
  const current = coverage?.current ?? null;
  if (!score && alerts.length === 0 && !current && !cwv) return null;
  return {
    score: score?.score.value ?? null,
    cappedByCritical: score?.score.cappedByCritical ?? false,
    critical: alerts.filter((alert) => alert.severity === "CRITICAL").length,
    warn: alerts.filter((alert) => alert.severity === "WARN").length,
    issues: rankAlerts(alerts)
      .slice(0, HEALTH_ISSUE_LIMIT)
      .map((alert) => ({ title: alert.title, severity: alert.severity })),
    coverage: current
      ? {
          point: current.point,
          low: current.low,
          high: current.high,
          weekStart: current.weekStart,
        }
      : null,
    cwv: cwv
      ? {
          phone: cwv.phone?.overall ?? null,
          desktop: cwv.desktop?.overall ?? null,
        }
      : null,
  };
}

export async function readOpenSearchAlerts(
  projectId: string,
): Promise<{ kind: string; title: string; severity: SeoSeverity }[] | null> {
  if (!SeoFlags.health()) return null;
  const alerts = await listSearchAlerts(projectId, ALERT_SCAN_LIMIT);
  return alerts.map((alert) => ({
    kind: alert.kind,
    title: alert.title,
    severity: alert.severity,
  }));
}

// `since`'ten beri ilk kez görülen açık CRITICAL GSC/SEO uyarıları. SiteAlerts.
// listOpen ile aynı anlam: durum OPEN/ACKED ve susturulmamış (mutedUntil boş
// ya da geçmiş).
export async function countNewCriticalAlerts(
  projectId: string,
  since: Date,
  now: Date,
): Promise<number> {
  if (!SeoFlags.health()) return 0;
  return prisma.adsAlert.count({
    where: {
      projectId,
      source: { in: ["GSC", "SEO"] },
      severity: "CRITICAL",
      status: { in: ["OPEN", "ACKED"] },
      OR: [{ mutedUntil: null }, { mutedUntil: { lte: now } }],
      firstSeenAt: { gte: since },
    },
  });
}

// ---------------------------------------------------------------------------
// Fırsat motoru (SC-F4)
// ---------------------------------------------------------------------------

function insightsVisible(projectId: string): boolean {
  return SeoInsightFlags.userFacing() && seoInsightsAllowedFor(projectId);
}

// Yalnız SEO_INSIGHTS=on iken (gölge ve kapalıda veritabanına dokunmadan null).
export async function readOpportunities(
  projectId: string,
  limit: number = OPPORTUNITY_DEFAULT_LIMIT,
): Promise<SeoReportOpportunity[] | null> {
  if (!insightsVisible(projectId)) return null;
  const findings = await listProjectFindings(projectId, {
    statuses: ["OPEN", "ACCEPTED"],
    limit: clampInt(limit, 1, OPPORTUNITY_MAX_LIMIT),
  });
  return findings.map((finding) => ({
    id: finding.id,
    title: finding.title,
    action: ACTION_LABEL[finding.actionKind] ?? ACTION_LABEL.INVESTIGATE,
    impactPerMonth:
      finding.impact?.kind === "clicks"
        ? Math.round(finding.impact.perMonth)
        : null,
    reachPerMonth:
      finding.impact?.kind === "reach"
        ? Math.round(finding.impact.impressionsPerMonth)
        : null,
    confidence: finding.confidence === "SIGNIFICANT" ? "Solid" : "Directional",
    effort: EFFORT_LABEL[finding.effort] ?? EFFORT_LABEL.VARIES,
    status: finding.status,
    priority: finding.priority,
  }));
}

// Aralıkta karar verilen (kabul/yapıldı/değerlendirildi) ya da aralıkta
// değerlendirilen bulgular; aralık [from, to). Satır yoksa null.
export async function readActions(
  projectId: string,
  range: { from: Date; to: Date },
): Promise<SeoReportActions | null> {
  if (!insightsVisible(projectId)) return null;
  const link = await primaryGscLink(projectId);
  if (!link) return null;
  const rows = await prisma.seoFinding.findMany({
    where: {
      linkId: link.id,
      shadow: false,
      OR: [
        {
          decidedAt: { gte: range.from, lt: range.to },
          status: { in: ["ACCEPTED", "DONE", "EVALUATED"] },
        },
        { evaluatedAt: { gte: range.from, lt: range.to } },
      ],
    },
    select: {
      title: true,
      status: true,
      outcome: true,
      decidedAt: true,
      evaluatedAt: true,
    },
    orderBy: { updatedAt: "desc" },
    take: ACTION_SCAN_LIMIT,
  });
  if (rows.length === 0) return null;
  const evaluatedIn = (row: (typeof rows)[number]) =>
    row.evaluatedAt !== null &&
    row.evaluatedAt >= range.from &&
    row.evaluatedAt < range.to;
  const decidedIn = (row: (typeof rows)[number]) =>
    row.decidedAt !== null &&
    row.decidedAt >= range.from &&
    row.decidedAt < range.to;
  const evaluated = rows.filter(evaluatedIn);
  const others = rows.filter((row) => !evaluatedIn(row));
  return {
    accepted: rows.filter((row) => row.status === "ACCEPTED" && decidedIn(row))
      .length,
    done: rows.filter((row) => row.status === "DONE" && decidedIn(row)).length,
    evaluated: evaluated.length,
    items: [...evaluated, ...others].slice(0, ACTION_ITEM_LIMIT).map((row) => ({
      title: row.title,
      status: row.status,
      outcome: row.outcome,
    })),
  };
}

// ---------------------------------------------------------------------------
// Google güncellemeleri, içerik planı, hızlı kazanımlar
// ---------------------------------------------------------------------------

// Aralıkla (başlangıçtan 3 gün öncesiyle) örtüşen sıralama güncellemeleri ve
// olaylar; en yeni 5. SEO_HEALTH kapalıyken veritabanına dokunmadan null.
export async function readUpdates(
  range: SeoRange,
  now: Date,
): Promise<SeoReportUpdate[] | null> {
  if (!SeoFlags.health()) return null;
  const from = new Date(
    `${addDays(range.from, -UPDATE_LEAD_DAYS)}T00:00:00.000Z`,
  );
  const to = new Date(`${range.to}T23:59:59.999Z`);
  const lookbackDays = Math.max(
    1,
    Math.ceil((now.getTime() - from.getTime()) / DAY_MS) + 1,
  );
  const recent = await SearchUpdates.recent(now, lookbackDays);
  return updatesOverlapping(recent, from, to, now)
    .filter((update) => REPORT_UPDATE_KINDS.has(update.kind))
    .slice(0, UPDATE_LIMIT)
    .map((update) => ({
      name: update.name,
      kind: update.kind,
      startedAt: update.startedAt.toISOString(),
      endedAt: update.endedAt ? update.endedAt.toISOString() : null,
      url: update.url,
    }));
}

// Projenin saatiyle ay içine planlanmış SEO makaleleri (arşivlenmiş, reddedilmiş
// ve kanaldan çıkarılmış olanlar hariç).
export async function readContentPlan(
  projectId: string,
  monthStart: string,
  timezone: string,
): Promise<SeoReportContentItem[]> {
  const from = zonedDateTimeToUtc(`${monthStart}T00:00`, timezone);
  const to = zonedDateTimeToUtc(`${addMonths(monthStart, 1)}T00:00`, timezone);
  const rows = await prisma.creative.findMany({
    where: {
      projectId,
      formatKey: SEO_FORMAT_KEY,
      status: { notIn: ["ARCHIVED", "REJECTED"] },
      excludedAt: null,
      scheduledFor: { gte: from, lt: to },
    },
    select: {
      title: true,
      status: true,
      scheduledFor: true,
      post: { select: { topic: true } },
    },
    orderBy: { scheduledFor: "asc" },
    take: CONTENT_LIMIT,
  });
  return rows.flatMap((row) => {
    if (!row.scheduledFor) return [];
    return [
      {
        title: row.title ?? row.post?.topic ?? "Untitled article",
        date: dayKeyInTimezone(row.scheduledFor, timezone),
        status: row.status,
      },
    ];
  });
}

// Son 4 tam haftanın markasız sorguları arasından hızlı kazanımlar (W1
// okuyucusu); ambar pencereyi kapsamıyorsa boş.
export async function readQuickWins(
  ctx: ReportLinkContext,
  now: Date,
): Promise<{ query: string; impressions: number; position: number }[]> {
  const rows = await readQuickWinRows({
    projectId: ctx.projectId,
    siteUrl: ctx.link.siteUrl,
    now,
  });
  if (!rows) return [];
  return pickQuickWins(rows).map((win) => ({
    query: win.query,
    impressions: win.impressions,
    position: win.position,
  }));
}
