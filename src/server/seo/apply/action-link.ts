import "server-only";

import type { SeoChange } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { SeoActionFlags } from "@/lib/seo/action-flags";
import { seoMockMode } from "@/lib/seo/health-flags";
import type { SeoActionView } from "@/lib/seo/actions/types";
import type { SeoChangeParams } from "@/lib/seo/apply/types";
import { normalizeCrawlUrl } from "@/lib/seo/crawl-url";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { CreativeRepository } from "@/server/repositories/creative.repository";
import { IdeaChatRepository } from "@/server/repositories/idea-chat.repository";
import {
  findOpenAction,
  getAction,
  transitionAction,
  updateProposal,
} from "@/server/seo/actions/store";
import { fixFinding } from "@/server/seo/actions/fix-this";

// SC-F6 / SC-F7 ile TEK bağlantı noktası (docs/website-apply.md "SC-F6 bağı").
// Bu dosya dışında hiçbir SC-F8 dosyası eylem kaydına dokunmaz. Her işlev
// SeoActionFlags.loop() kapalıyken sorgusuz ve etkisizdir, asla fırlatmaz
// (yalnız hata adı loglanır): SEO değişikliği eylem bağı yüzünden bozulmaz.

export type ApplyCandidate = {
  actionId: string;
  findingId: string | null;
  kind: "TITLE_META" | "INTERNAL_LINKS";
  status: string;
  targetUrl: string | null;
  after: { title: string | null; metaDescription: string | null } | null;
  // Önerinin bütün bağlantıları (karşılananlar dahil).
  links: { fromUrl: string; toUrl: string; anchor: string }[];
};

type ProposalLink = { fromUrl: string; toUrl: string; anchor: string };

function report(scope: string, error: unknown): void {
  console.error(
    `[seo-apply] ${scope}:`,
    error instanceof Error ? error.name : "unknown",
  );
}

function normalized(url: string): string {
  return normalizeCrawlUrl(url) ?? url;
}

function linkKey(fromUrl: string, toUrl: string): string {
  return `${normalized(fromUrl)}\n${normalized(toUrl)}`;
}

function paramsOf(change: Pick<SeoChange, "params">): SeoChangeParams | null {
  const params = change.params;
  if (typeof params !== "object" || params === null) return null;
  return params as SeoChangeParams;
}

// Anahtar: (kaynak sayfa, hedef sayfa). Bağlantı metni kullanıcı tarafından
// düzenlenmiş olabilir; kapsama eşleşmesi metne bakmaz.
async function coveredLinkKeys(
  projectId: string,
  actionId: string,
): Promise<Set<string>> {
  const rows = await prisma.seoChange.findMany({
    where: {
      projectId,
      seoActionId: actionId,
      kind: "INTERNAL_LINKS",
      status: "VERIFIED",
    },
    select: { params: true },
  });
  const keys = new Set<string>();
  for (const row of rows) {
    const params = paramsOf(row);
    if (!params || params.kind !== "INTERNAL_LINKS") continue;
    for (const link of params.links) keys.add(linkKey(params.url, link.toUrl));
  }
  return keys;
}

function proposalLinksOf(action: SeoActionView): ProposalLink[] {
  return action.proposal.kind === "INTERNAL_LINKS"
    ? action.proposal.links.map((link) => ({ ...link }))
    : [];
}

function applyPatch(change: SeoChange): Record<string, string> {
  // appliedVia / approvalId W5 store.ts'in ortak düzenlemesiyle gelir; o zamana
  // kadar transitionAction bu alanları yok sayar (tip güvenli).
  const patch: Record<string, string> = { appliedVia: "CMS" };
  if (change.approvalId) patch.approvalId = change.approvalId;
  return patch;
}

function actorOf(change: SeoChange, userId: string | null): string {
  return userId ?? change.approvedByUserId ?? change.proposedByUserId ?? "system";
}

async function applyAction(
  change: SeoChange,
  actionId: string,
  userId: string | null,
): Promise<void> {
  // invalid_transition (eylem zaten uygulanmış ya da kapanmış) sorun değildir.
  await transitionAction({
    projectId: change.projectId,
    actionId,
    event: "APPLY",
    userId: actorOf(change, userId),
    ...applyPatch(change),
  });
}

export async function listApplyCandidates(
  projectId: string,
  input: { findingIds?: readonly string[]; actionIds?: readonly string[] },
): Promise<ApplyCandidate[]> {
  if (!SeoActionFlags.loop()) return [];
  try {
    const findingIds = [...(input.findingIds ?? [])];
    const actionIds = [...(input.actionIds ?? [])];
    if (findingIds.length === 0 && actionIds.length === 0) return [];
    const rows = await prisma.seoAction.findMany({
      where: {
        projectId,
        isMock: seoMockMode(),
        kind: { in: ["TITLE_META", "INTERNAL_LINKS"] },
        OR: [
          ...(findingIds.length ? [{ findingId: { in: findingIds } }] : []),
          ...(actionIds.length ? [{ id: { in: actionIds } }] : []),
        ],
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        findingId: true,
        kind: true,
        status: true,
        targetUrl: true,
        proposal: true,
      },
      take: 100,
    });
    const out: ApplyCandidate[] = [];
    for (const row of rows) {
      if (row.kind !== "TITLE_META" && row.kind !== "INTERNAL_LINKS") continue;
      const proposal =
        typeof row.proposal === "object" && row.proposal !== null
          ? (row.proposal as Record<string, unknown>)
          : {};
      const after = proposal.after;
      const afterText =
        typeof after === "object" && after !== null
          ? (after as Record<string, unknown>)
          : null;
      const links = Array.isArray(proposal.links)
        ? (proposal.links as unknown[]).filter(
            (item): item is ProposalLink =>
              typeof item === "object" &&
              item !== null &&
              typeof (item as ProposalLink).fromUrl === "string" &&
              typeof (item as ProposalLink).toUrl === "string" &&
              typeof (item as ProposalLink).anchor === "string",
          )
        : [];
      out.push({
        actionId: row.id,
        findingId: row.findingId,
        kind: row.kind,
        status: row.status,
        targetUrl: row.targetUrl,
        after:
          row.kind === "TITLE_META" && afterText
            ? {
                title:
                  typeof afterText.title === "string" && afterText.title
                    ? afterText.title
                    : null,
                metaDescription:
                  typeof afterText.metaDescription === "string" &&
                  afterText.metaDescription
                    ? afterText.metaDescription
                    : null,
              }
            : null,
        links: row.kind === "INTERNAL_LINKS" ? links : [],
      });
    }
    return out;
  } catch (error) {
    report("candidates could not be listed", error);
    return [];
  }
}

// Bulguya bağlı eylem yoksa kurar ("Fix this" yoluyla); varsa onu döndürür.
export async function ensureActionForFinding(input: {
  projectId: string;
  findingId: string;
  userId: string;
  workspaceId: string;
  brandId: string;
}): Promise<{ ok: true; actionId: string } | { ok: false }> {
  if (!SeoActionFlags.loop()) return { ok: false };
  try {
    const existing = await findOpenAction(
      input.projectId,
      `finding:${input.findingId}`,
    );
    if (existing) return { ok: true, actionId: existing.id };
    const result = await fixFinding(input);
    return result.ok ? { ok: true, actionId: result.actionId } : { ok: false };
  } catch (error) {
    report("action could not be ensured", error);
    return { ok: false };
  }
}

// Önerilen eylem kabul edilir (PROPOSED -> ACCEPTED); zaten kabul edilmiş ya da
// uygulanmışsa dokunulmaz. true: eylem bu değişiklikle ilişkilendirilebilir.
export async function ensureActionAccepted(
  projectId: string,
  actionId: string,
  userId: string,
): Promise<boolean> {
  if (!SeoActionFlags.loop()) return false;
  try {
    const action = await getAction(projectId, actionId);
    if (!action) return false;
    if (action.status === "PROPOSED") {
      const result = await transitionAction({
        projectId,
        actionId,
        event: "ACCEPT",
        userId,
      });
      return result.ok;
    }
    return action.status === "ACCEPTED" || action.status === "APPLIED";
  } catch (error) {
    report("action could not be accepted", error);
    return false;
  }
}

// Makale döngüsü: Creative'i yayınlandı işaretleyen çekirdek. markSeoPublishedAction
// ve markCreativePublishedAction oturum (tenant-context) ister, işçi grafiğine
// giremez; aynı durum makinesi ve aynı denetim kaydı burada kullanıcısız yapılır.
async function markCreativePublished(
  change: SeoChange,
  creativeId: string,
  userId: string | null,
): Promise<void> {
  const creative = await prisma.creative.findFirst({
    where: { id: creativeId, projectId: change.projectId },
    select: { status: true, createdByTaskId: true },
  });
  // PUBLISHED ise iş bitmiştir (elle "I published it" önce gelmiş olabilir).
  if (!creative || creative.status !== "APPROVED") return;

  await CreativeRepository.transition(creativeId, change.projectId, "PUBLISHED");
  if (creative.createdByTaskId) {
    await IdeaChatRepository.markCreativePublishState({
      taskId: creative.createdByTaskId,
      creativeId,
      publishState: "published",
      publishedAt: new Date(),
    }).catch(() => false);
  }
  await AuditLogRepository.record({
    workspaceId: change.workspaceId,
    projectId: change.projectId,
    actorType: userId ? "USER" : "SYSTEM",
    actorId: userId ?? undefined,
    action: "creative.marked_published",
    entityType: "Creative",
    entityId: creativeId,
    metadata: { via: "seo_apply" },
  }).catch(() => undefined);
}

async function closeArticleLoop(
  change: SeoChange,
  userId: string | null,
): Promise<void> {
  const params = paramsOf(change);
  const creativeId =
    change.creativeId ??
    (params && params.kind === "PUBLISH_LIVE" ? params.creativeId : null);
  if (!creativeId) return;

  const row = await prisma.seoAction.findFirst({
    where: {
      projectId: change.projectId,
      isMock: seoMockMode(),
      creativeId,
      kind: { in: ["NEW_CONTENT", "LOCALIZE"] },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (row) {
    const action = await getAction(change.projectId, row.id);
    if (
      action &&
      (action.status === "PROPOSED" || action.status === "ACCEPTED") &&
      (action.proposal.kind === "NEW_CONTENT" ||
        action.proposal.kind === "LOCALIZE")
    ) {
      if (change.liveUrl) {
        await updateProposal({
          projectId: change.projectId,
          actionId: action.id,
          proposal: { ...action.proposal, liveUrl: change.liveUrl },
          targetUrl: change.liveUrl,
        });
      }
      await applyAction(change, action.id, userId);
    }
  }
  await markCreativePublished(change, creativeId, userId);
}

export async function onChangeVerified(
  change: SeoChange,
  ctx: { userId: string | null },
): Promise<void> {
  if (!SeoActionFlags.loop()) return;
  try {
    const params = paramsOf(change);
    if (!params) return;

    if (params.kind === "PUBLISH_LIVE") {
      // Gerçek bir yayın olmayan (zaten yayında olan) değişiklik döngüyü kapatmaz.
      if (change.noop) return;
      await closeArticleLoop(change, ctx.userId);
      return;
    }
    if (!change.seoActionId) return;
    const action = await getAction(change.projectId, change.seoActionId);
    if (!action) return;

    if (params.kind === "TITLE_META") {
      if (action.proposal.kind === "TITLE_META") {
        // Uygulanan nihai metin öneriye yazılır (kullanıcı düzenlemiş olabilir).
        const after = {
          title: params.title ?? action.proposal.after?.title ?? "",
          metaDescription:
            params.metaDescription ??
            action.proposal.after?.metaDescription ??
            "",
        };
        await updateProposal({
          projectId: change.projectId,
          actionId: action.id,
          proposal: { ...action.proposal, after },
        });
      }
      await applyAction(change, action.id, ctx.userId);
      return;
    }

    if (params.kind === "INTERNAL_LINKS") {
      const proposalLinks = proposalLinksOf(action);
      if (proposalLinks.length === 0) return;
      const covered = await coveredLinkKeys(change.projectId, action.id);
      const complete = proposalLinks.every((link) =>
        covered.has(linkKey(link.fromUrl, link.toUrl)),
      );
      if (complete) await applyAction(change, action.id, ctx.userId);
    }
  } catch (error) {
    report("change could not be linked to its action", error);
  }
}

// Önerinin henüz VERIFIED değişikliklerle karşılanmamış bağlantıları.
export async function remainingLinksOf(
  projectId: string,
  actionId: string,
): Promise<{ fromUrl: string; toUrl: string; anchor: string }[]> {
  if (!SeoActionFlags.loop()) return [];
  try {
    const action = await getAction(projectId, actionId);
    if (!action) return [];
    const links = proposalLinksOf(action);
    if (links.length === 0) return [];
    const covered = await coveredLinkKeys(projectId, actionId);
    return links.filter((link) => !covered.has(linkKey(link.fromUrl, link.toUrl)));
  } catch (error) {
    report("remaining links could not be read", error);
    return [];
  }
}

// Geri alma: eylem hâlâ APPLIED ise uygulanmamış sayılır (ölçüm başladıysa
// geri sarılamaz; invalid_transition yutulur).
export async function onChangeUndone(
  change: SeoChange,
  ctx: { userId: string },
): Promise<void> {
  if (!SeoActionFlags.loop()) return;
  try {
    const params = paramsOf(change);
    if (!params) return;

    let actionId: string | null = change.seoActionId;
    if (params.kind === "PUBLISH_LIVE") {
      const creativeId = change.creativeId ?? params.creativeId;
      if (!creativeId) return;
      const row = await prisma.seoAction.findFirst({
        where: {
          projectId: change.projectId,
          isMock: seoMockMode(),
          creativeId,
          kind: { in: ["NEW_CONTENT", "LOCALIZE"] },
        },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      actionId = row?.id ?? null;
    }
    if (!actionId) return;
    const action = await getAction(change.projectId, actionId);
    if (!action || action.status !== "APPLIED") return;
    await transitionAction({
      projectId: change.projectId,
      actionId,
      event: "UNDO_APPLY",
      userId: ctx.userId,
    });
  } catch (error) {
    report("action could not be reverted", error);
  }
}
