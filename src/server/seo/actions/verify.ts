import "server-only";

import { randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  SeoActionFlags,
  seoActionsAllowedFor,
  seoActionsGlobalWorkAllowedHere,
  seoActionsRestrictedProjects,
} from "@/lib/seo/action-flags";
import {
  ACTIONS_PER_PROJECT_RUN,
  ACTIONS_PER_RUN,
  GOOGLE_RECHECK_MS,
  PAGES_PER_ACTION,
  RECENT_CHANGE_DAYS,
  VERIFY_EVERY_MS,
  VERIFY_RUN_BUDGET_MS,
  googleSchedule,
  needsGoogleStage,
  staleOpenCutoffs,
  verifySchedule,
  verifyTimingFor,
} from "@/lib/seo/actions/lifecycle";
import {
  INSPECTION_ALERT_KINDS,
  type GoogleStage,
  type SeoActionView,
  type SeoVerification,
  type VerificationCheck,
  type VerificationMethod,
} from "@/lib/seo/actions/types";
import {
  googleStageOf,
  verifyAlertResolved,
  verifyConsolidate,
  verifyContentRefresh,
  verifyCruxData,
  verifyInternalLinks,
  verifyLive,
  verifySchema,
  verifySitemaps,
  verifyTechFix,
  verifyTitleMeta,
  type CrawledChange,
  type ObservedPage,
  type VerifyOutcome,
} from "@/lib/seo/actions/verify-checks";
import { crawlUrlHash, normalizeCrawlUrl, pathOf } from "@/lib/seo/crawl-url";
import { GscFlags, gscSyncAllowedFor } from "@/lib/seo/flags";
import { SeoFlags, seoMockMode } from "@/lib/seo/health-flags";
import type { ParsedRobots } from "@/lib/seo/robots-parser";
import { Heartbeat } from "@/server/observability/heartbeat";
import type { SiteFetchDeps } from "@/server/seo/crawl/fetcher";
import { sitemapSummaryOk } from "@/server/seo/crawl/sitemaps";
import {
  readGscSitemaps,
  readInspectionsFor,
} from "@/server/seo/health/google-reads";
import { SeoInspection } from "@/server/seo/health/inspection";
import { keyPagesFor } from "@/server/seo/site/key-pages";
import { parseSitemapSummaries, SeoSites } from "@/server/seo/site/sites";

import { findPublishedPage } from "./discovery";
import {
  checkPage,
  pageCheckSite,
  readCrawledPage,
  robotsAllow,
  type PageCheckResult,
  type PageCheckSite,
} from "./page-check";
import {
  claimAction,
  actionViewOf,
  markFindingDone,
  releaseAction,
  startMeasuring,
} from "./store";

// Günlük doğrulayıcı (docs/search-actions.md "Doğrulama"): `seo-action-verify`
// tick adımı. APPLIED eylemin değişikliğini KENDİ tarayıcımızla görür (sayfa
// kontrolü), uyarı kaynaklı eylemde uyarının çözülüp çözülmediğine bakar,
// gerektiğinde Google'ın yeniden taramasını URL Inspection kuyruğuyla (günlük
// 200 bütçeli, 'watchdog') bekler ve ölçüme geçirir (startMeasuring çapayı
// yazar). Koşu 45 sn bütçelidir: her eylemden ve her getirmeden önce kalan
// süre bakılır, yetişmeyen eylem nextCheckAt'ini korur. runDue asla fırlatmaz.

const HEARTBEAT_KEY = "seo.actions";
const CANDIDATE_FACTOR = 3;
const MIN_START_MS = 5_000;
const DAY_MS = 86_400_000;
const AFFECTED_PAGES_MAX = 5;
const ERROR_RETRY_MS = 3_600_000;

export type VerifyRunResult = {
  status:
    | "verified"
    | "measuring"
    | "pending"
    | "asked"
    | "expired"
    | "detected"
    | "busy"
    | "skipped"
    | "deadline";
  fetches: number;
};

type TwinRobots = Map<string, ParsedRobots | null | "deny">;

type RunOptions = {
  now?: Date;
  deps?: Partial<SiteFetchDeps>;
  remaining?: () => number;
  // runDue koşu başına bir tane paylaşır (eş alan adının robots.txt'i bir kez).
  twinRobots?: TwinRobots;
};

type Ctx = {
  action: SeoActionView;
  owner: string;
  now: Date;
  remaining: () => number;
  deps: Partial<SiteFetchDeps> | undefined;
  twinRobots: TwinRobots;
  fetches: number;
};

type Checked =
  | { kind: "deadline" }
  | {
      kind: "done";
      outcome: VerifyOutcome;
      method: VerificationMethod;
      google: GoogleStage | null;
    };

function report(action: string, error: unknown): void {
  console.error(
    `[seo-action-verify] action ${action} failed:`,
    error instanceof Error ? error.message : error,
  );
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function inMs(now: Date, ms: number): Date {
  return new Date(now.getTime() + ms);
}

function inspectionAvailable(action: SeoActionView): boolean {
  return (
    action.linkId !== null &&
    SeoFlags.health() &&
    GscFlags.sync() &&
    gscSyncAllowedFor(action.projectId)
  );
}

function googleStage(
  state: GoogleStage["state"],
  now: Date,
  patch: Partial<GoogleStage> = {},
): GoogleStage {
  return {
    state,
    requestedAt: null,
    lastCrawlTime: null,
    verdict: null,
    richResultsVerdict: null,
    checkedAt: now.toISOString(),
    ...patch,
  };
}

function fail(reason: NonNullable<SeoVerification["reason"]>): Checked {
  return {
    kind: "done",
    method: "CRAWLER",
    google: null,
    outcome: { verified: false, checks: [], fetchFailed: false, reason },
  };
}

function withReason(outcome: VerifyOutcome): VerifyOutcome {
  if (outcome.verified || outcome.reason) return outcome;
  return {
    ...outcome,
    reason: outcome.fetchFailed ? "FETCH_FAILED" : "NOT_SEEN",
  };
}

// --- süre aşımı ---------------------------------------------------------------

async function sweepExpired(
  now: Date,
  restricted: string[] | null,
  isMock: boolean,
): Promise<number> {
  const { proposedBefore, acceptedBefore } = staleOpenCutoffs(now);
  const scope = {
    isMock,
    ...(restricted ? { projectId: { in: restricted } } : {}),
  };
  const data = { status: "EXPIRED", openKey: null, nextCheckAt: null };
  const proposed = await prisma.seoAction.updateMany({
    where: { ...scope, status: "PROPOSED", updatedAt: { lt: proposedBefore } },
    data,
  });
  // Makalesi takvimde olan kabul edilmiş eylemi doğrulayıcı sürekli yazar
  // (updatedAt hareket eder); onun 90 günü oluşturulma anından sayılır.
  const accepted = await prisma.seoAction.updateMany({
    where: {
      ...scope,
      status: "ACCEPTED",
      OR: [
        {
          updatedAt: { lt: acceptedBefore },
          NOT: {
            kind: { in: ["NEW_CONTENT", "LOCALIZE"] },
            creativeId: { not: null },
          },
        },
        {
          kind: { in: ["NEW_CONTENT", "LOCALIZE"] },
          creativeId: { not: null },
          createdAt: { lt: acceptedBefore },
        },
      ],
    },
    data,
  });
  return proposed.count + accepted.count;
}

// --- sayfa getirme ------------------------------------------------------------

async function fetchOne(
  ctx: Ctx,
  site: PageCheckSite,
  url: string,
): Promise<PageCheckResult | "deadline"> {
  if (ctx.remaining() <= 0) return "deadline";
  ctx.fetches += 1;
  return checkPage(site, url, {
    ...(ctx.deps ? { deps: ctx.deps } : {}),
    now: ctx.now,
    twinRobots: ctx.twinRobots,
  });
}

// Tarayıcının kaydındaki değişim, eylemden en çok 14 gün öncesine kadar sayılır.
async function crawledChangeOf(
  ctx: Ctx,
  site: PageCheckSite,
  target: string,
): Promise<CrawledChange> {
  const read = await readCrawledPage(site.siteId, target);
  if (!read?.crawled.lastChangedAt) {
    return { titleChanged: false, contentChanged: false };
  }
  const appliedAt = ctx.action.appliedAt ?? ctx.now;
  const floor = appliedAt.getTime() - RECENT_CHANGE_DAYS * DAY_MS;
  const recent = read.crawled.lastChangedAt.getTime() >= floor;
  return {
    titleChanged: read.crawled.titleChanged && recent,
    contentChanged: read.crawled.contentChanged && recent,
  };
}

async function checkSinglePage(
  ctx: Ctx,
  site: PageCheckSite,
): Promise<Checked> {
  const { action } = ctx;
  const target = action.targetUrl;
  if (!target) return fail("OUT_OF_SCOPE");
  const proposal = action.proposal;
  const crawled =
    proposal.kind === "TITLE_META" || proposal.kind === "CONTENT_REFRESH"
      ? await crawledChangeOf(ctx, site, target)
      : { titleChanged: false, contentChanged: false };

  // robots sorunu yalnız kurala bakar; sayfayı getirmek gerekmez.
  if (proposal.kind === "TECH_FIX" && proposal.issue === "ROBOTS") {
    return {
      kind: "done",
      method: "CRAWLER",
      google: null,
      outcome: verifyTechFix({
        proposal,
        observed: null,
        robotsAllowed: await robotsAllow(site, target),
      }),
    };
  }

  const res = await fetchOne(ctx, site, target);
  if (res === "deadline") return { kind: "deadline" };

  const robotsAllowed = await robotsAllow(site, target);
  // Robots / kapsam yüzünden getirilemedi: TECH_FIX dışında doğrudan sonuç
  // (kullanıcı onayı önerilir); TECH_FIX robots kuralını kendisi değerlendirir.
  if (
    !res.ok &&
    (res.reason === "ROBOTS" || res.reason === "OUT_OF_SCOPE") &&
    proposal.kind !== "TECH_FIX"
  ) {
    return fail(res.reason);
  }
  const observed: ObservedPage | null = res.page;

  let outcome: VerifyOutcome;
  switch (proposal.kind) {
    case "TITLE_META":
      outcome = verifyTitleMeta({
        proposal,
        baseline: action.baseline,
        observed,
        crawled,
      });
      break;
    case "CONTENT_REFRESH":
      outcome = verifyContentRefresh({
        baseline: action.baseline,
        observed,
        crawled,
      });
      break;
    case "TECH_FIX":
      outcome = verifyTechFix({ proposal, observed, robotsAllowed });
      break;
    case "SCHEMA":
      outcome = verifySchema({ proposal, observed });
      break;
    default:
      outcome = verifyLive({ observed });
  }
  return { kind: "done", method: "CRAWLER", google: null, outcome };
}

async function checkSeveralPages(
  ctx: Ctx,
  site: PageCheckSite,
): Promise<Checked> {
  const { proposal } = ctx.action;
  let urls: string[] = [];
  if (proposal.kind === "INTERNAL_LINKS") {
    urls = [...new Set(proposal.links.map((link) => link.fromUrl))];
  } else if (proposal.kind === "CONSOLIDATE") {
    urls = [...new Set(proposal.from)];
  }
  urls = urls.slice(0, PAGES_PER_ACTION);
  if (urls.length === 0) return fail("OUT_OF_SCOPE");

  const observedByFrom = new Map<string, ObservedPage | null>();
  for (const url of urls) {
    const res = await fetchOne(ctx, site, url);
    if (res === "deadline") return { kind: "deadline" };
    observedByFrom.set(url, res.page);
  }
  const outcome =
    proposal.kind === "INTERNAL_LINKS"
      ? verifyInternalLinks({ proposal, observedByFrom })
      : proposal.kind === "CONSOLIDATE"
        ? verifyConsolidate({ proposal, observedByFrom })
        : verifyLive({ observed: null });
  return { kind: "done", method: "CRAWLER", google: null, outcome };
}

// --- uyarı kaynaklı eylemler --------------------------------------------------

// Google'ın göstermesi gereken uyarılarda (canonical / zengin sonuç) etkilenen
// anahtar sayfaların yeniden incelenmesini ister; yoksa hiçbir şey bir
// yeniden incelemeyi garanti etmez. Sıraya alınan sayı döner; -1: bütçe dolu.
async function reinspectAffected(
  action: SeoActionView,
  now: Date,
): Promise<number> {
  const site = await SeoSites.forProject(action.projectId);
  if (!site) return 0;
  const pages = await keyPagesFor(site, now);
  if (pages.length === 0) return 0;
  const inspections = await readInspectionsFor(
    action.projectId,
    pages.map((page) => page.urlHash),
  );
  const affected = pages
    .filter((page) => {
      const row = inspections.get(page.urlHash);
      if (!row) return false;
      const mismatch =
        row.googleCanonical !== null &&
        row.userCanonical !== null &&
        row.googleCanonical !== row.userCanonical;
      const richErrors =
        row.richResults?.items.some((item) =>
          item.issues.some((issue) => issue.severity === "ERROR"),
        ) ?? false;
      return mismatch || richErrors;
    })
    .slice(0, AFFECTED_PAGES_MAX);
  let queued = 0;
  for (const page of affected) {
    const result = await SeoInspection.requestInspection({
      projectId: action.projectId,
      url: page.url,
      by: "watchdog",
      now,
    });
    if (result === "queued" || result === "already_queued") queued += 1;
    if (result === "full") return queued > 0 ? queued : -1;
  }
  return queued;
}

async function checkAlertAction(ctx: Ctx): Promise<Checked> {
  const { action, now } = ctx;
  const alert = action.proposal.alert;
  if (!alert) return fail("NOT_SEEN");
  const row = await prisma.adsAlert.findUnique({
    where: {
      projectId_dedupeKey: {
        projectId: action.projectId,
        dedupeKey: alert.dedupeKey,
      },
    },
    select: { status: true, resolvedAt: true },
  });
  const outcome = verifyAlertResolved({
    alert: row,
    appliedAt: action.appliedAt ?? now,
  });

  let google = action.verification.google;
  if (
    !outcome.verified &&
    inspectionAvailable(action) &&
    INSPECTION_ALERT_KINDS.includes(alert.kind)
  ) {
    const requestedAt = google?.requestedAt
      ? Date.parse(google.requestedAt)
      : Number.NaN;
    const due =
      Number.isNaN(requestedAt) ||
      now.getTime() - requestedAt >= GOOGLE_RECHECK_MS;
    if (due) {
      const queued = await reinspectAffected(action, now);
      if (queued >= 0) {
        google = googleStage("pending", now, {
          requestedAt: now.toISOString(),
        });
      }
    }
  }
  return { kind: "done", method: "ALERT", google, outcome };
}

// --- uyarısız Core Web Vitals ve sitemap eylemleri ----------------------------

async function checkCwv(ctx: Ctx): Promise<Checked> {
  const { action } = ctx;
  const site = await SeoSites.forProject(action.projectId);
  if (!site) return fail("NO_SITE");
  const latest = await prisma.seoCwv.findFirst({
    where: { siteId: site.id, isMock: seoMockMode() },
    orderBy: { periodEnd: "desc" },
    select: { periodEnd: true },
  });
  return {
    kind: "done",
    method: "CRUX",
    google: null,
    outcome: verifyCruxData({
      latestPeriodEnd: latest?.periodEnd ?? null,
      appliedAt: action.appliedAt ?? ctx.now,
    }),
  };
}

async function checkSitemaps(ctx: Ctx): Promise<Checked> {
  const { action } = ctx;
  const site = await SeoSites.forProject(action.projectId);
  if (!site) return fail("NO_SITE");
  const summaries = parseSitemapSummaries(site.sitemaps);
  const ownOk =
    summaries.length === 0 ? null : summaries.every(sitemapSummaryOk);
  const rows = await readGscSitemaps(action.projectId);
  return {
    kind: "done",
    method: "SITEMAP",
    google: null,
    outcome: verifySitemaps({
      ownOk,
      checkedAt: site.sitemapsCheckedAt,
      appliedAt: action.appliedAt ?? ctx.now,
      gsc:
        rows.length === 0
          ? null
          : rows.map((row) => ({
              errors: row.errors,
              lastDownloaded: row.lastDownloaded,
            })),
    }),
  };
}

async function checkApplied(ctx: Ctx): Promise<Checked> {
  const { action } = ctx;
  if (action.proposal.alert) return checkAlertAction(ctx);
  if (action.kind === "CWV_FIX") return checkCwv(ctx);
  if (action.kind === "SITEMAP_FIX") return checkSitemaps(ctx);

  const site = await pageCheckSite(action.projectId);
  if (!site) return fail("NO_SITE");
  // robots.txt okunamıyorsa hiçbir şey getirilmez; kullanıcı onayı önerilir.
  if (site.robotsFailing) return fail("ROBOTS");
  if (action.kind === "INTERNAL_LINKS" || action.kind === "CONSOLIDATE") {
    return checkSeveralPages(ctx, site);
  }
  return checkSinglePage(ctx, site);
}

// --- sonuçların yazılması -----------------------------------------------------

function verificationAfter(
  ctx: Ctx,
  checked: Extract<Checked, { kind: "done" }>,
  quickRetries: SeoVerification["quickRetries"],
): SeoVerification {
  const { action, now } = ctx;
  const previous = action.verification;
  const { outcome } = checked;
  return {
    ...previous,
    attempts: previous.attempts + 1,
    quickRetries,
    lastCheckedAt: now.toISOString(),
    checks: outcome.checks,
    method: checked.method,
    liveSince: outcome.verified
      ? (previous.liveSince ?? now.toISOString())
      : previous.liveSince,
    google: checked.google ?? previous.google,
    reason: outcome.verified ? null : outcome.reason,
  };
}

async function settleChecked(
  ctx: Ctx,
  checked: Extract<Checked, { kind: "done" }>,
): Promise<VerifyRunResult> {
  const { action, owner, now } = ctx;
  const outcome = withReason(checked.outcome);
  const normalized = { ...checked, outcome };

  if (outcome.verified) {
    const verification = verificationAfter(
      ctx,
      normalized,
      action.verification.quickRetries,
    );
    const fromAlert = action.proposal.alert !== null;
    const googleStep = needsGoogleStage(
      action.kind,
      inspectionAvailable(action) && action.targetUrl !== null,
      fromAlert,
    );
    if (googleStep && action.targetUrl) {
      const requested = await SeoInspection.requestInspection({
        projectId: action.projectId,
        url: action.targetUrl,
        by: "watchdog",
        now,
      });
      if (requested !== "no_link" && requested !== "out_of_scope") {
        // 'full': istek yapılmadı (requestedAt boş), 3 günlük kontrolde yeniden denenir.
        const google = googleStage("pending", now, {
          requestedAt: requested === "full" ? null : now.toISOString(),
        });
        await releaseAction(action.id, owner, {
          status: "VERIFIED",
          verifiedAt: now,
          verification: json({ ...verification, google }),
          verifyAttempts: { increment: 1 },
          nextCheckAt: inMs(now, GOOGLE_RECHECK_MS),
        });
        return { status: "verified", fetches: ctx.fetches };
      }
      verification.google = googleStage("skipped", now);
    }
    const started = await startMeasuring({
      action,
      owner,
      verifiedAt: now,
      method: checked.method,
      verification,
      googleCrawlAt: null,
      now,
    });
    return { status: started ? "measuring" : "skipped", fetches: ctx.fetches };
  }

  const plan = verifySchedule({
    now,
    appliedAt: action.appliedAt ?? action.createdAt,
    askedAt: action.askedAt,
    fetchFailed: outcome.fetchFailed,
    quickRetries: action.verification.quickRetries,
    timing: verifyTimingFor(action.kind, action.proposal.alert?.kind ?? null),
  });
  const verification = verificationAfter(ctx, normalized, plan.quickRetries);
  if (plan.expire) {
    await releaseAction(action.id, owner, {
      status: "EXPIRED",
      openKey: null,
      nextCheckAt: null,
      verification: json(verification),
      verifyAttempts: { increment: 1 },
    });
    return { status: "expired", fetches: ctx.fetches };
  }
  await releaseAction(action.id, owner, {
    verification: json(verification),
    verifyAttempts: { increment: 1 },
    nextCheckAt: plan.nextCheckAt,
    ...(plan.ask ? { askedAt: now } : {}),
  });
  return { status: plan.ask ? "asked" : "pending", fetches: ctx.fetches };
}

// --- VERIFIED: Google'ın yeniden taramasını bekle -----------------------------

async function checkVerified(ctx: Ctx): Promise<VerifyRunResult> {
  const { action, owner, now } = ctx;
  const previous = action.verification;
  const verifiedAt = action.verifiedAt ?? now;
  const method = previous.method ?? "CRAWLER";
  const measure = (
    google: GoogleStage,
    googleCrawlAt: Date | null,
    extraChecks: VerificationCheck[] = [],
  ) =>
    startMeasuring({
      action,
      owner,
      verifiedAt,
      method,
      verification: {
        ...previous,
        lastCheckedAt: now.toISOString(),
        checks: [...previous.checks, ...extraChecks],
        google,
      },
      googleCrawlAt,
      now,
    });

  if (!inspectionAvailable(action) || !action.targetUrlHash) {
    const started = await measure(googleStage("skipped", now), null);
    return { status: started ? "measuring" : "skipped", fetches: 0 };
  }

  const rows = await readInspectionsFor(action.projectId, [
    action.targetUrlHash,
  ]);
  const inspection = rows.get(action.targetUrlHash) ?? null;
  const stage = googleStageOf({
    inspection: inspection
      ? { lastCrawlTime: inspection.lastCrawlTime, verdict: inspection.verdict }
      : null,
    appliedAt: action.appliedAt ?? verifiedAt,
  });

  if (stage === "seen" && inspection) {
    const rich =
      action.kind === "SCHEMA"
        ? (inspection.richResults?.verdict ?? null)
        : null;
    const extra: VerificationCheck[] =
      rich !== null
        ? [
            {
              key: "rich_results",
              label: "Rich results valid in Google",
              ok: rich === "PASS",
              observed: rich,
            },
          ]
        : [];
    const started = await measure(
      googleStage("seen", now, {
        requestedAt: previous.google?.requestedAt ?? null,
        lastCrawlTime: inspection.lastCrawlTime?.toISOString() ?? null,
        verdict: inspection.verdict,
        richResultsVerdict: rich,
      }),
      inspection.lastCrawlTime,
      extra,
    );
    return { status: started ? "measuring" : "skipped", fetches: 0 };
  }

  const requestedAt = previous.google?.requestedAt
    ? new Date(previous.google.requestedAt)
    : null;
  const schedule = googleSchedule({
    now,
    verifiedAt,
    requestedAt:
      requestedAt && !Number.isNaN(requestedAt.getTime()) ? requestedAt : null,
  });
  if (schedule.giveUp) {
    // 21 gün geçti: Google görülmedi; ölçüm doğrulama anından başlar.
    const started = await measure(
      googleStage("not_seen", now, {
        requestedAt: previous.google?.requestedAt ?? null,
      }),
      null,
    );
    return { status: started ? "measuring" : "skipped", fetches: 0 };
  }

  let nextRequestedAt = previous.google?.requestedAt ?? null;
  if (schedule.request && action.targetUrl) {
    const result = await SeoInspection.requestInspection({
      projectId: action.projectId,
      url: action.targetUrl,
      by: "watchdog",
      now,
    });
    if (result === "no_link" || result === "out_of_scope") {
      const started = await measure(googleStage("skipped", now), null);
      return { status: started ? "measuring" : "skipped", fetches: 0 };
    }
    if (result === "queued" || result === "already_queued") {
      nextRequestedAt = now.toISOString();
    }
  }
  await releaseAction(action.id, owner, {
    verification: json({
      ...previous,
      lastCheckedAt: now.toISOString(),
      google: googleStage("pending", now, { requestedAt: nextRequestedAt }),
    }),
    nextCheckAt: schedule.nextCheckAt,
  });
  return { status: "pending", fetches: 0 };
}

// --- makale yayına girdi mi (ACCEPTED + creativeId) ---------------------------

async function detectLive(ctx: Ctx): Promise<VerifyRunResult> {
  const { action, owner, now } = ctx;
  const proposal = action.proposal;
  if (proposal.kind !== "NEW_CONTENT" && proposal.kind !== "LOCALIZE") {
    await releaseAction(action.id, owner, {});
    return { status: "skipped", fetches: 0 };
  }
  const site = await pageCheckSite(action.projectId);
  const later = (): Date => inMs(now, VERIFY_EVERY_MS);
  if (!site) {
    await releaseAction(action.id, owner, { nextCheckAt: later() });
    return { status: "pending", fetches: 0 };
  }

  let found: { url: string; firstSeenAt: Date } | null = null;
  if (proposal.liveUrl) {
    const res = await fetchOne(ctx, site, proposal.liveUrl);
    if (res === "deadline") {
      await releaseAction(action.id, owner, {});
      return { status: "deadline", fetches: ctx.fetches };
    }
    if (res.ok && res.page.status === 200 && !res.page.noindex) {
      found = { url: res.page.url, firstSeenAt: now };
    }
  }
  if (!found) {
    found = await findPublishedPage({
      siteId: site.siteId,
      title: proposal.title,
      primaryKeyword: proposal.primaryKeyword,
      since: action.createdAt,
    });
  }
  if (!found) {
    await releaseAction(action.id, owner, { nextCheckAt: later() });
    return { status: "pending", fetches: ctx.fetches };
  }

  // appliedAt = sayfanın ilk görüldüğü an; ölçüm çapası da buradan başlar.
  const appliedAt =
    found.firstSeenAt.getTime() < now.getTime() ? found.firstSeenAt : now;
  const normalized = normalizeCrawlUrl(found.url);
  const verification: SeoVerification = {
    ...action.verification,
    attempts: action.verification.attempts + 1,
    lastCheckedAt: now.toISOString(),
    checks: [
      {
        key: "found",
        label: "Article found on your site",
        ok: true,
        observed: pathOf(found.url).slice(0, 200),
      },
    ],
    method: "DETECTED",
    liveSince: appliedAt.toISOString(),
    google: null,
    reason: null,
  };
  const targetUrlHash = normalized ? crawlUrlHash(normalized) : null;
  const moved = await prisma.seoAction.updateMany({
    where: { id: action.id, leaseOwner: owner, status: "ACCEPTED" },
    data: {
      status: "APPLIED",
      appliedVia: "DETECTED",
      appliedAt,
      targetUrl: found.url,
      targetUrlHash,
      proposal: json({ ...proposal, liveUrl: found.url }),
      verification: json(verification),
      verifyAttempts: { increment: 1 },
    },
  });
  if (moved.count !== 1) {
    await releaseAction(action.id, owner, {});
    return { status: "skipped", fetches: ctx.fetches };
  }
  // Önce bulgu DONE olur; startMeasuring onun vadesini ancak DONE iken uzatır.
  if (action.findingId) {
    await markFindingDone({
      projectId: action.projectId,
      findingId: action.findingId,
      kindForWindow: action.kind,
      userId: null,
      now,
    });
  }
  const started = await startMeasuring({
    action: {
      ...action,
      status: "APPLIED",
      appliedVia: "DETECTED",
      appliedAt,
      targetUrl: found.url,
      targetUrlHash,
    },
    owner,
    verifiedAt: appliedAt,
    method: "DETECTED",
    verification,
    googleCrawlAt: null,
    now,
  });
  return { status: started ? "detected" : "skipped", fetches: ctx.fetches };
}

// --- tek eylem ----------------------------------------------------------------

async function runClaimed(
  actionId: string,
  owner: string,
  now: Date,
  options: RunOptions,
): Promise<VerifyRunResult> {
  const row = await prisma.seoAction.findUnique({ where: { id: actionId } });
  const skip = async (nextCheckAt?: Date): Promise<VerifyRunResult> => {
    await releaseAction(actionId, owner, nextCheckAt ? { nextCheckAt } : {});
    return { status: "skipped", fetches: 0 };
  };
  if (!row || row.isMock !== seoMockMode()) return skip();
  const action = actionViewOf(row);

  const waitingArticle =
    action.status === "ACCEPTED" &&
    (action.kind === "NEW_CONTENT" || action.kind === "LOCALIZE") &&
    action.creativeId !== null;
  if (
    action.status !== "APPLIED" &&
    action.status !== "VERIFIED" &&
    !waitingArticle
  ) {
    return skip();
  }

  const project = await prisma.project.findUnique({
    where: { id: action.projectId },
    select: { status: true },
  });
  if (
    !project ||
    project.status !== "ACTIVE" ||
    !seoActionsAllowedFor(action.projectId)
  ) {
    return skip(inMs(now, VERIFY_EVERY_MS));
  }

  const ctx: Ctx = {
    action,
    owner,
    now,
    remaining: options.remaining ?? (() => Number.POSITIVE_INFINITY),
    deps: options.deps,
    twinRobots: options.twinRobots ?? new Map(),
    fetches: 0,
  };

  if (waitingArticle) return detectLive(ctx);
  if (action.status === "VERIFIED") return checkVerified(ctx);

  const checked = await checkApplied(ctx);
  if (checked.kind === "deadline") {
    // Süre bitti: nextCheckAt korunur, eylem sıradaki koşuda yeniden alınır.
    await releaseAction(actionId, owner, {});
    return { status: "deadline", fetches: ctx.fetches };
  }
  return settleChecked(ctx, checked);
}

async function runAction(
  actionId: string,
  options: RunOptions = {},
): Promise<VerifyRunResult> {
  const now = options.now ?? new Date();
  const owner = `verify:${randomUUID()}`;
  if (!(await claimAction(actionId, owner, now))) {
    return { status: "busy", fetches: 0 };
  }
  try {
    return await runClaimed(actionId, owner, now, options);
  } catch (error) {
    report(actionId, error);
    try {
      await releaseAction(actionId, owner, {
        nextCheckAt: inMs(now, ERROR_RETRY_MS),
      });
    } catch {
      // Kira zaten süresi dolunca kendiliğinden düşer.
    }
    return { status: "skipped", fetches: 0 };
  }
}

export const SeoActionVerifier = {
  async runDue(
    limit: number = ACTIONS_PER_RUN,
    now: Date = new Date(),
    options: { budgetMs?: number } = {},
  ): Promise<number> {
    if (!SeoActionFlags.loop()) return 0;
    const global = seoActionsGlobalWorkAllowedHere();
    if (global) await Heartbeat.beat(HEARTBEAT_KEY, now);
    const restricted = seoActionsRestrictedProjects();
    if (restricted && restricted.length === 0) {
      if (global) await Heartbeat.ok(HEARTBEAT_KEY, now);
      return 0;
    }
    const isMock = seoMockMode();
    const startedAt = performance.now();
    const budgetMs = options.budgetMs ?? VERIFY_RUN_BUDGET_MS;
    const remaining = () => budgetMs - (performance.now() - startedAt);

    try {
      await sweepExpired(now, restricted, isMock);
    } catch (error) {
      report("expiry sweep", error);
    }

    const candidates = await prisma.seoAction.findMany({
      where: {
        isMock,
        ...(restricted ? { projectId: { in: restricted } } : {}),
        nextCheckAt: { lte: now },
        AND: [
          {
            OR: [
              { status: { in: ["APPLIED", "VERIFIED"] } },
              {
                status: "ACCEPTED",
                kind: { in: ["NEW_CONTENT", "LOCALIZE"] },
                creativeId: { not: null },
              },
            ],
          },
          { OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] },
        ],
      },
      orderBy: { nextCheckAt: "asc" },
      take: limit * CANDIDATE_FACTOR,
      select: { id: true, projectId: true },
    });

    // Adalet: bir proje koşuyu tek başına doldurmaz.
    const perProject = new Map<string, number>();
    const picked: string[] = [];
    for (const candidate of candidates) {
      if (picked.length >= limit) break;
      const used = perProject.get(candidate.projectId) ?? 0;
      if (used >= ACTIONS_PER_PROJECT_RUN) continue;
      perProject.set(candidate.projectId, used + 1);
      picked.push(candidate.id);
    }

    const twinRobots: TwinRobots = new Map();
    let processed = 0;
    for (const id of picked) {
      if (remaining() < MIN_START_MS) break;
      try {
        const result = await runAction(id, { now, remaining, twinRobots });
        if (result.status !== "busy") processed += 1;
      } catch (error) {
        processed += 1;
        report(id, error);
      }
    }
    if (global) await Heartbeat.ok(HEARTBEAT_KEY, now);
    return processed;
  },

  runAction,
};
