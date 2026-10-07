import "server-only";

import { randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  SeoActionFlags,
  seoActionsAllowedFor,
  seoActionsRestrictedProjects,
} from "@/lib/seo/action-flags";
import {
  decideAlert,
  decideCwv,
  decideLaunch,
  decideOutcome,
  decideSitemap,
  didMetricFor,
  differenceInDifferences,
  selectControls,
  windowTotals,
} from "@/lib/seo/actions/did";
import { EVAL_GIVE_UP_DAYS, EVAL_RETRY_MS } from "@/lib/seo/actions/lifecycle";
import type {
  DidMetric,
  EvaluationReason,
  MetricWindow,
  SeoActionView,
  SeoEvaluation,
  SeoOutcome,
} from "@/lib/seo/actions/types";
import {
  MIN_POST_WEEKS,
  MIN_PRE_WEEKS,
  evaluationWindows,
  queryBounds,
  rankingUpdatesOverlapping,
  windowReady,
  yearAgoWeeks,
  type EvaluationWindows,
} from "@/lib/seo/actions/windows";
import { priorCurve, type CtrCurve } from "@/lib/seo/ctr-curve";
import { addDays, dayKeyToDate } from "@/lib/seo/dates";
import { cwvEnabled, seoMockMode } from "@/lib/seo/health-flags";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { sitemapSummaryOk } from "@/server/seo/crawl/sitemaps";
import {
  readGscSitemaps,
  readInspectionsFor,
} from "@/server/seo/health/google-reads";
import { readSeoCurves } from "@/server/seo/opportunities/state";
import { parseSitemapSummaries } from "@/server/seo/site/sites";

import { SeoLearnings } from "./learnings";
import { loadActionSeries } from "./series";
import { actionViewOf, claimAction, releaseAction } from "./store";

// Eylem değerlendirici (docs/search-actions.md "Değerlendirme"): EVALUATING
// durumundaki eylemi, ölçüm çapasından (SeoAction.measureFrom) kurulan PT
// haftalık pencerelerle sonuçlandırır. Google'a gitmez; ambar ve kendi
// tablolarımızı okur. Sonuç metni şablondur, sayılar yalnız evaluation'da
// kalır. runDue hiçbir koşulda fırlatmaz.

const DAY_MS = 86_400_000;
const WAIT_FETCH_LIMIT_FACTOR = 3;
// CrUX p75 sonrası ölçüsü: eylemden en az 28 gün sonra biten dönem.
const CRUX_PERIOD_DAYS = 28;

export type EvaluateRunResult = {
  status: "evaluated" | "waiting" | "busy" | "skipped";
  outcome: SeoOutcome | null;
};

type Computed = { kind: "done"; evaluation: SeoEvaluation } | { kind: "wait" };

type EvaluationFields = Pick<SeoEvaluation, "method" | "outcome"> &
  Partial<SeoEvaluation>;

function evaluationOf(now: Date, fields: EvaluationFields): SeoEvaluation {
  return {
    v: 1,
    metric: null,
    anchorDay: null,
    preWeeks: [],
    postWeeks: [],
    effect: null,
    low: null,
    high: null,
    controls: 0,
    yoyAdjusted: false,
    treated: null,
    control: null,
    yoy: null,
    updates: [],
    truncated: false,
    cwv: null,
    sitemap: null,
    reason: null,
    confidence: "DIRECTIONAL",
    evaluatedAt: now.toISOString(),
    ...fields,
  };
}

function done(evaluation: SeoEvaluation): Computed {
  return { kind: "done", evaluation };
}

function inconclusive(
  now: Date,
  reason: EvaluationReason,
  fields: Partial<SeoEvaluation> = {},
): Computed {
  return done(
    evaluationOf(now, {
      method: "NONE",
      ...fields,
      outcome: "INCONCLUSIVE",
      confidence: "DIRECTIONAL",
      reason,
    }),
  );
}

type Readiness = "no_link" | "wait" | "give_up" | "ready";

// Ambarın pencerenin son haftasına ulaşıp ulaşmadığı; evaluateAfter'dan 21
// gün sonra hâlâ ulaşmadıysa vazgeçilir.
async function readiness(
  action: SeoActionView,
  windows: EvaluationWindows,
  now: Date,
): Promise<Readiness> {
  if (!action.linkId) return "no_link";
  const link = await prisma.gscSiteLink.findUnique({
    where: { id: action.linkId },
    select: { lastWeeklyWeek: true },
  });
  if (!link) return "no_link";
  if (windowReady(windows, link.lastWeeklyWeek)) return "ready";
  const base = action.evaluateAfter ?? now;
  const giveUpAt = base.getTime() + EVAL_GIVE_UP_DAYS * DAY_MS;
  return now.getTime() >= giveUpAt ? "give_up" : "wait";
}

async function readCurve(projectId: string): Promise<CtrCurve> {
  try {
    const curves = await readSeoCurves(projectId);
    if (curves) return curves.nonBrand;
  } catch {
    // Eğri okunamazsa kamuya açık öncül eğri kullanılır.
  }
  return priorCurve("non-brand");
}

function publicUpdate(update: {
  name: string;
  kind: string;
  startedAt: Date;
  endedAt: Date | null;
}): SeoEvaluation["updates"][number] {
  return {
    name: update.name,
    kind: update.kind,
    startedAt: update.startedAt.toISOString(),
    endedAt: update.endedAt ? update.endedAt.toISOString() : null,
  };
}

async function overlappingUpdates(
  windows: EvaluationWindows,
  now: Date,
): Promise<SeoEvaluation["updates"]> {
  const bounds = queryBounds(windows.overlapFrom, windows.overlapTo);
  const rows = await prisma.searchUpdate.findMany({
    where: {
      startedAt: { lt: bounds.lt },
      OR: [{ endedAt: null }, { endedAt: { gte: bounds.gte } }],
    },
    select: { name: true, kind: true, startedAt: true, endedAt: true },
    orderBy: { startedAt: "asc" },
    take: 50,
  });
  return rankingUpdatesOverlapping(rows, windows, now).map(publicUpdate);
}

// --- Uyarı, CWV ve site haritası ---

type CwvMetric = "lcp" | "inp" | "cls";

async function cwvNumbers(
  action: SeoActionView,
  windows: EvaluationWindows,
): Promise<{ metric: CwvMetric; before: number | null; after: number | null }> {
  const proposal = action.proposal;
  const metric: CwvMetric =
    proposal.kind === "CWV_FIX" && proposal.metric ? proposal.metric : "lcp";
  const formFactor =
    proposal.kind === "CWV_FIX" && proposal.formFactor
      ? proposal.formFactor
      : "PHONE";
  const empty = { metric, before: null, after: null };
  if (!cwvEnabled()) return empty;
  const site = await prisma.seoSite.findUnique({
    where: {
      projectId_isMock: { projectId: action.projectId, isMock: action.isMock },
    },
    select: { id: true },
  });
  if (!site) return empty;
  const rows = await prisma.seoCwv.findMany({
    where: { siteId: site.id, scope: "ORIGIN", formFactor },
    orderBy: { periodEnd: "desc" },
    select: { periodEnd: true, lcpP75: true, inpP75: true, clsP75: true },
    take: 60,
  });
  const valueOf = (row: (typeof rows)[number]): number | null =>
    metric === "lcp" ? row.lcpP75 : metric === "inp" ? row.inpP75 : row.clsP75;
  const anchor = dayKeyToDate(windows.anchorDay);
  // Önce: çapadan önce biten en yeni dönem; sonra: çapadan ≥ 28 gün sonra
  // biten en yeni dönem (28 günlük kayan p75 değişikliği tam yansıtsın).
  const afterFrom = dayKeyToDate(addDays(windows.anchorDay, CRUX_PERIOD_DAYS));
  const before = rows.find((row) => row.periodEnd <= anchor);
  const after = rows.find((row) => row.periodEnd >= afterFrom);
  return {
    metric,
    before: before ? valueOf(before) : null,
    after: after ? valueOf(after) : null,
  };
}

async function sitemapNumbers(
  action: SeoActionView,
): Promise<{ ownOk: boolean; errors: number | null }> {
  const site = await prisma.seoSite.findUnique({
    where: {
      projectId_isMock: { projectId: action.projectId, isMock: action.isMock },
    },
    select: { sitemaps: true },
  });
  const summaries = parseSitemapSummaries(site?.sitemaps ?? null);
  const ownOk = summaries.length > 0 && summaries.every(sitemapSummaryOk);
  const gsc = await readGscSitemaps(action.projectId);
  return {
    ownOk,
    errors:
      gsc.length > 0 ? gsc.reduce((sum, row) => sum + row.errors, 0) : null,
  };
}

async function evaluateAlert(
  action: SeoActionView,
  windows: EvaluationWindows,
  alert: { dedupeKey: string },
  now: Date,
): Promise<Computed> {
  const row = await prisma.adsAlert.findUnique({
    where: {
      projectId_dedupeKey: {
        projectId: action.projectId,
        dedupeKey: alert.dedupeKey,
      },
    },
    select: { status: true },
  });
  const decision = decideAlert(row?.status ?? null);
  let cwv: SeoEvaluation["cwv"] = null;
  let sitemap: SeoEvaluation["sitemap"] = null;
  try {
    if (action.kind === "CWV_FIX") {
      const numbers = await cwvNumbers(action, windows);
      cwv = {
        metric: numbers.metric,
        before: numbers.before,
        after: numbers.after,
      };
    } else if (action.kind === "SITEMAP_FIX") {
      const numbers = await sitemapNumbers(action);
      sitemap = {
        errorsBefore: null,
        errorsAfter: numbers.errors,
        ownOk: numbers.ownOk,
      };
    }
  } catch {
    // Ek sayılar okunamazsa karar uyarı durumundan yine verilir.
  }
  return done(
    evaluationOf(now, {
      method: "ALERT",
      metric: "alert",
      anchorDay: windows.anchorDay,
      outcome: decision.outcome,
      reason: decision.reason,
      cwv,
      sitemap,
    }),
  );
}

async function evaluateCrux(
  action: SeoActionView,
  windows: EvaluationWindows,
  now: Date,
): Promise<Computed> {
  const numbers = await cwvNumbers(action, windows);
  const decision = decideCwv({ before: numbers.before, after: numbers.after });
  return done(
    evaluationOf(now, {
      method: "CRUX",
      metric: "cwv",
      anchorDay: windows.anchorDay,
      outcome: decision.outcome,
      reason: decision.reason,
      cwv: {
        metric: numbers.metric,
        before: numbers.before,
        after: numbers.after,
      },
    }),
  );
}

async function evaluateSitemap(
  action: SeoActionView,
  windows: EvaluationWindows,
  now: Date,
): Promise<Computed> {
  const numbers = await sitemapNumbers(action);
  const decision = decideSitemap({
    ownOk: numbers.ownOk,
    gscErrors: numbers.errors,
  });
  return done(
    evaluationOf(now, {
      method: "SITEMAP",
      metric: "sitemap_errors",
      anchorDay: windows.anchorDay,
      outcome: decision.outcome,
      reason: decision.reason,
      sitemap: {
        errorsBefore: null,
        errorsAfter: numbers.errors,
        ownOk: numbers.ownOk,
      },
    }),
  );
}

// --- Arama verisi tabanlı değerlendirmeler ---

// Pencere ve kapsama kontrolünden sonra kullanılabilir haftalar.
function usableWeeks(
  windows: EvaluationWindows,
  covered: ReadonlySet<string>,
): { pre: string[]; post: string[] } {
  return {
    pre: windows.preWeeks.filter((week) => covered.has(week)),
    post: windows.postWeeks.filter((week) => covered.has(week)),
  };
}

async function indexedVerdict(action: SeoActionView): Promise<boolean | null> {
  if (!action.targetUrlHash) return null;
  try {
    const rows = await readInspectionsFor(action.projectId, [
      action.targetUrlHash,
    ]);
    const verdict = rows.get(action.targetUrlHash)?.verdict ?? null;
    if (verdict === "PASS") return true;
    if (verdict === "FAIL" || verdict === "NEUTRAL") return false;
  } catch {
    // Denetim kaydı okunamazsa dizinlenme bilinmiyor sayılır.
  }
  return null;
}

async function evaluateLaunch(
  action: SeoActionView,
  windows: EvaluationWindows,
  now: Date,
): Promise<Computed> {
  const base = { anchorDay: windows.anchorDay, metric: "impressions" as const };
  if (!action.targetUrl && !action.pageId) {
    return inconclusive(now, "NO_PAGE", { ...base, method: "LAUNCH" });
  }
  const state = await readiness(action, windows, now);
  if (state === "no_link") {
    return inconclusive(now, "NO_SEARCH_DATA", base);
  }
  if (state === "wait") return { kind: "wait" };
  if (state === "give_up") return inconclusive(now, "NO_DATA", base);

  const loaded = await loadActionSeries({
    action,
    windows,
    metric: "impressions",
    treatedOnly: true,
  });
  const curve = priorCurve("non-brand");
  const indexed = await indexedVerdict(action);
  if ("missing" in loaded) {
    if (loaded.missing === "NO_LINK") {
      return inconclusive(now, "NO_SEARCH_DATA", base);
    }
    // Sayfa ambarda hiç görünmedi: sıfır gösterim.
    const decision = decideLaunch({ indexed, impressions: 0, clicks: 0 });
    return done(
      evaluationOf(now, {
        method: "LAUNCH",
        ...base,
        postWeeks: windows.postWeeks,
        outcome: decision.outcome,
        reason: decision.reason,
      }),
    );
  }
  const weeks = usableWeeks(windows, loaded.coveredWeeks);
  if (weeks.post.length < MIN_POST_WEEKS) {
    return inconclusive(now, "NO_DATA", {
      ...base,
      method: "LAUNCH",
      postWeeks: weeks.post,
      truncated: loaded.truncated,
    });
  }
  const before = windowTotals(loaded.treated, weeks.pre, curve);
  const after = windowTotals(loaded.treated, weeks.post, curve);
  const decision = decideLaunch({
    indexed,
    impressions: after.impressions,
    clicks: after.clicks,
  });
  return done(
    evaluationOf(now, {
      method: "LAUNCH",
      ...base,
      preWeeks: weeks.pre,
      postWeeks: weeks.post,
      treated: { before, after },
      truncated: loaded.truncated,
      outcome: decision.outcome,
      reason: decision.reason,
    }),
  );
}

function yearOverYear(
  after: MetricWindow,
  yearAgoClicks: number,
): number | null {
  return yearAgoClicks > 0 ? after.clicks / yearAgoClicks - 1 : null;
}

async function evaluateDid(
  action: SeoActionView,
  windows: EvaluationWindows,
  metric: DidMetric,
  now: Date,
): Promise<Computed> {
  const base = { anchorDay: windows.anchorDay, metric };
  const state = await readiness(action, windows, now);
  if (state === "no_link") return inconclusive(now, "NO_SEARCH_DATA", base);
  if (state === "wait") return { kind: "wait" };
  if (state === "give_up") {
    return inconclusive(now, "NO_DATA", {
      ...base,
      preWeeks: windows.preWeeks,
      postWeeks: windows.postWeeks,
    });
  }

  const loaded = await loadActionSeries({ action, windows, metric });
  if ("missing" in loaded) {
    return inconclusive(
      now,
      loaded.missing === "NO_LINK" ? "NO_SEARCH_DATA" : "NO_PAGE",
      base,
    );
  }
  const weeks = usableWeeks(windows, loaded.coveredWeeks);
  if (weeks.pre.length < MIN_PRE_WEEKS || weeks.post.length < MIN_POST_WEEKS) {
    return inconclusive(now, "NO_DATA", {
      ...base,
      preWeeks: weeks.pre,
      postWeeks: weeks.post,
      truncated: loaded.truncated,
    });
  }

  const curve = await readCurve(action.projectId);
  const selection = selectControls({
    treated: loaded.treated,
    candidates: loaded.candidates,
    excluded: loaded.excluded,
    preWeeks: weeks.pre,
    metric,
  });
  const result = differenceInDifferences({
    treated: loaded.treated,
    controls: selection.controls,
    method: selection.method,
    preWeeks: weeks.pre,
    postWeeks: weeks.post,
    metric,
    curve,
    seed: action.id,
    ...(selection.method === "PRE_POST" && loaded.yearAgoCovered
      ? { yearAgo: loaded.treatedYearAgo }
      : {}),
  });

  const treated = {
    before: windowTotals(loaded.treated, weeks.pre, curve),
    after: windowTotals(loaded.treated, weeks.post, curve),
  };
  const control =
    selection.controls.length > 0
      ? {
          before: windowTotals(selection.controls, weeks.pre, curve),
          after: windowTotals(selection.controls, weeks.post, curve),
        }
      : null;
  // Geçen yıla göre bağlam; DID ve DID_SITE kararını vermez.
  const yoy = loaded.yearAgoCovered
    ? yearOverYear(
        treated.after,
        windowTotals(loaded.treatedYearAgo, yearAgoWeeks(weeks.post), curve)
          .clicks,
      )
    : null;

  const updates = await overlappingUpdates(windows, now);
  const decision = decideOutcome({
    result,
    method: selection.method,
    metric,
    preClicks: treated.before.clicks,
    preImpressions: treated.before.impressions,
    overlap: updates.length > 0,
    overlappingChange: loaded.overlappingChange,
    truncated: loaded.truncated,
  });
  return done(
    evaluationOf(now, {
      method: selection.method,
      ...base,
      preWeeks: weeks.pre,
      postWeeks: weeks.post,
      effect: result ? result.effect : null,
      low: result ? result.low : null,
      high: result ? result.high : null,
      controls: selection.controls.length,
      yoyAdjusted: result ? result.yoyAdjusted : false,
      treated,
      control,
      yoy,
      updates,
      truncated: loaded.truncated,
      outcome: decision.outcome,
      confidence: decision.confidence,
      reason: decision.reason,
    }),
  );
}

async function compute(action: SeoActionView, now: Date): Promise<Computed> {
  const anchor = action.measureFrom ?? action.appliedAt ?? action.verifiedAt;
  if (!action.measureFrom) {
    // Ölçüm çapası olmayan eski satır: uygulama anına düşülür.
    console.warn(`[seo-actions] measureFrom missing: ${action.id}`);
  }
  if (!anchor) return inconclusive(now, "NO_DATA");
  const windows = evaluationWindows({
    measureFrom: anchor,
    windowDays: action.windowDays,
  });

  const alert = action.proposal.alert;
  if (alert) return evaluateAlert(action, windows, alert, now);
  if (action.kind === "CWV_FIX") return evaluateCrux(action, windows, now);
  if (action.kind === "SITEMAP_FIX") {
    return evaluateSitemap(action, windows, now);
  }
  if (action.kind === "NEW_CONTENT" || action.kind === "LOCALIZE") {
    return evaluateLaunch(action, windows, now);
  }
  const metric = didMetricFor(action.kind);
  if (!metric) return inconclusive(now, "NO_DATA");
  // Arama verisi gerektiren türler bağsız ölçülemez.
  if (!action.linkId) {
    return inconclusive(now, "NO_SEARCH_DATA", {
      metric,
      anchorDay: windows.anchorDay,
    });
  }
  return evaluateDid(action, windows, metric, now);
}

// --- Yazma yan etkileri ---

async function markFindingEvaluated(
  action: SeoActionView,
  outcome: SeoOutcome,
  now: Date,
): Promise<void> {
  if (!action.findingId) return;
  try {
    // Yalnız DONE'dan: kullanıcı geri aldıysa ya da bulgu başka yoldan
    // sonuçlandıysa dokunulmaz.
    await prisma.seoFinding.updateMany({
      where: {
        id: action.findingId,
        projectId: action.projectId,
        status: "DONE",
      },
      data: { status: "EVALUATED", outcome, evaluatedAt: now },
    });
  } catch {
    console.warn(`[seo-actions] finding sync failed: ${action.id}`);
  }
}

async function recordEvaluation(
  action: SeoActionView,
  evaluation: SeoEvaluation,
): Promise<void> {
  try {
    await AuditLogRepository.record({
      workspaceId: action.workspaceId,
      projectId: action.projectId,
      actorType: "SYSTEM",
      action: "seo_action.evaluated",
      entityType: "SeoAction",
      entityId: action.id,
      metadata: {
        kind: action.kind,
        outcome: evaluation.outcome,
        method: evaluation.method,
      },
    });
  } catch {
    console.warn(`[seo-actions] audit failed: ${action.id}`);
  }
}

export const SeoActionEvaluator = {
  // Tick adımı: vadesi gelen EVALUATING eylemleri; kapalıyken veritabanına
  // gitmez.
  async runDue(limit = 10, now: Date = new Date()): Promise<number> {
    if (!SeoActionFlags.loop()) return 0;
    const restricted = seoActionsRestrictedProjects();
    if (restricted && restricted.length === 0) return 0;
    const rows = await prisma.seoAction.findMany({
      where: {
        status: "EVALUATING",
        isMock: seoMockMode(),
        evaluateAfter: { lte: now },
        AND: [
          { OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: now } }] },
          { OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
        ],
        ...(restricted ? { projectId: { in: restricted } } : {}),
      },
      orderBy: { evaluateAfter: "asc" },
      take: limit * WAIT_FETCH_LIMIT_FACTOR,
      select: { id: true },
    });
    let evaluated = 0;
    for (const row of rows) {
      if (evaluated >= limit) break;
      try {
        const result = await this.evaluateAction(row.id, { now });
        if (result.status === "evaluated") evaluated += 1;
      } catch {
        console.warn(`[seo-actions] evaluate failed: ${row.id}`);
      }
    }
    return evaluated;
  },

  async evaluateAction(
    actionId: string,
    options: { now?: Date } = {},
  ): Promise<EvaluateRunResult> {
    const now = options.now ?? new Date();
    const skipped: EvaluateRunResult = { status: "skipped", outcome: null };
    if (!SeoActionFlags.loop()) return skipped;
    const row = await prisma.seoAction.findUnique({ where: { id: actionId } });
    if (
      !row ||
      row.status !== "EVALUATING" ||
      row.isMock !== seoMockMode() ||
      !seoActionsAllowedFor(row.projectId)
    ) {
      return skipped;
    }
    // Vadesi gelmemiş eylem beklemede kalır; satıra yazılmaz.
    if (row.evaluateAfter && now.getTime() < row.evaluateAfter.getTime()) {
      return { status: "waiting", outcome: null };
    }
    const owner = randomUUID();
    if (!(await claimAction(actionId, owner, now))) {
      return { status: "busy", outcome: null };
    }
    try {
      // Kilit alınmadan önce başka bir değerlendirici bitirmiş olabilir.
      const fresh = await prisma.seoAction.findUnique({
        where: { id: actionId },
        select: { status: true },
      });
      if (fresh?.status !== "EVALUATING") {
        await releaseAction(actionId, owner, {});
        return skipped;
      }
      const action = actionViewOf(row);
      const computed = await compute(action, now);
      if (computed.kind === "wait") {
        await releaseAction(actionId, owner, {
          nextCheckAt: new Date(now.getTime() + EVAL_RETRY_MS),
        });
        return { status: "waiting", outcome: null };
      }
      const { evaluation } = computed;
      const written = await releaseAction(actionId, owner, {
        status: evaluation.outcome,
        outcome: evaluation.outcome,
        confidence: evaluation.confidence,
        evaluation: evaluation as unknown as Prisma.InputJsonValue,
        evaluatedAt: now,
        openKey: null,
        nextCheckAt: null,
      });
      if (!written) return { status: "busy", outcome: null };
      await markFindingEvaluated(action, evaluation.outcome, now);
      try {
        await SeoLearnings.writeFor(actionId, now);
      } catch {
        console.warn(`[seo-actions] learning failed: ${actionId}`);
      }
      await recordEvaluation(action, evaluation);
      return { status: "evaluated", outcome: evaluation.outcome };
    } catch {
      console.warn(`[seo-actions] evaluate error: ${actionId}`);
      try {
        await releaseAction(actionId, owner, {
          nextCheckAt: new Date(now.getTime() + EVAL_RETRY_MS),
        });
      } catch {
        // Kilit zaten süresiyle düşer.
      }
      return { status: "waiting", outcome: null };
    }
  },
};
