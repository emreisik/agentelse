import "server-only";

import { prisma } from "@/lib/prisma";
import {
  findingConfidenceText,
  findingDetail,
  findingFacts,
  findingImpactText,
  findingPeriodText,
  findingTitle,
} from "@/lib/website-analytics/analysis/describe";
import { gaInsightsModeFor } from "@/lib/website-analytics/analysis/flags";
import type { GaFindingView } from "@/lib/website-analytics/analysis/view-types";
import {
  allowedNumbersOf,
  keepSupportedSentences,
  numberTokens,
} from "@/lib/module-flows/analytics/number-check";
import { cleanWorksTextOrNull } from "@/lib/works/clean-text";
import { limitNoticeFromError } from "@/server/commands/limit-notice";
import { gaFindingsExplainDef } from "@/server/reasoning/prompts/ga-findings-explain";
import { ReasoningService } from "@/server/reasoning/reasoning-service";

import { findingViewOf } from "./read";

// GA-F4 bulgularının haftalık LLM açıklaması (docs/website-insights.md "LLM"):
// canlı, gerçek (mock olmayan), açık ve henüz açıklanmamış son 8 günün en
// öncelikli 5 bulgusu tek çağrıda açıklanır ve sıralanır. Modele yalnız
// toplulaştırılmış sayılar ve en çok 20 maskelenmiş yol / arama sözcüğü gider
// (Limited Use). Her açıklama temizlenir ve bulgunun kendi verisinde olmayan
// sayıyı anan cümleler atılır. Mock modda hiçbir şey saklanmaz. Asla atmaz.

export const GA_EXPLAIN_MAX_FINDINGS = 5;
export const GA_EXPLAIN_MAX_STRINGS = 20;

const EXPLANATION_MAX = 400;
const LOOKBACK_MS = 8 * 24 * 3_600_000;

type ExplainFinding = {
  ref: string;
  title: string;
  detail: string;
  impact: string | null;
  confidence: string;
  period: string;
  facts: Record<string, unknown>;
};

// Sayıdan ibaret olmayan metin (yol, arama sözcüğü, kampanya, sayfa adı).
// "1,234" ya da "12.5%" sayılmaz; kuşkulu durumda sayılır (az bulgu güvenli).
function isGoogleString(value: string): boolean {
  let rest = value;
  for (const token of numberTokens(value)) rest = rest.replace(token, "");
  return /[\p{L}/]/u.test(rest);
}

function collectStrings(value: unknown, into: Set<string>): void {
  if (typeof value === "string") {
    const text = value.trim();
    if (text && isGoogleString(text)) into.add(text);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, into);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, into);
  }
}

function googleStringsOf(findings: readonly ExplainFinding[]): number {
  const strings = new Set<string>();
  for (const finding of findings) collectStrings(finding.facts, strings);
  return strings.size;
}

export function explainContextOf(
  views: readonly GaFindingView[],
  currency: string | null,
): {
  context: { findings: ExplainFinding[] };
  refs: Map<string, string>;
  googleStrings: number;
} {
  // Öncelik sırası; eşitlikte gelen sıra korunur.
  const ranked = views
    .map((view, index) => ({ view, index }))
    .sort((a, b) => b.view.priority - a.view.priority || a.index - b.index)
    .slice(0, GA_EXPLAIN_MAX_FINDINGS)
    .map(({ view }) => view);
  const options = { currency };
  const described = ranked.map((view) => ({
    id: view.id,
    finding: {
      ref: "",
      title: findingTitle(view),
      detail: findingDetail(view, options),
      impact: findingImpactText(view.impact, options),
      confidence: findingConfidenceText(view.confidence),
      period: findingPeriodText(view.period),
      facts: findingFacts(view, options),
    } satisfies ExplainFinding,
  }));
  // Dize bütçesi aşıldıkça en düşük öncelikli bulgu çıkar.
  while (
    described.length > 0 &&
    googleStringsOf(described.map((entry) => entry.finding)) >
      GA_EXPLAIN_MAX_STRINGS
  ) {
    described.pop();
  }
  const refs = new Map<string, string>();
  const findings = described.map((entry, index) => {
    const ref = `f${index + 1}`;
    refs.set(ref, entry.id);
    return { ...entry.finding, ref };
  });
  return {
    context: { findings },
    refs,
    googleStrings: googleStringsOf(findings),
  };
}

type ExplainResult = {
  explained: number;
  skipped: "mock" | "budget" | "none" | "error" | null;
};

export async function explainTopFindings(input: {
  linkId: string;
  projectId: string;
  workspaceId: string;
  brandId: string;
  currency: string | null;
  now: Date;
}): Promise<ExplainResult> {
  try {
    if (gaInsightsModeFor(input.projectId) !== "on") {
      return { explained: 0, skipped: "none" };
    }
    const rows = await prisma.gaFinding.findMany({
      where: {
        linkId: input.linkId,
        mode: "live",
        isMock: false,
        status: "OPEN",
        explanation: null,
        createdAt: { gte: new Date(input.now.getTime() - LOOKBACK_MS) },
      },
      orderBy: { priority: "desc" },
      take: GA_EXPLAIN_MAX_FINDINGS,
    });
    if (rows.length === 0) return { explained: 0, skipped: "none" };
    // Sahte yanıt hiçbir zaman gerçek açıklama olarak saklanmaz.
    if (ReasoningService.isMockMode()) {
      return { explained: 0, skipped: "mock" };
    }
    const views = rows
      .map((row) => findingViewOf(row))
      .filter((view): view is GaFindingView => view !== null);
    const { context, refs } = explainContextOf(views, input.currency);
    if (context.findings.length === 0) {
      return { explained: 0, skipped: "none" };
    }

    const { output } = await ReasoningService.run(gaFindingsExplainDef, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      brandId: input.brandId,
      context,
    });

    const factsByRef = new Map(
      context.findings.map((finding) => [finding.ref, finding.facts]),
    );
    const updates = new Map<
      string,
      { explanation?: string; explainedAt?: Date; rank?: number }
    >();
    for (const item of output.items) {
      const findingId = refs.get(item.ref);
      if (!findingId || updates.get(findingId)?.explanation) continue;
      const text = cleanWorksTextOrNull(item.explanation, EXPLANATION_MAX);
      if (!text) continue;
      const checked = keepSupportedSentences(
        text,
        allowedNumbersOf(factsByRef.get(item.ref) ?? {}),
      );
      if (!checked) continue;
      updates.set(findingId, { explanation: checked, explainedAt: input.now });
    }
    // Sıra: yalnız bilinen ref'ler, tekrarsız; listelenmeyen bulgu sırasız kalır.
    const ordered: string[] = [];
    for (const ref of output.order) {
      const findingId = refs.get(ref);
      if (findingId && !ordered.includes(findingId)) ordered.push(findingId);
    }
    ordered.forEach((findingId, index) => {
      updates.set(findingId, { ...updates.get(findingId), rank: index + 1 });
    });

    let explained = 0;
    for (const [id, data] of updates) {
      await prisma.gaFinding.update({ where: { id }, data });
      if (data.explanation) explained += 1;
    }
    return { explained, skipped: null };
  } catch (error) {
    if (limitNoticeFromError(error)) return { explained: 0, skipped: "budget" };
    console.warn("[ga-explain] failed");
    return { explained: 0, skipped: "error" };
  }
}
