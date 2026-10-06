import "server-only";

import type { GscSiteLink } from "@prisma/client";

import { appUrl } from "@/lib/app-url";
import { prisma } from "@/lib/prisma";
import {
  isSeoRuleKey,
  SEARCH_OPPORTUNITY_SIGNAL_SOURCE,
} from "@/lib/seo/opportunity-types";
import { SEO_SIGNAL_TEXT } from "@/lib/seo/rules/copy";
import { currentPeriodFilter } from "@/lib/seo/rules/fingerprint";
import { SignalUniverse } from "@/server/agency/signals/signal-universe";

import { setFindingOutputs } from "./findings-store";

// SC-F4 sinyalleri (docs/search-opportunities.md "Brand Brain ve fikirler"):
// bağın bu dönemdeki açık, gölge olmayan ve sinyale değer (SO3, SO6, SO7
// sayfa, SO9, SO10, SO13) bulgularından dönem başına en çok 3'ü Brand Brain'e
// genel sinyal olur. Başlık ve özet kuralın sabit İngilizce metnidir: sayı,
// sorgu, yol ya da adres taşımaz (sinyal içgörü → görev → Telegram yolunu
// izler, Limited Use). externalRef uygulama içi tarihli bağlantıdır. Bulgular
// oluşturulan satırlardan değil veritabanından okunur: çıktısı atlanmış bir
// koşu sonraki koşuda tamamlanır. Önceki haftadan taşınan signalId'li bulgu
// yeniden sinyal olmaz.

export const SIGNALS_PER_WEEK = 3;

const RELIABILITY_SIGNIFICANT = 1;
const RELIABILITY_DIRECTIONAL = 0.6;

export function opportunitySignalRef(
  projectId: string,
  findingId: string,
): string {
  return appUrl(
    `/projects/${projectId}/arama?opportunity=${findingId}#opportunities`,
  ).toString();
}

export async function ingestOpportunitySignals(input: {
  link: Pick<GscSiteLink, "id" | "projectId" | "workspaceId">;
  periodKey: string;
  now: Date;
}): Promise<number> {
  const { link, periodKey, now } = input;
  const ruleKeys = Object.keys(SEO_SIGNAL_TEXT);
  if (ruleKeys.length === 0) return 0;
  const existing = await prisma.signal.count({
    where: {
      projectId: link.projectId,
      source: SEARCH_OPPORTUNITY_SIGNAL_SOURCE,
      AND: [
        { payload: { path: ["linkId"], equals: link.id } },
        { payload: { path: ["periodKey"], equals: periodKey } },
      ],
    },
  });
  const room = SIGNALS_PER_WEEK - existing;
  if (room <= 0) return 0;

  const rows = await prisma.seoFinding.findMany({
    where: {
      linkId: link.id,
      ...currentPeriodFilter(periodKey),
      status: "OPEN",
      shadow: false,
      signalWorthy: true,
      signalId: null,
      ruleKey: { in: ruleKeys },
    },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
    take: room,
    select: { id: true, ruleKey: true, confidence: true },
  });
  if (rows.length === 0) return 0;

  const brand = await prisma.brand.findFirst({
    where: { projectId: link.projectId, isDefault: true },
    select: { id: true },
  });
  if (!brand) return 0;

  let ingested = 0;
  for (const row of rows) {
    if (!isSeoRuleKey(row.ruleKey)) continue;
    const text = SEO_SIGNAL_TEXT[row.ruleKey];
    if (!text) continue;
    const result = await SignalUniverse.ingestRaw({
      workspaceId: link.workspaceId,
      projectId: link.projectId,
      brandId: brand.id,
      source: SEARCH_OPPORTUNITY_SIGNAL_SOURCE,
      category: "SEO",
      externalRef: opportunitySignalRef(link.projectId, row.id),
      title: text.title,
      summary: text.summary,
      payload: {
        linkId: link.id,
        findingId: row.id,
        ruleKey: row.ruleKey,
        periodKey,
      },
      occurredAt: now,
      reliability:
        row.confidence === "SIGNIFICANT"
          ? RELIABILITY_SIGNIFICANT
          : RELIABILITY_DIRECTIONAL,
    });
    // Aynı bulgunun eski sinyali (yarıda kalan koşu) de bağlanır ki her
    // koşuda yeniden denenmesin; yalnız yeni sinyal sayılır.
    const signalId = result.duplicate ? result.existingId : result.signal.id;
    await setFindingOutputs(row.id, { signalId });
    if (!result.duplicate) ingested += 1;
  }
  return ingested;
}
