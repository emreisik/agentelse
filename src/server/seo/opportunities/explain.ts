import "server-only";

import type { GscSiteLink } from "@prisma/client";

import {
  allowedNumbersOf,
  keepSupportedSentences,
} from "@/lib/module-flows/analytics/number-check";
import { prisma } from "@/lib/prisma";
import { addDays } from "@/lib/seo/dates";
import { limitGoogleStrings } from "@/lib/seo/llm-budget";
import type {
  DecayCause,
  SeoActionKind,
  SeoConfidence,
  SeoImpact,
} from "@/lib/seo/opportunity-types";
import { SEO_RULE_LABEL } from "@/lib/seo/rules/copy";
import { currentPeriodFilter } from "@/lib/seo/rules/fingerprint";
import { cleanWorksTextOrNull } from "@/lib/works/clean-text";
import { seoOpportunityExplainDef } from "@/server/reasoning/prompts/seo-opportunity-explain";
import { ReasoningService } from "@/server/reasoning/reasoning-service";
import { isAgentelseError } from "@/server/security/errors";

import { scopeForProject } from "./classify";
import {
  findingViewOf,
  setFindingOutputs,
  type SeoFindingView,
} from "./findings-store";
import { readEngineState, updateEngineState } from "./state";

// SC-F4 bulgularının haftalık LLM açıklaması (docs/search-opportunities.md
// "LLM kullanımı ve Limited Use"): bağın bu haftaki açık, gölge olmayan ve
// henüz açıklanmamış en öncelikli 5 bulgusu tek çağrıda açıklanır. Modele
// yalnız kural adı, eylem türü, sayılar ve en çok 20 farklı maskelenmiş sorgu
// ve yol gider (limitGoogleStrings). Her açıklama temizlenir; bulgunun kendi
// verisinde olmayan sayıyı (oranların yüzde biçimleri dahil) anan cümle
// atılır, hiçbir cümle kalmazsa açıklama yazılmaz. Mock modda hiçbir şey
// saklanmaz ama hafta yine "açıklandı" sayılır (summarizeReport kalıbı).

export const EXPLAIN_PER_WEEK = 5;

const EXPLANATION_MAX = 400;
const FIRST_STEP_MAX = 200;
const FACT_QUERIES = 10;
const FACT_PAGES = 10;

export type ExplainFact = {
  id: string;
  rule: string;
  action: SeoActionKind;
  confidence: SeoConfidence;
  // Kanıtın sayıları + "Ctr"/"Share" ile biten kesirlerin "<anahtar>Pct"
  // yüzde biçimi (1 ondalık).
  metrics: Record<string, number>;
  impact: SeoImpact | null;
  queries: string[];
  pages: string[];
  cause: DecayCause | null;
};

function withPercents(metrics: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(metrics)) {
    if (!Number.isFinite(value)) continue;
    out[key] = value;
    if (/(Ctr|Share)$/.test(key)) {
      out[`${key}Pct`] = Math.round(value * 1000) / 10;
    }
  }
  return out;
}

function distinct(values: readonly string[], limit: number): string[] {
  const out: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (!value || out.includes(value)) continue;
    out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}

function factOf(view: SeoFindingView): ExplainFact {
  const evidence = view.evidence;
  return {
    id: view.id,
    rule: SEO_RULE_LABEL[view.ruleKey],
    action: view.actionKind,
    confidence: view.confidence,
    metrics: withPercents(evidence.metrics ?? {}),
    impact: view.impact,
    queries: distinct(
      [
        ...(view.keyword ? [view.keyword] : []),
        ...(evidence.queries ?? []).map((query) => query.text),
      ],
      FACT_QUERIES,
    ),
    pages: distinct(
      (evidence.pages ?? []).map((page) => page.path),
      FACT_PAGES,
    ),
    cause: evidence.cause ?? null,
  };
}

// Sıra korunur; dize bütçesini aşan bulgunun yeni dizgileri çıkarılır (bulgu
// sayılarıyla kalır).
export function explanationFacts(findings: readonly SeoFindingView[]): {
  facts: ExplainFact[];
  strings: number;
} {
  const limited = limitGoogleStrings(
    findings.map(factOf),
    (fact) => [...fact.queries, ...fact.pages],
    {
      strip: (fact, allowed) => ({
        ...fact,
        queries: fact.queries.filter((query) => allowed.has(query)),
        pages: fact.pages.filter((page) => allowed.has(page)),
      }),
    },
  );
  return { facts: limited.items, strings: limited.used };
}

// Açıklama + ilk adım; desteklenmeyen sayılı cümleler atılır, boşsa null.
export function checkedExplanation(
  item: { explanation: string; firstStep: string },
  fact: ExplainFact,
): string | null {
  const parts = [
    cleanWorksTextOrNull(item.explanation, EXPLANATION_MAX),
    cleanWorksTextOrNull(item.firstStep, FIRST_STEP_MAX),
  ].filter((part): part is string => part !== null);
  if (parts.length === 0) return null;
  const allowed = allowedNumbersOf([
    fact.metrics,
    fact.impact,
    fact.queries,
    fact.pages,
  ]);
  const checked = keepSupportedSentences(parts.join(" "), allowed);
  return checked.length > 0 ? checked : null;
}

function isBudgetError(error: unknown): boolean {
  return isAgentelseError(error) && error.code === "BUDGET_EXCEEDED";
}

// Haftalık bulguların dönem anahtarı (P2 weeklyPeriodKey ile aynı: Pazar).
function weeklyKeyOf(week: string): string {
  return `W:${addDays(week, 6)}`;
}

export async function explainWeek(input: {
  link: Pick<GscSiteLink, "id" | "projectId" | "workspaceId">;
  week: string;
  now: Date;
}): Promise<{ explained: number; budgetHit: boolean }> {
  const { link, week, now } = input;
  const state = await readEngineState(link.id);
  if (state?.explainedWeek === week) return { explained: 0, budgetHit: false };
  const markDone = () => updateEngineState(link.id, { explainedWeek: week });

  const rows = await prisma.seoFinding.findMany({
    where: {
      linkId: link.id,
      status: "OPEN",
      shadow: false,
      explanation: null,
      // Haftanın anahtarı ve açık aylık SO3 satırları.
      ...currentPeriodFilter(weeklyKeyOf(week)),
    },
    orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
    take: EXPLAIN_PER_WEEK,
  });
  // Sahte yanıt hiçbir zaman gerçek açıklama olarak saklanmaz.
  if (rows.length === 0 || ReasoningService.isMockMode()) {
    await markDone();
    return { explained: 0, budgetHit: false };
  }
  const { facts } = explanationFacts(rows.map(findingViewOf));
  if (facts.length === 0) {
    await markDone();
    return { explained: 0, budgetHit: false };
  }
  const scope = await scopeForProject(link.projectId);
  if (!scope) return { explained: 0, budgetHit: false };

  const run = await ReasoningService.run(seoOpportunityExplainDef, {
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    brandId: scope.brandId,
    context: { findings: facts },
  }).catch((error: unknown) => {
    if (isBudgetError(error)) return null;
    throw error;
  });
  // Bütçe dolduysa hafta açık kalır: sonraki koşu yeniden dener.
  if (!run) return { explained: 0, budgetHit: true };

  const factsById = new Map(facts.map((fact) => [fact.id, fact]));
  const done = new Set<string>();
  let explained = 0;
  for (const item of run.output.items) {
    const fact = factsById.get(item.id);
    if (!fact || done.has(item.id)) continue;
    const explanation = checkedExplanation(item, fact);
    if (!explanation) continue;
    done.add(item.id);
    await setFindingOutputs(item.id, { explanation, explainedAt: now });
    explained += 1;
  }
  await markDone();
  return { explained, budgetHit: false };
}
