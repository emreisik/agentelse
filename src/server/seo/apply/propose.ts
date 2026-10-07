import "server-only";

import type { CmsSite, SeoChange } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { approvalRowsFor } from "@/lib/seo/apply/approval-details";
import {
  changeUndoWarning,
  SEO_APPLY_REFUSAL_MESSAGES,
  SEO_CHANGE_TASK_TITLE,
} from "@/lib/seo/apply/copy";
import {
  dedupeKeyFor,
  openKeyFor,
  SEO_APPLY_APPROVAL_TTL_MS,
} from "@/lib/seo/apply/lifecycle";
import type {
  SeoApplyRefusal,
  SeoChangeErrorCode,
  SeoChangeKind,
  SeoChangeParams,
  SeoChangeSource,
  SeoChangeStatus,
  SeoFieldsCapability,
  WpCapabilities,
  WpSnapshot,
  WpType,
} from "@/lib/seo/apply/types";
import { validateTitleMeta } from "@/lib/seo/apply/validate";
import { validateLinks } from "@/lib/seo/apply/validate-links";
import { capabilityAllows } from "@/lib/seo/apply/wp/capabilities";
import { hasBuilderMarkers } from "@/lib/seo/apply/wp/internal-links";
import { matchWpObject } from "@/lib/seo/apply/wp/match";
import { planChange } from "@/lib/seo/apply/wp/plan";
import type { WpObject } from "@/lib/seo/apply/wp/wp-types";
import {
  hostTwin,
  inScope,
  normalizeCrawlUrl,
  pathOf,
  type CrawlScope,
} from "@/lib/seo/crawl-url";
import type { WordPressClient } from "@/server/integrations/wordpress/client";
import { wpErrorToChangeCode } from "@/server/integrations/wordpress/errors";

import { ensureActionAccepted } from "./action-link";
import { syncSeoChangeApprovalState } from "./approval-hook";
import { recordSeoApplyAudit } from "./audit";
import { resolveApplyDeps } from "./deps";
import { gateApplySite } from "./site";
import { getChangeInProject, kindOf, snapshotOfJson, statusOf } from "./store";
import { loadArticleForPublish } from "./articles";
import { createSeoApplyTaskApproval } from "./task-approval";
import type {
  ProposeSeoChangeInput,
  ProposeSeoChangeResult,
  SeoApplyDeps,
} from "./types";

// Öneri motoru (docs/website-apply.md): kapıdan geçirir, girdiyi doğrular,
// siteyi YALNIZ okur, kuru çalıştırma yapar, tek açık değişiklik kuralını
// uygular ve SeoChange + Task + Approval kurar. Bu dosya WordPress'e ASLA yazma
// çağrısı yapmaz; yazma yalnız onaydan sonra apply.ts'tedir.

type Row = { label: string; value: string };

function refuse(
  code: SeoApplyRefusal,
  existingChangeId?: string | null,
  message?: string,
): ProposeSeoChangeResult {
  return {
    ok: false,
    code,
    message: message ?? SEO_APPLY_REFUSAL_MESSAGES[code],
    ...(existingChangeId !== undefined ? { existingChangeId } : {}),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

// Kuru çalıştırmanın ret kodunu kullanıcıya dönük ret koduna çevirir.
function refusalOfCode(code: SeoChangeErrorCode): SeoApplyRefusal {
  switch (code) {
    case "page_not_found":
      return "page_not_found";
    case "page_ambiguous":
      return "page_ambiguous";
    case "builder_page":
      return "builder_page";
    case "anchor_not_found":
      return "anchor_not_found";
    case "seo_plugin_unsupported":
      return "seo_plugin_unsupported";
    case "site_unavailable":
    case "rate_limited":
      return "site_unavailable";
    case "no_permission":
      return "no_permission";
    case "reconnect":
    case "site_unhealthy":
      return "site_unhealthy";
    default:
      return "invalid";
  }
}

// Okuma hatası: yetki ve parola sorunları kendi koduyla, geri kalanı (ağ,
// zaman aşımı, 5xx, bilinmeyen) "site yanıt vermedi" olur.
function refusalOfReadError(error: unknown): SeoApplyRefusal {
  const { code } = wpErrorToChangeCode(error);
  if (code === "no_permission") return "no_permission";
  if (code === "reconnect" || code === "site_unhealthy") return "site_unhealthy";
  if (code === "page_not_found") return "page_not_found";
  return "site_unavailable";
}

function hostOfUrl(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

// Adres, bağlı sitenin kendi alan adında olmalı (www eşi dahil) ve doğrulanmış
// kapsamın içinde kalmalı.
function pageUrlOk(url: string, origin: string, scope: CrawlScope): boolean {
  const host = hostOfUrl(url);
  const siteHost = hostOfUrl(origin);
  if (!host || !siteHost) return false;
  if (host !== siteHost && host !== hostTwin(siteHost)) return false;
  return inScope(url, scope);
}

type Prepared = {
  params: SeoChangeParams;
  source: SeoChangeSource;
  creativeId: string | null;
  // PUBLISH_ARTICLE'da yok; diğerlerinde canlı nesne (kuru çalıştırma girdisi).
  live: WpObject | null;
  wpType: WpType | null;
  wpId: number | null;
  targetUrl: string | null;
  // Onay satırları için.
  words?: number;
  draftEditedSince?: boolean;
};

type PrepareResult =
  | { ok: true; prepared: Prepared }
  | { ok: false; result: ProposeSeoChangeResult };

type PrepareContext = {
  projectId: string;
  site: CmsSite;
  scope: CrawlScope;
  capabilities: WpCapabilities;
  client: WordPressClient;
};

async function findPage(
  ctx: PrepareContext,
  rawUrl: string,
): Promise<
  | { ok: true; url: string; object: WpObject }
  | { ok: false; result: ProposeSeoChangeResult }
> {
  const url = normalizeCrawlUrl(rawUrl);
  if (!url) return { ok: false, result: refuse("invalid") };
  if (!pageUrlOk(url, ctx.site.origin, ctx.scope)) {
    return { ok: false, result: refuse("domain_mismatch") };
  }
  let objects: WpObject[];
  try {
    objects = await ctx.client.findObjects(url);
  } catch (error) {
    return { ok: false, result: refuse(refusalOfReadError(error)) };
  }
  const match = matchWpObject(objects, url);
  if (match.kind === "none") {
    return { ok: false, result: refuse("page_not_found") };
  }
  if (match.kind === "many") {
    return { ok: false, result: refuse("page_ambiguous") };
  }
  return { ok: true, url, object: match.object };
}

function articleFailureMessage(reason: string): SeoApplyRefusal {
  return reason === "too_short" ? "invalid" : "article_missing";
}

async function prepareArticle(
  input: Extract<ProposeSeoChangeInput, { kind: "PUBLISH_ARTICLE" }>,
  ctx: PrepareContext,
): Promise<PrepareResult> {
  const loaded = await loadArticleForPublish(ctx.projectId, input.creativeId);
  if (!loaded.ok) {
    return {
      ok: false,
      result: refuse(
        articleFailureMessage(loaded.reason),
        undefined,
        loaded.reason === "too_short" ? loaded.message : undefined,
      ),
    };
  }
  const { article } = loaded;
  const params: SeoChangeParams = {
    kind: "PUBLISH_ARTICLE",
    creativeId: article.creativeId,
    versionId: article.versionId,
    title: article.title,
    metaDescription: article.metaDescription,
    markdown: article.markdown,
    language: article.language,
  };
  // Aynı sürüm zaten sitede (geri alınmamış) ise tekrar taslak açılmaz.
  const done = await prisma.seoChange.findFirst({
    where: {
      siteId: ctx.site.id,
      dedupeKey: dedupeKeyFor(params),
      status: "VERIFIED",
    },
    select: { id: true },
  });
  if (done) return { ok: false, result: refuse("already_done", done.id) };
  return {
    ok: true,
    prepared: {
      params,
      source: "ARTICLE",
      creativeId: article.creativeId,
      live: null,
      wpType: null,
      wpId: null,
      targetUrl: null,
      words: article.words,
    },
  };
}

async function prepareLive(
  input: Extract<ProposeSeoChangeInput, { kind: "PUBLISH_LIVE" }>,
  ctx: PrepareContext,
): Promise<PrepareResult> {
  const draft = await getChangeInProject(ctx.projectId, input.draftChangeId);
  const draftParams =
    draft && draft.params && typeof draft.params === "object"
      ? (draft.params as SeoChangeParams)
      : null;
  if (
    !draft ||
    draft.siteId !== ctx.site.id ||
    kindOf(draft) !== "PUBLISH_ARTICLE" ||
    statusOf(draft) !== "VERIFIED" ||
    draft.noop ||
    draft.wpId === null
  ) {
    return { ok: false, result: refuse("draft_missing") };
  }
  if (!capabilityAllows(ctx.capabilities, "PUBLISH_LIVE", "post")) {
    return { ok: false, result: refuse("no_permission") };
  }

  let live: WpObject | null;
  try {
    live = await ctx.client.getObject("post", draft.wpId);
  } catch (error) {
    return { ok: false, result: refuse(refusalOfReadError(error)) };
  }
  if (!live) return { ok: false, result: refuse("draft_missing") };
  if (live.status === "publish") {
    return { ok: false, result: refuse("already_done", draft.id) };
  }

  const draftAfter = snapshotOfJson(draft.after);
  const creativeId =
    draft.creativeId ??
    (draftParams && draftParams.kind === "PUBLISH_ARTICLE"
      ? draftParams.creativeId
      : null);
  const params: SeoChangeParams = {
    kind: "PUBLISH_LIVE",
    draftChangeId: draft.id,
    wpType: "post",
    wpId: draft.wpId,
    link: live.link || null,
    // Bayat koruması: taslak bundan sonra düzenlenirse yayın reddedilir.
    expectModified: live.modified,
    creativeId,
  };
  return {
    ok: true,
    prepared: {
      params,
      source: "DRAFT",
      // Sütun her iki makale türünde de dolar (durum ucu sütunla bulur).
      creativeId,
      live,
      wpType: "post",
      wpId: draft.wpId,
      targetUrl: live.link || null,
      draftEditedSince:
        draftAfter?.modified != null && live.modified !== draftAfter.modified,
    },
  };
}

async function prepareTitleMeta(
  input: Extract<ProposeSeoChangeInput, { kind: "TITLE_META" }>,
  ctx: PrepareContext,
): Promise<PrepareResult> {
  const text = validateTitleMeta({
    title: input.title,
    metaDescription: input.metaDescription,
  });
  if (!text.ok) {
    return { ok: false, result: refuse("invalid", undefined, text.message) };
  }
  const page = await findPage(ctx, input.url);
  if (!page.ok) return page;
  const { object, url } = page;
  if (!capabilityAllows(ctx.capabilities, "TITLE_META", object.type)) {
    return { ok: false, result: refuse("no_permission") };
  }
  const params: SeoChangeParams = {
    kind: "TITLE_META",
    url,
    wpType: object.type,
    wpId: object.id,
    expectModified: object.modified,
    title: text.title,
    metaDescription: text.metaDescription,
  };
  return {
    ok: true,
    prepared: {
      params,
      source: "ACTION",
      creativeId: null,
      live: object,
      wpType: object.type,
      wpId: object.id,
      targetUrl: url,
    },
  };
}

async function prepareLinks(
  input: Extract<ProposeSeoChangeInput, { kind: "INTERNAL_LINKS" }>,
  ctx: PrepareContext,
): Promise<PrepareResult> {
  const links = validateLinks(input.links, {
    pageUrl: input.url,
    scope: ctx.scope,
  });
  if (!links.ok) {
    return { ok: false, result: refuse("invalid", undefined, links.message) };
  }
  const page = await findPage(ctx, input.url);
  if (!page.ok) return page;
  const { object, url } = page;
  if (!capabilityAllows(ctx.capabilities, "INTERNAL_LINKS", object.type)) {
    return { ok: false, result: refuse("no_permission") };
  }
  // Sayfa oluşturucu ile yapılmış sayfaların içeriği güvenle düzenlenemez.
  if (!object.content || hasBuilderMarkers(object.content)) {
    return { ok: false, result: refuse("builder_page") };
  }
  const params: SeoChangeParams = {
    kind: "INTERNAL_LINKS",
    url,
    wpType: object.type,
    wpId: object.id,
    expectModified: object.modified,
    links: links.links,
  };
  return {
    ok: true,
    prepared: {
      params,
      source: "ACTION",
      creativeId: null,
      live: object,
      wpType: object.type,
      wpId: object.id,
      targetUrl: url,
    },
  };
}

function titleViaOf(
  params: SeoChangeParams,
  fields: SeoFieldsCapability,
): "SEO_PLUGIN" | "POST_TITLE" | null {
  if (params.kind !== "TITLE_META" || params.title === null) return null;
  return fields.titleVia === "POST_TITLE" ? "POST_TITLE" : "SEO_PLUGIN";
}

// Onay kartının satırları. Parola, kimlik bilgisi ya da WordPress ham hatası
// hiçbir zaman girmez; yalnız onaylanacak metin ve önceki durum.
function detailsFor(
  prepared: Prepared,
  site: CmsSite,
  fields: SeoFieldsCapability,
  before: WpSnapshot | null,
): Row[] {
  const { params } = prepared;
  const host = hostOfUrl(site.origin) ?? site.origin;
  const titleVia = titleViaOf(params, fields);
  const beforeTitle =
    titleVia === "POST_TITLE" ? before?.title : (before?.seoTitle ?? "");
  return approvalRowsFor({
    kind: params.kind,
    host,
    path:
      params.kind === "TITLE_META" || params.kind === "INTERNAL_LINKS"
        ? pathOf(params.url)
        : null,
    before: {
      title: beforeTitle ?? null,
      description: before?.seoDescription ?? null,
    },
    after: {
      title:
        params.kind === "TITLE_META" || params.kind === "PUBLISH_ARTICLE"
          ? params.title
          : null,
      description:
        params.kind === "TITLE_META" ? params.metaDescription : null,
      links:
        params.kind === "INTERNAL_LINKS"
          ? params.links.map((link) => ({
              anchor: link.anchor,
              toPath: pathOf(link.toUrl),
            }))
          : undefined,
      words: prepared.words,
    },
    titleVia,
    draftEditedSince: prepared.draftEditedSince,
    undoText: changeUndoWarning(params.kind) ?? "You can undo this for 90 days.",
  });
}

async function findOpen(siteId: string, dedupeKey: string): Promise<SeoChange | null> {
  const openKey = openKeyFor("PROPOSED", dedupeKey);
  if (!openKey) return null;
  return prisma.seoChange.findFirst({ where: { siteId, openKey } });
}

function existingResult(
  change: SeoChange,
  status: SeoChangeStatus,
  preview: Row[],
): ProposeSeoChangeResult {
  return {
    ok: true,
    changeId: change.id,
    status,
    created: false,
    approvalId: change.approvalId,
    preview,
  };
}

export async function proposeSeoChange(
  input: ProposeSeoChangeInput,
  deps: SeoApplyDeps = {},
): Promise<ProposeSeoChangeResult> {
  const resolved = resolveApplyDeps(deps);
  const now = resolved.now;
  const { projectId, userId, kind } = input;

  // 1. Kapı: bayrak, geliştirme koruması, site, sağlık, kapsam, yetenek.
  const gate = await gateApplySite(projectId, kind, {
    mock: resolved.mock,
    wpType: kind === "PUBLISH_LIVE" ? "post" : null,
    // Başlık/bağlantı değişiminin türü nesneyi okuyunca belli olur.
    anyWpType: kind === "TITLE_META" || kind === "INTERNAL_LINKS",
  });
  if (!gate.ok) return refuse(gate.refusal);
  const { site, scope, fields, capabilities } = gate;

  const client = await resolved.clientFor(site);
  if (!client) return refuse("not_connected");

  // 2. Türe göre girdi doğrulama ve siteyi okuma (yalnız okuma).
  const ctx: PrepareContext = { projectId, site, scope, capabilities, client };
  let prepared: PrepareResult;
  switch (input.kind) {
    case "PUBLISH_ARTICLE":
      prepared = await prepareArticle(input, ctx);
      break;
    case "PUBLISH_LIVE":
      prepared = await prepareLive(input, ctx);
      break;
    case "TITLE_META":
      prepared = await prepareTitleMeta(input, ctx);
      break;
    case "INTERNAL_LINKS":
      prepared = await prepareLinks(input, ctx);
      break;
  }
  if (!prepared.ok) return prepared.result;
  const { params } = prepared.prepared;
  const item = prepared.prepared;

  // 3. Kuru çalıştırma: motorun uygulayacağı planın aynısı, önceki durum yok.
  const plan = planChange(params, item.live, {
    fields,
    capabilities,
    prior: null,
  });
  if (plan.kind === "refuse") return refuse(refusalOfCode(plan.code));
  if (plan.kind === "noop") return refuse("already_done");

  const details = detailsFor(item, site, fields, plan.before);
  const dedupeKey = dedupeKeyFor(params);

  // 4. Tek açık değişiklik: aynı konu için yeni Task açılmaz.
  const existing = await findOpen(site.id, dedupeKey);
  if (existing) {
    const current = statusOf(existing);
    if (current === "APPLYING" || current === "APPLIED") {
      return refuse("already_open", existing.id);
    }
    if (current !== "PROPOSED") return existingResult(existing, current, details);
    // Açık satırın onayı sohbetten reddedilmiş olabilir: önce hizala, kapandıysa
    // aşağıda taze bir değişiklik kurulur.
    const status = await syncSeoChangeApprovalState(existing.id, { now });
    if (status !== "REJECTED" && status !== "EXPIRED" && status !== null) {
      const fresh = await findOpen(site.id, dedupeKey);
      return fresh
        ? existingResult(fresh, statusOf(fresh), details)
        : existingResult(existing, status, details);
    }
  }

  const brand = await prisma.brand.findFirst({
    where: { projectId, isDefault: true },
    select: { id: true },
  });
  if (!brand) return refuse("not_allowed_here");

  // 5. Satır: expiresAt TEK kez hesaplanır, Approval ile aynı değerdir.
  const expiresAt = new Date(now.getTime() + SEO_APPLY_APPROVAL_TTL_MS);
  let change: SeoChange;
  try {
    change = await prisma.seoChange.create({
      data: {
        workspaceId: site.workspaceId,
        projectId,
        siteId: site.id,
        isMock: site.isMock,
        kind,
        status: "PROPOSED",
        source: item.source,
        title: SEO_CHANGE_TASK_TITLE[kind],
        targetUrl: item.targetUrl,
        wpType: item.wpType,
        wpId: item.wpId,
        params: params as never,
        dedupeKey,
        openKey: openKeyFor("PROPOSED", dedupeKey),
        creativeId: item.creativeId,
        proposedByType: "USER",
        proposedByUserId: userId,
        expiresAt,
      },
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Eşzamanlı öneri kazandı: onun satırını döndür.
    const winner = await findOpen(site.id, dedupeKey);
    if (winner) return existingResult(winner, statusOf(winner), details);
    throw error;
  }

  // 6. Task + Approval.
  try {
    const { taskId, approvalId } = await createSeoApplyTaskApproval({
      workspaceId: site.workspaceId,
      projectId,
      brandId: brand.id,
      userId,
      changeId: change.id,
      kind,
      details,
      expiresAt,
      now,
    });
    change = await prisma.seoChange.update({
      where: { id: change.id },
      data: { taskId, approvalId },
    });
  } catch (error) {
    console.error(
      "[seo-apply] proposal could not be requested:",
      error instanceof Error ? error.name : "unknown",
    );
    // Satır açık kalıp aynı konuyu kilitlemesin.
    await prisma.seoChange
      .updateMany({
        where: { id: change.id, status: "PROPOSED" },
        data: { status: "EXPIRED", openKey: null },
      })
      .catch(() => undefined);
    return refuse("not_allowed_here");
  }

  // 7. SC-F6 eylemi: kabul edilir ve satıra bağlanır (en iyi çabayla).
  const actionId =
    input.kind === "TITLE_META" || input.kind === "INTERNAL_LINKS"
      ? (input.actionId ?? null)
      : null;
  if (actionId && (await ensureActionAccepted(projectId, actionId, userId))) {
    change = await prisma.seoChange
      .update({ where: { id: change.id }, data: { seoActionId: actionId } })
      .catch(() => change);
  }

  // 8. Denetim.
  await recordSeoApplyAudit(
    "seo_change.proposed",
    { changeId: change.id, kind: kind as SeoChangeKind, source: item.source },
    { workspaceId: site.workspaceId, projectId, userId },
  );

  return {
    ok: true,
    changeId: change.id,
    status: "PROPOSED",
    created: true,
    approvalId: change.approvalId,
    preview: details,
  };
}
