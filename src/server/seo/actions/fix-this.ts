import "server-only";

import { after } from "next/server";

import { prisma } from "@/lib/prisma";
import { SeoActionFlags, seoActionsAllowedFor } from "@/lib/seo/action-flags";
import { ACTION_STATUS_LABEL, actionTitle } from "@/lib/seo/actions/copy";
import {
  actionDraftFromFinding,
  actionDraftFromHealthIssue,
  originFor,
  type ActionDraft,
} from "@/lib/seo/actions/drafts";
import { HEALTH_FIX_KINDS, fixKindForFinding } from "@/lib/seo/actions/kinds";
import type {
  PageSnapshot,
  SeoActionProposalStored,
  SeoActionStatus,
  SeoActionView,
} from "@/lib/seo/actions/types";
import { seoMockMode } from "@/lib/seo/health-flags";
import { maskGooglePath } from "@/server/integrations/google/pii";
import { readSeoCard } from "@/server/modules/seo/card";
import { createSeoManagerCard } from "@/server/modules/seo/new-card";
import { readTarget } from "@/server/modules/seo/target";
import {
  pageCheckSite,
  readCrawledPage,
} from "@/server/seo/actions/page-check";
import {
  attachCard,
  createSeoAction,
  findOpenAction,
  transitionAction,
  updateProposal,
} from "@/server/seo/actions/store";
import { SeoActionVerifier } from "@/server/seo/actions/verify";
import {
  decideFinding,
  findingViewOf,
} from "@/server/seo/opportunities/findings-store";
import { primaryGscLink } from "@/server/seo/store";

// "Fix this", "Mark done" ve "I fixed this" (SC-F6, docs/search-actions.md
// "SEO Manager" ve "Arayüz"): bulgu ya da sağlık uyarısı bir SeoAction'a
// bağlanır; kartlı türler SEO Manager Work'üne, diğerleri Actions & results
// kontrol listesine gider. Anahtar kelime (Google kaynaklı) hiçbir kart
// alanına yazılmaz; yalnız SeoAction.proposal.primaryKeyword'de durur ve
// kullanıcıya öneri olarak sunulur. Work ve kart kimlikleri eyleme bağlı ve
// belirlenimcidir: çift dokunuş aynı kartı bulur, silinmiş kart aynı
// kimliklerle yeniden kurulur.

export type FixThisResult =
  | {
      ok: true;
      actionId: string;
      href: string;
      opened: "manager" | "checklist";
    }
  | { ok: false; message: string };

export type FixThisState = {
  actionId: string;
  status: SeoActionStatus;
  statusLabel: string;
  href: string;
};

export type HealthFixState =
  | { actionId: string; status: SeoActionStatus; statusLabel: string }
  | { trackable: true };

const MESSAGE = {
  notOpen: "This opportunity is no longer open.",
  closerLook: "This one needs a closer look rather than a single fix.",
  noDraft: "We couldn't prepare a fix for this opportunity.",
  noLink: "Search Console isn't connected for this opportunity anymore.",
  managerFailed: "We couldn't open the SEO Manager. Try again.",
  healthGone: "This issue is no longer open.",
  healthUnsupported: "This issue can't be tracked as a change.",
} as const;

const TITLE_PATH_MAX = 60;
const ALERT_PATHS_MAX = 20;

function fail(message: string): { ok: false; message: string } {
  return { ok: false, message };
}

function workHref(projectId: string, workId: string): string {
  return `/projects/${projectId}?work=${encodeURIComponent(workId)}`;
}

function checklistHref(projectId: string, actionId: string): string {
  return `/projects/${projectId}/arama?action=${encodeURIComponent(actionId)}#actions`;
}

function pathFor(url: string | null): string | null {
  if (!url) return null;
  try {
    const masked = maskGooglePath(new URL(url).pathname || "/") || "/";
    return masked.length > TITLE_PATH_MAX
      ? `${masked.slice(0, TITLE_PATH_MAX - 1)}…`
      : masked;
  } catch {
    return null;
  }
}

function logFailure(scope: string, error: unknown): void {
  console.error(
    `[seo-actions] ${scope}:`,
    error instanceof Error ? error.message : error,
  );
}

// Yanıttan sonra tek bakış: değişiklik zaten yayında olabilir. after() istek
// dışında fırlatırsa sessizce günlük doğrulayıcıya bırakılır.
function verifyLater(actionId: string): void {
  try {
    after(async () => {
      try {
        await SeoActionVerifier.runAction(actionId);
      } catch (error) {
        logFailure("verification failed", error);
      }
    });
  } catch (error) {
    logFailure("verification could not be scheduled", error);
  }
}

// Mevcut kipin bağı; başka kipin bağı bulgu için geçerli sayılmaz.
async function currentLink(
  projectId: string,
  linkId: string,
): Promise<{ id: string; siteUrl: string } | null> {
  return prisma.gscSiteLink.findFirst({
    where: { id: linkId, projectId, isMock: seoMockMode() },
    select: { id: true, siteUrl: true },
  });
}

// Tahmin tabanı: taslakta "önceki" başlık/açıklama yoksa ilk taramadan alınır.
function withBefore(
  proposal: SeoActionProposalStored,
  baseline: PageSnapshot | null,
): SeoActionProposalStored {
  if (proposal.kind === "TITLE_META" && proposal.before === null && baseline) {
    return {
      ...proposal,
      before: {
        title: baseline.title ?? "",
        metaDescription: baseline.metaDescription ?? "",
      },
    };
  }
  return proposal;
}

async function openManagerCard(input: {
  projectId: string;
  userId: string;
  workspaceId: string;
  brandId: string;
  action: SeoActionView;
  draft: ActionDraft;
  origin: string | null;
  finding: { id: string; ruleKey: string };
  now: Date;
}): Promise<string> {
  const { action, draft, projectId } = input;
  const mode = draft.managerMode;
  if (!mode) throw new Error("No SEO Manager mode for this fix.");
  const workId = `seofix_${action.id}`;
  const commandId = `seofixcard_${action.id}`;

  // Kart yaşıyorsa olduğu gibi açılır; silinmişse aynı kimliklerle kurulur.
  if (action.commandId) {
    const existing = await readSeoCard(projectId, action.commandId);
    if (existing) return workHref(projectId, existing.workId ?? workId);
  }

  const target =
    draft.targetUrl && mode !== "article"
      ? await readTarget(projectId, draft.targetUrl, { now: input.now })
      : null;
  const project = await prisma.project.findFirst({
    where: { id: projectId },
    select: { language: true },
  });
  const path = pathFor(draft.targetUrl);
  const readTitle = target && target.ok ? target.target.title : null;

  const created = await createSeoManagerCard({
    scope: {
      workspaceId: input.workspaceId,
      projectId,
      brandId: input.brandId,
    },
    userId: input.userId,
    mode,
    work: { id: workId, title: actionTitle(draft.kind, path) },
    commandId,
    state: {
      origin: { findingId: input.finding.id, ruleKey: input.finding.ruleKey },
      actionId: action.id,
      // Makale kipinde konu boş kalır: anahtar kelime öneri olarak sunulur.
      brief: {
        topic: mode === "article" ? "" : (readTitle ?? path ?? ""),
        siteUrl: input.origin ?? "",
        language: project?.language || "tr",
        audience: "",
      },
      ...(target && target.ok ? { target: target.target } : {}),
      ...(target && !target.ok && draft.targetUrl
        ? { pendingUrl: draft.targetUrl }
        : {}),
    },
    now: input.now,
  });

  await attachCard({
    projectId,
    actionId: action.id,
    commandId: created.commandId,
    workId: created.workId,
  });
  if (target && target.ok) {
    await updateProposal({
      projectId,
      actionId: action.id,
      proposal: withBefore(action.proposal, target.baseline),
      baseline: target.baseline,
    });
  }
  return workHref(projectId, created.workId);
}

export async function fixFinding(input: {
  projectId: string;
  findingId: string;
  userId: string;
  workspaceId: string;
  brandId: string;
  now?: Date;
}): Promise<FixThisResult> {
  const now = input.now ?? new Date();
  const { projectId } = input;
  const row = await prisma.seoFinding.findFirst({
    where: {
      id: input.findingId,
      projectId,
      shadow: false,
      status: { in: ["OPEN", "ACCEPTED"] },
    },
  });
  if (!row) return fail(MESSAGE.notOpen);
  const link = await currentLink(projectId, row.linkId);
  if (!link) return fail(MESSAGE.noLink);

  const view = findingViewOf(row);
  if (fixKindForFinding(view.actionKind) === null) {
    return fail(MESSAGE.closerLook);
  }
  const site = await pageCheckSite(projectId);
  const origin = originFor({
    siteOrigin: site?.origin ?? null,
    gscSiteUrl: link.siteUrl,
  });
  const draft = actionDraftFromFinding(view, origin);
  if (!draft) return fail(MESSAGE.noDraft);

  const openKey = `finding:${view.id}`;
  let action = await findOpenAction(projectId, openKey);
  if (!action) {
    const created = await createSeoAction({
      workspaceId: input.workspaceId,
      projectId,
      kind: draft.kind,
      source: "FINDING",
      status: "ACCEPTED",
      openKey,
      linkId: row.linkId,
      targetUrl: draft.targetUrl,
      pageId: draft.pageId,
      targetQueries: draft.targetQueries,
      proposal: draft.proposal,
      findingId: view.id,
      userId: input.userId,
      now,
    });
    action = created.action;
  }

  if (row.status === "OPEN") {
    // Bulgu kabul edilir; başarısızlık Fix this'i engellemez.
    await decideFinding({
      projectId,
      findingId: view.id,
      decision: "ACCEPT",
      userId: input.userId,
      now,
    }).catch((error: unknown) => logFailure("finding accept failed", error));
  }

  if (draft.managerMode === null) {
    return {
      ok: true,
      actionId: action.id,
      href: checklistHref(projectId, action.id),
      opened: "checklist",
    };
  }
  try {
    const href = await openManagerCard({
      projectId,
      userId: input.userId,
      workspaceId: input.workspaceId,
      brandId: input.brandId,
      action,
      draft,
      origin,
      finding: { id: view.id, ruleKey: view.ruleKey },
      now,
    });
    return { ok: true, actionId: action.id, href, opened: "manager" };
  } catch (error) {
    logFailure("manager card failed", error);
    return fail(MESSAGE.managerFailed);
  }
}

// Fırsat "Done" olarak işaretlendi: her Done ölçülür. Bulgu zaten DONE'dır
// (decideFinding); eylem yoksa APPLIED doğar, "To do" ise uygulanır.
export async function trackFindingDone(input: {
  projectId: string;
  findingId: string;
  userId: string;
  workspaceId: string;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  const { projectId } = input;
  const row = await prisma.seoFinding.findFirst({
    where: { id: input.findingId, projectId, shadow: false },
  });
  if (!row) return;
  const view = findingViewOf(row);
  if (fixKindForFinding(view.actionKind) === null) return;

  const openKey = `finding:${view.id}`;
  const open = await findOpenAction(projectId, openKey);
  let actionId: string;
  let changed = false;
  if (open) {
    actionId = open.id;
    if (open.status === "PROPOSED" || open.status === "ACCEPTED") {
      const result = await transitionAction({
        projectId,
        actionId: open.id,
        event: "APPLY",
        userId: input.userId,
        now,
      });
      changed = result.ok;
    }
  } else {
    const [site, link] = await Promise.all([
      pageCheckSite(projectId),
      prisma.gscSiteLink.findFirst({
        where: { id: row.linkId, projectId },
        select: { siteUrl: true },
      }),
    ]);
    const origin = originFor({
      siteOrigin: site?.origin ?? null,
      gscSiteUrl: link?.siteUrl ?? null,
    });
    const draft = actionDraftFromFinding(view, origin);
    if (!draft) return;
    const crawled =
      draft.targetUrl && site
        ? await readCrawledPage(site.siteId, draft.targetUrl)
        : null;
    const created = await createSeoAction({
      workspaceId: input.workspaceId,
      projectId,
      kind: draft.kind,
      source: "OPPORTUNITY_DONE",
      status: "APPLIED",
      openKey,
      linkId: row.linkId,
      targetUrl: draft.targetUrl,
      pageId: draft.pageId,
      targetQueries: draft.targetQueries,
      proposal: draft.proposal,
      baseline: crawled?.snapshot ?? null,
      findingId: view.id,
      userId: input.userId,
      now,
    });
    actionId = created.action.id;
    changed = created.created;
  }
  if (changed) verifyLater(actionId);
}

export async function loadFixThisStates(
  projectId: string,
  findingIds: readonly string[],
): Promise<Record<string, FixThisState>> {
  if (!SeoActionFlags.loop() || !seoActionsAllowedFor(projectId)) return {};
  const ids = [...new Set(findingIds)];
  if (ids.length === 0) return {};
  const rows = await prisma.seoAction.findMany({
    where: {
      projectId,
      isMock: seoMockMode(),
      openKey: { in: ids.map((id) => `finding:${id}`) },
    },
    select: {
      id: true,
      openKey: true,
      status: true,
      workId: true,
      commandId: true,
    },
  });
  const states: Record<string, FixThisState> = {};
  for (const row of rows) {
    if (!row.openKey?.startsWith("finding:")) continue;
    const status = row.status as SeoActionStatus;
    states[row.openKey.slice("finding:".length)] = {
      actionId: row.id,
      status,
      statusLabel: ACTION_STATUS_LABEL[status] ?? row.status,
      href:
        row.workId && row.commandId
          ? workHref(projectId, row.workId)
          : checklistHref(projectId, row.id),
    };
  }
  return states;
}

function alertPathsOf(data: unknown): string[] {
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  const paths = (data as { paths?: unknown }).paths;
  if (!Array.isArray(paths)) return [];
  return paths
    .filter((path): path is string => typeof path === "string")
    .slice(0, ALERT_PATHS_MAX);
}

// "I fixed this" (sağlık sorunu): eylem APPLIED doğar; doğrulama uyarının
// çözülmesine bakar. SEO kaynaklı uyarılar yalnız tarayıcıyla çalışır (linkId
// null); GSC kaynaklı olanlar birincil bağa bağlanır.
export async function trackHealthFix(input: {
  projectId: string;
  alertId: string;
  userId: string;
  workspaceId: string;
  now?: Date;
}): Promise<{ ok: true; actionId: string } | { ok: false; message: string }> {
  const now = input.now ?? new Date();
  const { projectId } = input;
  const alert = await prisma.adsAlert.findFirst({
    where: {
      id: input.alertId,
      projectId,
      source: { in: ["GSC", "SEO"] },
      status: { in: ["OPEN", "ACKED", "MUTED"] },
    },
    select: {
      id: true,
      kind: true,
      source: true,
      dedupeKey: true,
      data: true,
    },
  });
  if (!alert) return fail(MESSAGE.healthGone);
  const source = alert.source === "GSC" ? "GSC" : "SEO";
  if (!Object.hasOwn(HEALTH_FIX_KINDS, alert.kind)) {
    return fail(MESSAGE.healthUnsupported);
  }

  const openKey = `alert:${alert.dedupeKey}`;
  const existing = await findOpenAction(projectId, openKey);
  if (existing) return { ok: true, actionId: existing.id };

  const [site, link] = await Promise.all([
    pageCheckSite(projectId),
    primaryGscLink(projectId),
  ]);
  const origin = originFor({
    siteOrigin: site?.origin ?? null,
    gscSiteUrl: link?.siteUrl ?? null,
  });
  const draft = actionDraftFromHealthIssue({
    alertKind: alert.kind,
    alertSource: source,
    dedupeKey: alert.dedupeKey,
    origin,
    alertPaths: alertPathsOf(alert.data),
  });
  if (!draft) return fail(MESSAGE.healthUnsupported);

  const crawled =
    draft.targetUrl && site
      ? await readCrawledPage(site.siteId, draft.targetUrl)
      : null;
  const created = await createSeoAction({
    workspaceId: input.workspaceId,
    projectId,
    kind: draft.kind,
    source: "HEALTH_ISSUE",
    status: "APPLIED",
    openKey,
    // GSC uyarısı birincil bağa (store çözer); SEO uyarısı yalnız tarayıcıyla.
    ...(source === "GSC" ? {} : { linkId: null }),
    targetUrl: draft.targetUrl,
    pageId: null,
    targetQueries: [],
    proposal: draft.proposal,
    baseline: crawled?.snapshot ?? null,
    userId: input.userId,
    now,
  });
  return { ok: true, actionId: created.action.id };
}

export async function loadHealthFixStates(
  projectId: string,
  issues: readonly { id: string; kind: string }[],
): Promise<Record<string, HealthFixState>> {
  if (!SeoActionFlags.loop() || !seoActionsAllowedFor(projectId)) return {};
  const fixable = issues.filter((issue) =>
    Object.hasOwn(HEALTH_FIX_KINDS, issue.kind),
  );
  if (fixable.length === 0) return {};

  const alerts = await prisma.adsAlert.findMany({
    where: {
      projectId,
      id: { in: fixable.map((issue) => issue.id) },
      source: { in: ["GSC", "SEO"] },
    },
    select: { id: true, dedupeKey: true },
  });
  if (alerts.length === 0) return {};
  const actions = await prisma.seoAction.findMany({
    where: {
      projectId,
      isMock: seoMockMode(),
      openKey: { in: alerts.map((alert) => `alert:${alert.dedupeKey}`) },
    },
    select: { id: true, openKey: true, status: true },
  });
  const byKey = new Map(actions.map((action) => [action.openKey, action]));

  const states: Record<string, HealthFixState> = {};
  for (const alert of alerts) {
    const action = byKey.get(`alert:${alert.dedupeKey}`);
    if (action) {
      const status = action.status as SeoActionStatus;
      states[alert.id] = {
        actionId: action.id,
        status,
        statusLabel: ACTION_STATUS_LABEL[status] ?? action.status,
      };
    } else {
      states[alert.id] = { trackable: true };
    }
  }
  return states;
}
