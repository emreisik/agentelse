import "server-only";

import type { SeoChange } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { SeoActionFlags } from "@/lib/seo/action-flags";
import {
  applyMockMode,
  mockMatchesSite,
  seoApplyEnabledFor,
} from "@/lib/seo/apply/flags";
import type { ApplyOffer } from "@/lib/seo/apply/view-types";
import { loadCmsSite } from "@/server/integrations/wordpress/connection";

import {
  listApplyCandidates,
  remainingLinksOf,
  type ApplyCandidate,
} from "./action-link";

// "Apply with approval" tekliflerinin sunucu okuyucuları (docs/website-apply.md
// "Fırsatlar ve Actions & results"). Bayrak kapalıyken VERİTABANINA HİÇ
// gidilmez; açıkken önce tek CmsSite sorgusu yapılır (bağlantı yok ya da
// sağlıksızsa teklif de yoktur). Teklifler SC-F6 döngüsü açıkken vardır:
// eylem kaydı olmadan değişiklik eylemle ilişkilendirilemez.

type OfferKind = ApplyOffer["kind"];

function isOfferKind(value: string): value is OfferKind {
  return value === "TITLE_META" || value === "INTERNAL_LINKS";
}

// Bağlı ve sağlıklı site: yazma yapılabilir.
async function healthySite(projectId: string): Promise<boolean> {
  const site = await loadCmsSite(projectId);
  return (
    site !== null &&
    mockMatchesSite(applyMockMode(), site.isMock) &&
    (site.health === "OK" || site.health === "LIMITED")
  );
}

// Makale kartı ve takvim yuvaları için: sunucuda bir kez hesaplanır, istemci
// bileşenleri yalnız bu boole ile çizilir (ölü düğme ve istemci isteği yok).
export async function loadApplyReady(projectId: string): Promise<boolean> {
  if (!seoApplyEnabledFor(projectId)) return false;
  try {
    return await healthySite(projectId);
  } catch (error) {
    console.error(
      "[seo-apply] readiness could not be read:",
      error instanceof Error ? error.name : "unknown",
    );
    return false;
  }
}

async function changesByAction(
  projectId: string,
  actionIds: readonly string[],
): Promise<Map<string, SeoChange[]>> {
  const out = new Map<string, SeoChange[]>();
  if (actionIds.length === 0) return out;
  const rows = await prisma.seoChange.findMany({
    where: {
      projectId,
      isMock: applyMockMode(),
      seoActionId: { in: [...actionIds] },
      kind: { in: ["TITLE_META", "INTERNAL_LINKS"] },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  for (const row of rows) {
    if (!row.seoActionId) continue;
    const list = out.get(row.seoActionId) ?? [];
    list.push(row);
    out.set(row.seoActionId, list);
  }
  return out;
}

function baseOffer(candidate: ApplyCandidate): ApplyOffer {
  return {
    state: "ready",
    changeId: null,
    actionId: candidate.actionId,
    findingId: candidate.findingId,
    kind: candidate.kind,
    links: [],
    hint: null,
  };
}

// Tek eylem için teklif; null = gösterilecek bir şey yok.
async function offerOf(
  projectId: string,
  candidate: ApplyCandidate,
  changes: readonly SeoChange[],
): Promise<ApplyOffer | null> {
  const base = baseOffer(candidate);
  const open = changes.find((change) => change.openKey !== null);
  if (open) return { ...base, state: "pending", changeId: open.id };
  const verified = changes.find((change) => change.status === "VERIFIED");

  if (candidate.kind === "TITLE_META") {
    if (verified) return { ...base, state: "applied", changeId: verified.id };
    if (!candidate.after) return null;
    return candidate.status === "PROPOSED" || candidate.status === "ACCEPTED"
      ? base
      : null;
  }

  if (candidate.links.length === 0) return null;
  const remaining = await remainingLinksOf(projectId, candidate.actionId);
  if (remaining.length === 0) {
    return verified
      ? { ...base, state: "applied", changeId: verified.id }
      : null;
  }
  return candidate.status === "PROPOSED" || candidate.status === "ACCEPTED"
    ? { ...base, links: remaining }
    : null;
}

async function offersFor(
  projectId: string,
  candidates: readonly ApplyCandidate[],
): Promise<Map<string, ApplyOffer>> {
  const changes = await changesByAction(
    projectId,
    candidates.map((candidate) => candidate.actionId),
  );
  const out = new Map<string, ApplyOffer>();
  for (const candidate of candidates) {
    const offer = await offerOf(
      projectId,
      candidate,
      changes.get(candidate.actionId) ?? [],
    );
    if (offer) out.set(candidate.actionId, offer);
  }
  return out;
}

// Fırsat kartları: bulgu kimliği -> teklif. Bulguya bağlı eylem yoksa yalnız
// INTERNAL_LINKS için "ready" teklif verilir (düğme eylemi kendisi kurar);
// metni henüz seçilmemiş TITLE_META bulgusu "Fix this" ile kalır.
export async function loadApplyOffersForFindings(
  projectId: string,
  items: readonly { id: string; actionKind: string }[],
): Promise<Record<string, ApplyOffer>> {
  if (!seoApplyEnabledFor(projectId) || !SeoActionFlags.loop()) return {};
  const wanted = items.filter((item) => isOfferKind(item.actionKind));
  if (wanted.length === 0) return {};
  try {
    if (!(await healthySite(projectId))) return {};
    const candidates = await listApplyCandidates(projectId, {
      findingIds: wanted.map((item) => item.id),
    });
    const offers = await offersFor(projectId, candidates);

    const result: Record<string, ApplyOffer> = {};
    for (const item of wanted) {
      const mine = candidates.filter(
        (candidate) => candidate.findingId === item.id,
      );
      if (mine.length === 0) {
        if (item.actionKind === "INTERNAL_LINKS") {
          result[item.id] = {
            state: "ready",
            changeId: null,
            actionId: null,
            findingId: item.id,
            kind: "INTERNAL_LINKS",
            links: [],
            hint: null,
          };
        }
        continue;
      }
      for (const candidate of mine) {
        const offer = offers.get(candidate.actionId);
        if (offer) {
          result[item.id] = offer;
          break;
        }
      }
    }
    return result;
  } catch (error) {
    console.error(
      "[seo-apply] finding offers could not be read:",
      error instanceof Error ? error.name : "unknown",
    );
    return {};
  }
}

// Actions & results listesi: eylem kimliği -> teklif.
export async function loadApplyOffersForActions(
  projectId: string,
  actionIds: readonly string[],
): Promise<Record<string, ApplyOffer>> {
  if (!seoApplyEnabledFor(projectId) || !SeoActionFlags.loop()) return {};
  if (actionIds.length === 0) return {};
  try {
    if (!(await healthySite(projectId))) return {};
    const candidates = await listApplyCandidates(projectId, { actionIds });
    return Object.fromEntries(await offersFor(projectId, candidates));
  } catch (error) {
    console.error(
      "[seo-apply] action offers could not be read:",
      error instanceof Error ? error.name : "unknown",
    );
    return {};
  }
}
