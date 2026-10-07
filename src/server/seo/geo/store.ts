import "server-only";

import { Prisma, type SeoGeoAudit } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { seoMockMode } from "@/lib/seo/health-flags";
import { rescore } from "@/lib/seo/geo/evaluate";
import {
  GEO_ACKNOWLEDGEABLE,
  isAcknowledgeable,
  isGeoCheckId,
  parseGeoResult,
  type GeoAuditResult,
  type GeoCheckId,
} from "@/lib/seo/geo/types";

// SeoGeoAudit kayıtları (SC-F8): site başına bir satır. Yalnız sitenin kendi
// verisi saklanır; GA ya da Search Console verisi yoktur. Satır bayatsa
// (kapsam anahtarı değişmişse) okuyucu null döner.

export type StoredRecommendations = {
  source: "ai" | "template";
  language: string | null;
  items: { checkId: string; text: string }[];
  at: string;
};

// Kabul edilen kontrol kimlikleri: yalnız bilinen ve kabul edilebilir olanlar.
export function validAcknowledged(value: unknown): GeoCheckId[] {
  if (!Array.isArray(value)) return [];
  return GEO_ACKNOWLEDGEABLE.filter((id) => value.includes(id));
}

export function parseRecommendations(
  value: unknown,
): StoredRecommendations | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.source !== "ai" && record.source !== "template") return null;
  if (!Array.isArray(record.items)) return null;
  const items: StoredRecommendations["items"] = [];
  for (const entry of record.items) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    if (isGeoCheckId(item.checkId) && typeof item.text === "string") {
      items.push({ checkId: item.checkId, text: item.text });
    }
  }
  return {
    source: record.source,
    language: typeof record.language === "string" ? record.language : null,
    items,
    at: typeof record.at === "string" ? record.at : "",
  };
}

// Geçerli kipin satırı; sitenin kapsam anahtarı denetimdekiyle farklıysa null.
export async function readGeoAudit(
  projectId: string,
): Promise<SeoGeoAudit | null> {
  const site = await prisma.seoSite.findUnique({
    where: { projectId_isMock: { projectId, isMock: seoMockMode() } },
    select: { id: true, scopeKey: true },
  });
  if (!site) return null;
  const audit = await prisma.seoGeoAudit.findUnique({
    where: { siteId: site.id },
  });
  if (!audit) return null;
  if ((audit.scopeKey ?? null) !== (site.scopeKey ?? null)) return null;
  return audit;
}

export type SaveGeoAuditInput = {
  siteId: string;
  workspaceId: string;
  projectId: string;
  isMock: boolean;
  scopeKey: string | null;
  result: GeoAuditResult;
  recommendations: StoredRecommendations | null;
  acknowledged: readonly GeoCheckId[];
  now: Date;
  nextAuditAt: Date;
  lastError: string | null;
};

// Sonucu yazar, kilidi bırakır; önceki puan bir önceki geçerli denetimden gelir.
export async function saveGeoAudit(input: SaveGeoAuditInput): Promise<void> {
  const existing = await prisma.seoGeoAudit.findUnique({
    where: { siteId: input.siteId },
    select: { score: true, auditedAt: true, result: true, acknowledged: true },
  });
  const hadResult = existing ? parseGeoResult(existing.result) !== null : false;
  // Denetim sürerken "I decided this" tıklanmış olabilir: kabul listesi kilit
  // anındaki kopya yerine satırın güncel değerinden alınır, puan ona göre yeniden
  // hesaplanır (kabul sessizce kaybolmasın).
  const acknowledged = existing
    ? validAcknowledged(existing.acknowledged)
    : [...input.acknowledged];
  const unchanged =
    acknowledged.length === input.acknowledged.length &&
    acknowledged.every((id) => input.acknowledged.includes(id));
  const finalResult = unchanged
    ? input.result
    : rescore(input.result, acknowledged);
  const result = finalResult as unknown as Prisma.InputJsonValue;
  const recommendations = input.recommendations
    ? (input.recommendations as unknown as Prisma.InputJsonValue)
    : Prisma.DbNull;
  const common = {
    scopeKey: input.scopeKey,
    score: finalResult.score,
    result,
    acknowledged: [...acknowledged],
    recommendations,
    auditedAt: input.now,
    nextAuditAt: input.nextAuditAt,
    leaseUntil: null,
    leaseOwner: null,
    lastError: input.lastError,
  };
  await prisma.seoGeoAudit.upsert({
    where: { siteId: input.siteId },
    create: {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      isMock: input.isMock,
      siteId: input.siteId,
      ...common,
    },
    update: {
      ...common,
      ...(hadResult && existing
        ? { previousScore: existing.score, previousAt: existing.auditedAt }
        : {}),
    },
  });
}

// Site boşaltılırken (SeoSites.resetSite ayrıca siler) ya da elle temizlenirken.
export async function forgetGeoAuditForSite(siteId: string): Promise<void> {
  await prisma.seoGeoAudit.deleteMany({ where: { siteId } });
}

// "I decided this": kabulü ekler ya da kaldırır, puanı yeni denetim olmadan
// rescore ile yeniden hesaplar. Denetim yoksa ya da bayatsa { ok: false }.
export async function setAcknowledged(
  projectId: string,
  checkId: GeoCheckId,
  on: boolean,
): Promise<{ ok: true; score: number | null } | { ok: false }> {
  if (!isAcknowledgeable(checkId)) return { ok: false };
  const audit = await readGeoAudit(projectId);
  if (!audit) return { ok: false };
  const parsed = parseGeoResult(audit.result);
  if (!parsed) return { ok: false };
  const current = new Set<GeoCheckId>(validAcknowledged(audit.acknowledged));
  if (on) current.add(checkId);
  else current.delete(checkId);
  const acknowledged = GEO_ACKNOWLEDGEABLE.filter((id) => current.has(id));
  const rescored = rescore(parsed, acknowledged);
  await prisma.seoGeoAudit.update({
    where: { id: audit.id },
    data: {
      acknowledged: [...acknowledged],
      score: rescored.score,
      result: rescored as unknown as Prisma.InputJsonValue,
    },
  });
  return { ok: true, score: rescored.score };
}
