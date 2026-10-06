import "server-only";

import type { IdeaStatus, Prisma } from "@prisma/client";

import { IDEA_POOL_STATUSES } from "@/lib/idea-pool";
import { prisma } from "@/lib/prisma";
import { SEARCH_OPPORTUNITY_SIGNAL_SOURCE } from "@/lib/seo/opportunity-types";

// Search Console bağı silinirken (Disconnect, "Delete stored data", W1 bağ
// temizliği) fırsat motorunun tablolar dışında kalan ürünleri (docs/
// search-opportunities.md "Silme"): motorun sinyalleri (kaynak + payload.
// linkId) ve bulgulardan doğan fikirler (SeoFinding.ideaIds ya da kanıt
// bağlantısındaki opportunity=<bulgu>). Havuzda bekleyen (APPROVED olmayan)
// fikirler silinir; onaylanmış ya da planlanmış fikirler kalır, kanıtları
// çıkarılır. Bulgular, kümeler, embedding'ler ve motor durumu bağla birlikte
// cascade ile gider. Bayraktan bağımsızdır.

export type ForgetResult = { ideas: number; signals: number };

const DELETABLE_STATUSES: readonly IdeaStatus[] = IDEA_POOL_STATUSES.filter(
  (status) => status !== "APPROVED",
);

function conceptRecord(
  value: Prisma.JsonValue | null,
): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// Kanıt bağlantılarındaki opportunity=<id> değerleri; bozuk adres atlanır.
export function opportunityIdsOf(concept: Prisma.JsonValue | null): string[] {
  const evidence = conceptRecord(concept)?.evidence;
  if (!Array.isArray(evidence)) return [];
  const ids: string[] = [];
  for (const item of evidence) {
    if (!item || typeof item !== "object") continue;
    const url = (item as { url?: unknown }).url;
    if (typeof url !== "string") continue;
    try {
      const id = new URL(url).searchParams.get("opportunity");
      if (id) ids.push(id);
    } catch {
      // Okunamayan adres: bu fikir bu yoldan eşleşmez.
    }
  }
  return ids;
}

export async function forgetSearchOpportunitiesForLinks(
  linkIds: readonly string[],
): Promise<ForgetResult> {
  const links = [...new Set(linkIds)];
  if (links.length === 0) return { ideas: 0, signals: 0 };

  const findings = await prisma.seoFinding.findMany({
    where: { linkId: { in: links } },
    select: { id: true, projectId: true, ideaIds: true },
  });
  const findingIds = new Set(findings.map((row) => row.id));
  const projectIds = [...new Set(findings.map((row) => row.projectId))];
  const candidates = new Set(findings.flatMap((row) => row.ideaIds));

  if (projectIds.length > 0) {
    const seoIdeas = await prisma.idea.findMany({
      where: {
        projectId: { in: projectIds },
        AND: [
          { concept: { path: ["module"], equals: "seo" } },
          { concept: { path: ["source"], equals: "search" } },
        ],
      },
      select: { id: true, concept: true },
    });
    for (const idea of seoIdeas) {
      if (opportunityIdsOf(idea.concept).some((id) => findingIds.has(id))) {
        candidates.add(idea.id);
      }
    }
  }

  let ideas = 0;
  if (candidates.size > 0 && projectIds.length > 0) {
    const rows = await prisma.idea.findMany({
      where: { id: { in: [...candidates] }, projectId: { in: projectIds } },
      select: { id: true, status: true, concept: true },
    });
    const deletable = rows
      .filter((row) => DELETABLE_STATUSES.includes(row.status))
      .map((row) => row.id);
    if (deletable.length > 0) {
      const deleted = await prisma.idea.deleteMany({
        where: { id: { in: deletable } },
      });
      ideas += deleted.count;
    }
    for (const row of rows) {
      if (DELETABLE_STATUSES.includes(row.status)) continue;
      const concept = conceptRecord(row.concept);
      if (!concept || !("evidence" in concept)) continue;
      const rest: Record<string, unknown> = { ...concept };
      delete rest.evidence;
      await prisma.idea.update({
        where: { id: row.id },
        data: { concept: rest as Prisma.InputJsonValue },
      });
      ideas += 1;
    }
  }

  let signals = 0;
  for (const linkId of links) {
    const deleted = await prisma.signal.deleteMany({
      where: {
        source: SEARCH_OPPORTUNITY_SIGNAL_SOURCE,
        payload: { path: ["linkId"], equals: linkId },
      },
    });
    signals += deleted.count;
  }
  return { ideas, signals };
}

export async function forgetSearchOpportunitiesForCredential(
  credentialId: string,
): Promise<ForgetResult> {
  const links = await prisma.gscSiteLink.findMany({
    where: { credentialId },
    select: { id: true },
  });
  return forgetSearchOpportunitiesForLinks(links.map((link) => link.id));
}

// Projenin bütün bağları (iki kip); yalnız proje silinirken kullanılır.
export async function forgetSearchOpportunitiesForProjects(
  projectIds: readonly string[],
): Promise<ForgetResult> {
  if (projectIds.length === 0) return { ideas: 0, signals: 0 };
  const links = await prisma.gscSiteLink.findMany({
    where: { projectId: { in: [...projectIds] } },
    select: { id: true },
  });
  return forgetSearchOpportunitiesForLinks(links.map((link) => link.id));
}
