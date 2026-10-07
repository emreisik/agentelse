import "server-only";

import { prisma } from "@/lib/prisma";
import {
  SeoActionFlags,
  seoActionsRestrictedProjects,
} from "@/lib/seo/action-flags";
import { MIN_CONTROLS } from "@/lib/seo/actions/did";
import { learningInsight } from "@/lib/seo/actions/copy";
import type {
  DidMetric,
  SeoActionView,
  SeoFixKind,
} from "@/lib/seo/actions/types";

import { actionViewOf } from "./store";

// SEO eylem öğrenmeleri (docs/search-actions.md "Öğrenmeler"; GA-F4 ve Meta
// Ads öncülleriyle aynı kalıp): BrandLearning yalnız kapıyı geçen WORKED
// sonuçtan yazılır. DIDNT hiç öğrenme yazmaz: "şunu yapma" metni yanıltıcı
// içerik rehberi olurdu. Metin şablondur ve rakam, yol, sorgu ya da adres
// taşımaz; sayılar yalnız SeoAction.evaluation'da kalır. Aynı eylem iki kez
// yazılmaz (sourceRef = eylem kimliği).

export const SEO_LEARNING_SOURCE = "SEO";

export const LEARNING_KINDS: readonly SeoFixKind[] = [
  "TITLE_META",
  "CONTENT_REFRESH",
  "INTERNAL_LINKS",
  "SCHEMA",
  "CONSOLIDATE",
  "TECH_FIX",
];

const STRONG_LOW = 0.1;
const CONFIDENCE_STRONG = 0.8;
const CONFIDENCE_DEFAULT = 0.6;
const RECENT_DAYS = 30;
const DAY_MS = 86_400_000;
const WRITE_FETCH_FACTOR = 3;
const DID_METRICS: readonly string[] = ["ctr_adj", "clicks", "impressions"];

function didMetricOf(
  evaluation: NonNullable<SeoActionView["evaluation"]>,
): DidMetric | null {
  return DID_METRICS.includes(evaluation.metric ?? "")
    ? (evaluation.metric as DidMetric)
    : null;
}

// Kapı: WORKED + SIGNIFICANT + kontrol gruplu DID (≥ 3 kontrol) + örtüşen
// güncelleme yok + gerçek (mock değil) + öğrenme türü.
export function learningGate(
  action: Pick<
    SeoActionView,
    "kind" | "outcome" | "confidence" | "evaluation" | "isMock"
  >,
): boolean {
  const evaluation = action.evaluation;
  return (
    action.outcome === "WORKED" &&
    action.confidence === "SIGNIFICANT" &&
    !action.isMock &&
    LEARNING_KINDS.includes(action.kind) &&
    evaluation !== null &&
    evaluation.method === "DID" &&
    evaluation.controls >= MIN_CONTROLS &&
    evaluation.updates.length === 0 &&
    didMetricOf(evaluation) !== null
  );
}

export const SeoLearnings = {
  async writeFor(actionId: string, now: Date = new Date()): Promise<boolean> {
    const row = await prisma.seoAction.findUnique({ where: { id: actionId } });
    if (!row || row.status !== "WORKED" || row.learningId) return false;
    const action = actionViewOf(row);
    if (!learningGate(action) || !action.evaluation) return false;
    const metric = didMetricOf(action.evaluation);
    if (!metric) return false;

    // sourceType başka servislerce yeniden yazılabilir: yalnız sourceRef.
    const exists = await prisma.brandLearning.findFirst({
      where: { sourceRef: action.id },
      select: { id: true },
    });
    if (exists) return false;
    const brand = await prisma.brand.findFirst({
      where: { projectId: action.projectId, isDefault: true },
      select: { id: true },
    });
    if (!brand) return false;

    const low = action.evaluation.low;
    const learning = await prisma.brandLearning.create({
      data: {
        workspaceId: action.workspaceId,
        projectId: action.projectId,
        brandId: brand.id,
        insight: learningInsight({ kind: action.kind, metric }),
        sourceType: SEO_LEARNING_SOURCE,
        sourceRef: action.id,
        confidence:
          low !== null && low >= STRONG_LOW
            ? CONFIDENCE_STRONG
            : CONFIDENCE_DEFAULT,
        polarity: "WORKS",
        evidenceCount: 1,
        lastReinforcedAt: now,
      },
      select: { id: true },
    });
    await prisma.seoAction.update({
      where: { id: action.id },
      data: { learningId: learning.id },
    });
    return true;
  },

  // Tick adımı: son 30 günde sonuçlanıp öğrenmesi yazılmamış eylemler.
  async writeDue(now: Date = new Date(), limit = 20): Promise<number> {
    if (!SeoActionFlags.loop()) return 0;
    const restricted = seoActionsRestrictedProjects();
    if (restricted && restricted.length === 0) return 0;
    const rows = await prisma.seoAction.findMany({
      where: {
        status: "WORKED",
        learningId: null,
        isMock: false,
        confidence: "SIGNIFICANT",
        kind: { in: [...LEARNING_KINDS] },
        evaluation: { path: ["method"], equals: "DID" },
        evaluatedAt: { gt: new Date(now.getTime() - RECENT_DAYS * DAY_MS) },
        ...(restricted ? { projectId: { in: restricted } } : {}),
      },
      orderBy: { evaluatedAt: "desc" },
      take: limit * WRITE_FETCH_FACTOR,
      select: { id: true },
    });
    let written = 0;
    for (const row of rows) {
      if (written >= limit) break;
      if (await this.writeFor(row.id, now)) written += 1;
    }
    return written;
  },
};

// Prompt satırları için en yeni SEO öğrenmeleri (en çok `limit`). Bayrak
// kapalıyken veritabanına gidilmez.
export async function readSeoLearnings(
  projectId: string,
  limit = 5,
): Promise<string[]> {
  if (!SeoActionFlags.manager()) return [];
  const rows = await prisma.brandLearning.findMany({
    where: { projectId, sourceType: SEO_LEARNING_SOURCE, polarity: "WORKS" },
    orderBy: { createdAt: "desc" },
    take: Math.max(1, Math.min(limit, 10)),
    select: { insight: true },
  });
  return rows.map((row) => row.insight);
}
