import "server-only";

import { IdeaStatus, type Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import { deleteSlotPiecesInTx } from "./pieces";

// Search Console bağı silinirken (Disconnect, "Delete stored data", W1 bağ
// temizliği, 14 aylık saklama) aylık SEO içerik planının tablolar dışında
// kalan ürünleri (docs/search-content-plan.md "Gizlilik ve Limited Use").
// W3 fırsat motorunun öncülü gibi KALICI SİLER (forget.ts, SC-F4): planın
// BÜTÜN slotları (SKIPPED ve REMOVED dahil, hepsi ideaId/creativeId/postId'yi
// bu yüzden saklar) taranır; dokunulmamış slot parçaları (Creative + Post) ve
// plana ait fikirler silinir, yazılmış makaleler kullanıcının içeriğidir ve
// kalır. Sonra plan satırları silinir (cascade yalnız güvence ağı).
// SeoContentSetting Google verisi değildir: bağ silinince kalır, yalnız proje
// silinirken (ForProjects) gider. Bayraktan bağımsızdır, idempotenttir,
// işlemler plan başına küçüktür.

export type ForgetResult = {
  plans: number;
  slotsRemoved: number;
  ideas: number;
};

const ZERO: ForgetResult = { plans: 0, slotsRemoved: 0, ideas: 0 };

// Plan kanıtı: fikrin kanıt listesinde "/projects/<id>/arama#content-plan".
const PLAN_EVIDENCE_HASH = "#content-plan";

export type RawSlotRef = {
  id: string | null;
  status: string | null;
  creativeId: string | null;
  postId: string | null;
  ideaId: string | null;
  reusedIdea: boolean;
  prevIdeaStatus: string | null;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// SeoContentPlan.data.slots[] için gevşek okuyucu: yalnız silme/süpürme için
// gereken alanlar; bozuk bir slot bile ideaId/creativeId'si okunabildiği
// sürece taranır (parseContentPlanData bozuk slotu düşürürdü, parça artık
// kalırdı).
export function rawSlotsOf(data: Prisma.JsonValue | null): RawSlotRef[] {
  const slots = record(data)?.slots;
  if (!Array.isArray(slots)) return [];
  return slots.map((item) => {
    const slot = record(item) ?? {};
    return {
      id: text(slot.id),
      status: text(slot.status),
      creativeId: text(slot.creativeId),
      postId: text(slot.postId),
      ideaId: text(slot.ideaId),
      reusedIdea: slot.reusedIdea === true,
      prevIdeaStatus: text(slot.prevIdeaStatus),
    };
  });
}

// Slotta saklanan önceki durum gerçekten bir fikir durumu mu (bozuk JSON'a
// karşı).
export function ideaStatusOf(value: string | null): IdeaStatus | null {
  return (Object.values(IdeaStatus) as string[]).includes(value ?? "")
    ? (value as IdeaStatus)
    : null;
}

function isPlanEvidence(entry: unknown): boolean {
  const url = text(record(entry)?.url);
  if (!url) return false;
  try {
    return new URL(url).hash === PLAN_EVIDENCE_HASH;
  } catch {
    return url.endsWith(PLAN_EVIDENCE_HASH);
  }
}

// Yalnız plana ait kanıt girdisi çıkar; değişiklik yoksa null.
export function withoutPlanEvidence(
  concept: Prisma.JsonValue | null,
): Prisma.InputJsonValue | null {
  const rest = record(concept);
  if (!rest || !Array.isArray(rest.evidence)) return null;
  const kept = rest.evidence.filter((entry) => !isPlanEvidence(entry));
  if (kept.length === rest.evidence.length) return null;
  return { ...rest, evidence: kept } as Prisma.InputJsonValue;
}

async function forgetOnePlan(planId: string): Promise<ForgetResult> {
  const row = await prisma.seoContentPlan.findUnique({
    where: { id: planId },
    select: { id: true, projectId: true, data: true },
  });
  // Başka bir süreç silmiş: hata değil.
  if (!row) return { ...ZERO };
  const slots = rawSlotsOf(row.data);

  return prisma.$transaction(async (tx) => {
    const pieces = slots.flatMap((slot) =>
      slot.creativeId
        ? [{ creativeId: slot.creativeId, postId: slot.postId ?? "" }]
        : [],
    );
    const { deleted } = await deleteSlotPiecesInTx(tx, row.projectId, pieces);

    let ideas = 0;
    const ideaIds = [
      ...new Set(slots.flatMap((slot) => (slot.ideaId ? [slot.ideaId] : []))),
    ];
    if (ideaIds.length > 0) {
      const [ideaRows, writtenPosts] = await Promise.all([
        tx.idea.findMany({
          where: { id: { in: ideaIds }, projectId: row.projectId },
          select: { id: true, status: true, concept: true },
        }),
        // Yazılmış makale: fikre bağlı bir Post'un teslimatında sürüm var.
        tx.post.findMany({
          where: {
            projectId: row.projectId,
            ideaId: { in: ideaIds },
            deliveries: { some: { versions: { some: {} } } },
          },
          select: { ideaId: true },
        }),
      ]);
      const written = new Set(writtenPosts.map((post) => post.ideaId));
      const byId = new Map(ideaRows.map((idea) => [idea.id, idea] as const));

      const toDelete: string[] = [];
      const handled = new Set<string>();
      for (const slot of slots) {
        const ideaId = slot.ideaId;
        if (!ideaId || handled.has(ideaId)) continue;
        handled.add(ideaId);
        const idea = byId.get(ideaId);
        if (!idea) continue;
        const isWritten = written.has(ideaId);
        const searchBorn =
          record(idea.concept)?.source === "search" &&
          slot.prevIdeaStatus !== "APPROVED";
        // Plana ait fikir silinir; havuzdan alınmış fikir yalnız 'search'
        // kaynaklıysa ve kullanıcının onayladığı değilse. Yazılmış makaleye
        // bağlı fikir kalır (yalnız plan kanıtı çıkar).
        if (!isWritten && (!slot.reusedIdea || searchBorn)) {
          toDelete.push(ideaId);
          continue;
        }
        const concept = withoutPlanEvidence(idea.concept);
        const previous = ideaStatusOf(slot.prevIdeaStatus);
        const restore =
          slot.reusedIdea &&
          !isWritten &&
          idea.status === "PLANNING" &&
          previous !== null;
        if (!concept && !restore) continue;
        await tx.idea.update({
          where: { id: ideaId },
          data: {
            ...(concept ? { concept } : {}),
            ...(restore && previous ? { status: previous } : {}),
          },
        });
        ideas += 1;
      }
      if (toDelete.length > 0) {
        const result = await tx.idea.deleteMany({
          where: { id: { in: toDelete }, projectId: row.projectId },
        });
        ideas += result.count;
      }
    }

    await tx.seoContentPlan.deleteMany({ where: { id: row.id } });
    return { plans: 1, slotsRemoved: deleted.length, ideas };
  });
}

// Plan satırlarını (kimlikleriyle) unutur; retention.ts de bunu kullanır.
export async function forgetSeoContentPlanRows(
  planIds: readonly string[],
): Promise<ForgetResult> {
  const total: ForgetResult = { ...ZERO };
  for (const planId of new Set(planIds)) {
    const one = await forgetOnePlan(planId);
    total.plans += one.plans;
    total.slotsRemoved += one.slotsRemoved;
    total.ideas += one.ideas;
  }
  return total;
}

export async function forgetSeoContentPlansForLinks(
  linkIds: readonly string[],
): Promise<ForgetResult> {
  const links = [...new Set(linkIds)];
  if (links.length === 0) return { ...ZERO };
  const plans = await prisma.seoContentPlan.findMany({
    where: { linkId: { in: links } },
    select: { id: true },
  });
  return forgetSeoContentPlanRows(plans.map((plan) => plan.id));
}

export async function forgetSeoContentPlansForCredential(
  credentialId: string,
): Promise<ForgetResult> {
  const links = await prisma.gscSiteLink.findMany({
    where: { credentialId },
    select: { id: true },
  });
  return forgetSeoContentPlansForLinks(links.map((link) => link.id));
}

// Projenin bütün planları (iki kip); yalnız proje silinirken kullanılır, bu
// yüzden Google verisi olmayan sınır ayarı da gider.
export async function forgetSeoContentPlansForProjects(
  projectIds: readonly string[],
): Promise<ForgetResult> {
  const projects = [...new Set(projectIds)];
  if (projects.length === 0) return { ...ZERO };
  const plans = await prisma.seoContentPlan.findMany({
    where: { projectId: { in: projects } },
    select: { id: true },
  });
  const result = await forgetSeoContentPlanRows(plans.map((plan) => plan.id));
  await prisma.seoContentSetting.deleteMany({
    where: { projectId: { in: projects } },
  });
  return result;
}
