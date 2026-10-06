import "server-only";

import type { GscSiteLink, Prisma, SeoEngineState } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { parseCtrCurve, priorCurve, type CtrCurve } from "@/lib/seo/ctr-curve";
import { SeoInsightFlags } from "@/lib/seo/insight-flags";
import { primaryGscLink } from "@/server/seo/store";

// SEO fırsat motorunun bağ başına durumu (docs/search-opportunities.md
// "Zamanlama"): 10 dakikalık CAS kilidi, 6 saatlik yoklama, koşu başına 60 sn
// süre; CTR eğrileri, son koşu sayaçları ve marka terimi önerileri aynı
// satırdadır (SeoEngineState, GscSiteLink'e cascade'li).

export const ENGINE_LEASE_MS = 600_000;
export const ENGINE_RECHECK_MS = 21_600_000;
export const ENGINE_RUN_BUDGET_MS = 60_000;
export const ENGINE_CONTINUE_MS = 120_000;
export const OUTPUTS_MIN_REMAINING_MS = 20_000;

export type SeoCurves = { nonBrand: CtrCurve; brand: CtrCurve };

export async function ensureEngineState(
  link: Pick<GscSiteLink, "id" | "projectId" | "workspaceId" | "isMock">,
): Promise<SeoEngineState> {
  try {
    return await prisma.seoEngineState.upsert({
      where: { linkId: link.id },
      create: {
        linkId: link.id,
        workspaceId: link.workspaceId,
        projectId: link.projectId,
        isMock: link.isMock,
      },
      update: {},
    });
  } catch (error) {
    // İki süreç aynı anda oluşturdu: satır var.
    const existing = await prisma.seoEngineState.findUnique({
      where: { linkId: link.id },
    });
    if (!existing) throw error;
    return existing;
  }
}

export async function claimEngineLease(
  stateId: string,
  owner: string,
  now: Date,
): Promise<boolean> {
  const claimed = await prisma.seoEngineState.updateMany({
    where: {
      id: stateId,
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
    },
    data: {
      leaseUntil: new Date(now.getTime() + ENGINE_LEASE_MS),
      leaseOwner: owner,
    },
  });
  return claimed.count === 1;
}

// Yalnız kilidin sahibi bırakır (süresi dolup başkası aldıysa yazılmaz).
export async function releaseEngineLease(
  stateId: string,
  owner: string,
  data: Prisma.SeoEngineStateUpdateManyMutationInput,
): Promise<void> {
  await prisma.seoEngineState.updateMany({
    where: { id: stateId, leaseOwner: owner },
    data: { ...data, leaseUntil: null, leaseOwner: null },
  });
}

// Çalıştırılamayan aday (proje ACTIVE değil ya da kademeli açılışta değil):
// yoklama zamanı ileri alınır ki en eski güncellenen bağlar sıradaki 6 aday
// yerini sürekli tutup uygun bağları aç bırakmasın. Kilit alanlarına dokunmaz.
export async function deferEngineState(
  link: Pick<GscSiteLink, "id" | "projectId" | "workspaceId" | "isMock">,
  nextRunAt: Date,
): Promise<void> {
  await prisma.seoEngineState
    .upsert({
      where: { linkId: link.id },
      create: {
        linkId: link.id,
        workspaceId: link.workspaceId,
        projectId: link.projectId,
        isMock: link.isMock,
        nextRunAt,
      },
      update: { nextRunAt },
    })
    .catch(() =>
      // İki süreç aynı anda oluşturdu: satır var, güncellemek yeterli.
      prisma.seoEngineState.updateMany({
        where: { linkId: link.id },
        data: { nextRunAt },
      }),
    );
}

// Çıktı adımları (açıklama haftası, marka önerileri) için.
export async function updateEngineState(
  linkId: string,
  data: Prisma.SeoEngineStateUpdateManyMutationInput,
): Promise<void> {
  await prisma.seoEngineState.updateMany({ where: { linkId }, data });
}

export async function readEngineState(
  linkId: string,
): Promise<SeoEngineState | null> {
  return prisma.seoEngineState.findUnique({ where: { linkId } });
}

// Saklanan { nonBrand, brand } eğrileri; okunamayan taraf kamuya açık
// önsele düşer.
export function parseSeoCurves(value: unknown): SeoCurves {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    nonBrand: parseCtrCurve(record.nonBrand) ?? priorCurve("non-brand"),
    brand: parseCtrCurve(record.brand) ?? priorCurve("brand"),
  };
}

// SEO Manager quick wins ve sohbet araçları için. Bayrak kapalıyken
// veritabanına gidilmez.
export async function readSeoCurves(
  projectId: string,
): Promise<SeoCurves | null> {
  if (!SeoInsightFlags.active()) return null;
  const link = await primaryGscLink(projectId);
  if (!link) return null;
  const state = await prisma.seoEngineState.findUnique({
    where: { linkId: link.id },
    select: { curves: true },
  });
  return parseSeoCurves(state?.curves ?? null);
}
