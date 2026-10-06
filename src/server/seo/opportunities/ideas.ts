import "server-only";

import { parseIdeaConcept, type SeoIdeaConcept } from "@/lib/ideas/concept";
import { prisma } from "@/lib/prisma";
import {
  SeoInsightFlags,
  seoInsightsAllowedFor,
} from "@/lib/seo/insight-flags";
import {
  LLM_GOOGLE_STRING_LIMIT,
  limitGoogleStrings,
} from "@/lib/seo/llm-budget";
import type { SeoRuleKey } from "@/lib/seo/opportunity-types";
import {
  formatCount,
  formatPosition,
  SEO_RULE_LABEL,
} from "@/lib/seo/rules/copy";
import { foldForMatch } from "@/lib/text-fold";
import { primaryGscLink } from "@/server/seo/store";

import { findingViewOf, setFindingOutputs } from "./findings-store";
import { opportunitySignalRef } from "./signals";

// SC-F4 fikir akışı (docs/search-opportunities.md "Brand Brain ve fikirler"):
// generateSeoIdeas (idea-modules.ts, ortak düzenleme) birincil bağın açık,
// gölge olmayan ve fikre değer en çok 8 bulgusunu (SO3, SO5, SO6, SO11; son 14
// günde görülmüş, henüz fikri olmayan) isteme kanıtıyla koyar. İstemdeki quick
// win ve fırsat anahtar sözcükleri birlikte en çok 20 farklı Google dizgisidir.
// Eşleşen fikir "search" kaynağı, kurala özgü sabit gerekçe, güç ve uygulama
// içi kanıt bağlantısıyla kaydedilir; kayıttan sonra fikir kimlikleri bulguya
// yazılır (aynı bulgu bir daha fikir üretmez). SEO_INSIGHTS=on değilken liste
// sorgusuz boştur ve istem bugünküyle aynı kalır.

export type SeoIdeaOpportunity = {
  findingId: string;
  ruleKey: SeoRuleKey;
  keyword: string;
  impressions: number;
  position: number | null;
  why: string;
  strength: 1 | 2 | 3;
  evidence: { title: string; url: string }[];
};

export const SEO_IDEA_OPPORTUNITY_LIMIT = 8;

const IDEA_RULES = [
  "SO3_CONTENT_DECAY",
  "SO5_CONTENT_GAP",
  "SO6_RISING_QUERY",
  "SO11_LOCAL_INTENT",
] as const satisfies readonly SeoRuleKey[];

// Kurala özgü sabit İngilizce gerekçe (rakamsız; fikir kartının "why" satırı).
export const SEO_IDEA_REASON: Readonly<
  Record<(typeof IDEA_RULES)[number], string>
> = {
  SO3_CONTENT_DECAY:
    "Your page for this search is losing clicks; fresh content can win them back.",
  SO5_CONTENT_GAP:
    "People find your site with this search, but no page really answers it.",
  SO6_RISING_QUERY: "More and more people find your site with this search.",
  SO11_LOCAL_INTENT:
    "Local searches for this find your site, but no page speaks to them.",
};

const IDEA_REASON: Readonly<Partial<Record<SeoRuleKey, string>>> =
  SEO_IDEA_REASON;

const SEEN_WITHIN_MS = 14 * 24 * 3_600_000;
const EVIDENCE_MAX = 3;
const CONTAINS_MIN = 3;

function metricOf(metrics: Record<string, number>, key: string): number | null {
  const value = metrics[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sameKeyword(a: string, b: string): boolean {
  return foldForMatch(a).trim() === foldForMatch(b).trim();
}

export async function loadSeoIdeaOpportunities(
  projectId: string,
  now: Date = new Date(),
): Promise<SeoIdeaOpportunity[]> {
  // Kapılar her sorgudan önce.
  if (!SeoInsightFlags.userFacing() || !seoInsightsAllowedFor(projectId)) {
    return [];
  }
  const link = await primaryGscLink(projectId);
  if (!link) return [];
  const rows = await prisma.seoFinding.findMany({
    where: {
      linkId: link.id,
      status: "OPEN",
      shadow: false,
      ideaWorthy: true,
      keyword: { not: null },
      ruleKey: { in: [...IDEA_RULES] },
      lastSeenAt: { gte: new Date(now.getTime() - SEEN_WITHIN_MS) },
      ideaIds: { isEmpty: true },
    },
    orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
    take: SEO_IDEA_OPPORTUNITY_LIMIT,
  });
  const out: SeoIdeaOpportunity[] = [];
  for (const row of rows) {
    const view = findingViewOf(row);
    const keyword = view.keyword?.trim();
    const why = IDEA_REASON[view.ruleKey];
    if (!keyword || !why) continue;
    // Gösterim ve pozisyon: bulgunun metrikleri, yoksa anahtar sözcüğün
    // kanıt satırı, o da yoksa ana sayfanın kanıt satırı (SO3).
    const query = (view.evidence.queries ?? []).find((item) =>
      sameKeyword(item.text, keyword),
    );
    const page = view.evidence.pages?.[0];
    const metrics = view.evidence.metrics ?? {};
    const impressions = Math.round(
      metricOf(metrics, "impressions") ??
        query?.impressions ??
        page?.impressions ??
        0,
    );
    if (impressions <= 0) continue;
    const rawPosition =
      metricOf(metrics, "position") ??
      query?.position ??
      page?.position ??
      null;
    const position =
      rawPosition !== null && Number.isFinite(rawPosition) && rawPosition > 0
        ? Math.round(rawPosition * 10) / 10
        : null;
    out.push({
      findingId: view.id,
      ruleKey: view.ruleKey,
      keyword,
      impressions,
      position,
      why,
      strength: view.confidence === "SIGNIFICANT" ? 3 : 2,
      evidence: [
        {
          title: `${formatCount(impressions)} impressions in 4 weeks${
            position ? ` · position ${formatPosition(position)}` : ""
          } (Search Console)`,
          url: opportunitySignalRef(projectId, view.id),
        },
      ],
    });
  }
  return out;
}

// İsteme girecek satırlar: [anahtar sözcük, kural adı, gösterim, pozisyon].
// Önce gönderilen quick win sorguları sayılır; toplam farklı dizge ≤ 20.
// Sığmayan satır atılır (kırpılmaz).
export function opportunityPromptRows(
  opportunities: readonly SeoIdeaOpportunity[],
  alreadySent: readonly string[],
): [string, string, number, number | null][] {
  const sent = new Set(alreadySent.filter((value) => value.length > 0));
  const limit = LLM_GOOGLE_STRING_LIMIT - sent.size;
  if (limit <= 0 || opportunities.length === 0) return [];
  const { items } = limitGoogleStrings(
    opportunities,
    (item) => (sent.has(item.keyword) ? [] : [item.keyword]),
    { limit },
  );
  return items.map((item) => [
    item.keyword,
    SEO_RULE_LABEL[item.ruleKey],
    item.impressions,
    item.position,
  ]);
}

function keywordsMatch(a: string, b: string): boolean {
  const left = foldForMatch(a).trim();
  const right = foldForMatch(b).trim();
  if (!left || !right) return false;
  if (left === right) return true;
  const [short, long] =
    left.length <= right.length ? [left, right] : [right, left];
  return short.length >= CONTAINS_MIN && long.includes(short);
}

// Fikrin anahtar sözcüğü bir fırsatınkine eşit ya da onu içeriyor (ya da
// tersi): kaynak "search", ilk (en öncelikli) eşleşmenin gerekçesi ve gücü,
// en çok 3 kanıt.
export function applySeoOpportunity(
  concept: SeoIdeaConcept,
  opportunities: readonly SeoIdeaOpportunity[],
): SeoIdeaConcept {
  const matches = opportunities.filter((item) =>
    keywordsMatch(concept.draft.keyword, item.keyword),
  );
  const best = matches[0];
  if (!best) return concept;
  return {
    ...concept,
    source: "search",
    why: best.why,
    strength: best.strength,
    evidence: [
      ...matches.flatMap((item) => item.evidence),
      ...(concept.evidence ?? []),
    ].slice(0, EVIDENCE_MAX),
  };
}

function opportunityIdOf(url: string): string | null {
  try {
    return new URL(url).searchParams.get("opportunity");
  } catch {
    return null;
  }
}

// Kaydedilen fikirlerin kanıt bağlantısındaki opportunity=<id> bulgularına
// fikir kimliği yazılır (tekrarsız). Güncellenen bulgu sayısını döner.
export async function attachIdeasToFindings(
  projectId: string,
  ideaIds: readonly string[],
): Promise<number> {
  if (ideaIds.length === 0) return 0;
  const ideas = await prisma.idea.findMany({
    where: { id: { in: [...new Set(ideaIds)] }, projectId },
    select: { id: true, concept: true },
  });
  const byFinding = new Map<string, string[]>();
  for (const idea of ideas) {
    const concept = parseIdeaConcept(idea.concept);
    for (const item of concept?.evidence ?? []) {
      const findingId = opportunityIdOf(item.url);
      if (!findingId) continue;
      const list = byFinding.get(findingId) ?? [];
      if (!list.includes(idea.id)) list.push(idea.id);
      byFinding.set(findingId, list);
    }
  }
  if (byFinding.size === 0) return 0;
  const findings = await prisma.seoFinding.findMany({
    where: { id: { in: [...byFinding.keys()] }, projectId },
    select: { id: true, ideaIds: true },
  });
  let updated = 0;
  for (const finding of findings) {
    const merged = [
      ...new Set([...finding.ideaIds, ...(byFinding.get(finding.id) ?? [])]),
    ];
    if (merged.length === finding.ideaIds.length) continue;
    await setFindingOutputs(finding.id, { ideaIds: merged });
    updated += 1;
  }
  return updated;
}
