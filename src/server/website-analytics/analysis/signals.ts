import "server-only";

import type { SignalCategory } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { findingSignalText } from "@/lib/website-analytics/analysis/describe";
import { gaSignalExternalRef } from "@/lib/website-analytics/analysis/keys";
import type { GaFindingView } from "@/lib/website-analytics/analysis/view-types";
import { dayKeyToDate } from "@/lib/website-analytics/days";
import { SignalUniverse } from "@/server/agency/signals/signal-universe";

import { findingViewOf } from "./read";

// GA-F4 sinyalleri (docs/website-insights.md "Sinyaller"): yalnız canlı,
// mock olmayan ve stratejik bulgular Brand Brain'e sinyal olur: SIGNIFICANT
// AN2 değişimi, SIGNIFICANT AN3 "promote" ve AN7 (yapay zekâ asistanları).
// Metin yol, terim, kampanya adı ve sayı taşımaz: sinyal ajans bulgusu,
// içgörü, fırsat ve göreve dönüşür, görev başlıkları Telegram'a ulaşır.

export const GA_INSIGHT_SIGNAL_SOURCE = "ga-insights";

const RELIABILITY_SIGNIFICANT = 0.9;
const RELIABILITY_DIRECTIONAL = 0.6;

function categoryOf(view: GaFindingView): SignalCategory | null {
  const evidence = view.evidence;
  if (evidence.rule === "AN7") return "SEO";
  if (view.confidence !== "SIGNIFICANT") return null;
  if (evidence.rule === "AN2") {
    return evidence.channels.components[0]?.key === "Organic Search"
      ? "SEO"
      : "PERFORMANCE";
  }
  if (evidence.rule === "AN3" && evidence.variant === "promote") {
    return "PERFORMANCE";
  }
  return null;
}

export async function ingestFindingSignals(input: {
  findingIds: readonly string[];
  now: Date;
}): Promise<number> {
  if (input.findingIds.length === 0) return 0;
  const rows = await prisma.gaFinding.findMany({
    where: {
      id: { in: [...input.findingIds] },
      mode: "live",
      isMock: false,
      status: "OPEN",
      signalId: null,
      ruleKey: { in: ["AN2", "AN3", "AN7"] },
    },
  });
  const brands = new Map<string, string | null>();
  let ingested = 0;
  for (const row of rows) {
    const view = findingViewOf(row);
    if (!view) continue;
    const category = categoryOf(view);
    if (!category) continue;
    if (!brands.has(row.projectId)) {
      const brand = await prisma.brand.findFirst({
        where: { projectId: row.projectId, isDefault: true },
        select: { id: true },
      });
      brands.set(row.projectId, brand?.id ?? null);
    }
    const brandId = brands.get(row.projectId);
    if (!brandId) continue;

    const text = findingSignalText(view);
    const result = await SignalUniverse.ingestRaw({
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      brandId,
      source: GA_INSIGHT_SIGNAL_SOURCE,
      category,
      externalRef: gaSignalExternalRef({
        linkId: row.linkId,
        ruleKey: view.ruleKey,
        subjectKey: row.subjectKey,
        periodEnd: view.period.to,
      }),
      title: text.title,
      summary: text.summary,
      payload: {
        findingId: row.id,
        ruleKey: view.ruleKey,
        kind: view.kind,
        confidence: view.confidence,
        periodKey: view.period.key,
      },
      occurredAt: dayKeyToDate(view.period.to),
      reliability:
        view.confidence === "SIGNIFICANT"
          ? RELIABILITY_SIGNIFICANT
          : RELIABILITY_DIRECTIONAL,
    });
    const signalId = result.duplicate ? result.existingId : result.signal.id;
    await prisma.gaFinding.update({
      where: { id: row.id },
      data: { signalId },
    });
    if (!result.duplicate) ingested += 1;
  }
  return ingested;
}
