import "server-only";

import { prisma } from "@/lib/prisma";
import {
  IDEA_CONCEPT_VERSION,
  isExpired,
  type AdIdeaConcept,
  type IdeaConcept,
} from "@/lib/ideas/concept";
import { IDEA_REASON_COPY } from "@/lib/ideas/copy";
import { normalizeSeoIdeas } from "@/lib/ideas/normalize";
import { IDEA_POOL_STATUSES } from "@/lib/idea-pool";
import { utcToZonedDateTimeLocal } from "@/lib/timezone";
import { blocksOf, checkText } from "@/lib/works/brand-rules";
import { ConstitutionService } from "@/server/agency/constitution/constitution-service";
import { brandRuleLanguageOf } from "@/server/brand/rule-language";
import { getProjectTimezone } from "@/server/chat/content-plan";
import {
  poolCapacity,
  saveIdeaConcepts,
  type GenerateIdeasResult,
} from "@/server/ideas/idea-engine";
import { readIdeaRows, type IdeaRow } from "@/server/ideas/idea-context";
import { findActiveGoogleConnections } from "@/server/integrations/google-connections";
import { postResultSourceRef } from "@/server/memory/memory-service";
import { loadAdsAccount } from "@/server/modules/ads/account";
import { listSourcePosts } from "@/server/modules/ads/source-posts";
import { loadSeoQuickWins } from "@/server/modules/seo/research";
import { ideaSeoDef } from "@/server/reasoning/prompts/idea-seo";
import { refreshWebsiteIdeas } from "@/server/ideas/website-ideas";
import {
  applySeoOpportunity,
  attachIdeasToFindings,
  loadSeoIdeaOpportunities,
  opportunityPromptRows,
} from "@/server/seo/opportunities/ideas";
import { ReasoningService } from "@/server/reasoning/reasoning-service";
import { AgentelseError } from "@/server/security/errors";
import { loadBrandRules } from "@/server/works/brand-rule-loader";
import { isModulesEnabled } from "@/server/works/flag";

// The module lenses of the idea pool beyond posts (docs/ideas.md): article
// ideas for the SEO Manager (a lite model call grounded in the site's Search
// Console "quick wins") and ad ideas for the Ads Manager (no model: the posts
// the client marked as worked, else the latest boostable ones). Both live in
// the same pool and board as post ideas, and both exist only while their
// module can act on them.

// Article ideas: a few at a time, at most once a week.
const SEO_TARGET = 6;
const SEO_LOW_WATER = 3;
const SEO_PER_CALL = 3;
const SEO_INTERVAL_MS = 7 * 24 * 60 * 60_000;
const SEO_RETRY_MS = 6 * 60 * 60_000;
// Ad ideas: at most this many waiting, refreshed at most daily.
const ADS_TARGET = 3;
const ADS_INTERVAL_MS = 20 * 60 * 60_000;

const POOL = new Set<string>(IDEA_POOL_STATUSES);

type Fresh = { seo: number; ads: number; lastAdAt: Date | null };

function freshOf(rows: readonly IdeaRow[], now: Date): Fresh {
  let seo = 0;
  let ads = 0;
  let lastAdAt: Date | null = null;
  for (const row of rows) {
    const concept = row.concept;
    if (!concept || row.isMock) continue;
    if (concept.module === "ads" && (!lastAdAt || row.createdAt > lastAdAt)) {
      lastAdAt = row.createdAt;
    }
    if (!POOL.has(row.status) || isExpired(concept, now)) continue;
    if (concept.module === "seo") seo += 1;
    if (concept.module === "ads") ads += 1;
  }
  return { seo, ads, lastAdAt };
}

async function scopeOf(projectId: string) {
  const [project, brand] = await Promise.all([
    prisma.project.findUnique({
      where: { id: projectId },
      select: { workspaceId: true },
    }),
    prisma.brand.findFirst({
      where: { projectId, isDefault: true },
      select: { id: true },
    }),
  ]);
  return project && brand
    ? { workspaceId: project.workspaceId, projectId, brandId: brand.id }
    : null;
}

export async function moduleIdeasAvailable(
  projectId: string,
): Promise<{ seo: boolean; ads: boolean }> {
  if (!isModulesEnabled()) return { seo: false, ads: false };
  const account = await loadAdsAccount(projectId).catch(() => null);
  return {
    seo: true,
    ads: Boolean(account && account.status !== "needs-connect"),
  };
}

// --- articles -----------------------------------------------------------------

export async function generateSeoIdeas(input: {
  projectId: string;
  count?: number;
  focus?: string;
  now?: Date;
}): Promise<GenerateIdeasResult> {
  const now = input.now ?? new Date();
  if (!isModulesEnabled()) return { ok: false, reason: "EMPTY" };
  const scope = await scopeOf(input.projectId);
  if (!scope) return { ok: false, reason: "NO_BRAND" };
  // SC-F4: fırsat motorunun kanıtlı bulguları istemde önce gelir (quick wins ile birlikte en çok 20 Google dizgisi); eşleşen fikir 'search' kaynağı ve kanıtla kaydedilir. SEO_INSIGHTS=on değilken liste boştur ve istem bugünküyle aynıdır.
  const [rows, brand, quickWins, articles, timezone, opportunities] =
    await Promise.all([
      readIdeaRows(input.projectId),
      ConstitutionService.getBrandContext(scope.brandId),
      loadSeoQuickWins(input.projectId),
      prisma.post.findMany({
        where: {
          projectId: input.projectId,
          deliveries: { some: { channel: "seo" } },
        },
        orderBy: { createdAt: "desc" },
        take: 30,
        select: { topic: true },
      }),
      getProjectTimezone(input.projectId),
      loadSeoIdeaOpportunities(input.projectId, now).catch(() => []),
    ]);
  const pool = rows.flatMap((row) =>
    row.concept?.module === "seo" ? [row.concept.draft.keyword] : [],
  );
  const wanted = Math.min(
    SEO_PER_CALL * 2,
    Math.max(1, input.count ?? SEO_PER_CALL),
  );
  // Room first: no model call for ideas a full pool cannot take.
  const capacity = await poolCapacity({
    scope,
    rows,
    isMock: ReasoningService.isMockMode(),
    now,
    wanted,
  });
  const fits = Math.min(wanted, capacity.free + capacity.retire.length);
  if (fits <= 0) return { ok: false, reason: "FULL" };
  const quickWinRows =
    quickWins.state === "ok"
      ? quickWins.items.map((item) => [
          item.query,
          item.impressions,
          item.position,
        ])
      : [];
  const opportunityRows = opportunityPromptRows(
    opportunities,
    quickWins.state === "ok" ? quickWins.items.map((item) => item.query) : [],
  );
  const run = await ReasoningService.run(ideaSeoDef, {
    ...scope,
    context: {
      count: fits,
      today: utcToZonedDateTimeLocal(now, timezone).slice(0, 10),
      brand,
      quickWins: quickWinRows,
      ...(opportunityRows.length > 0 ? { opportunities: opportunityRows } : {}),
      articles: articles.map((post) => post.topic),
      pool,
      ...(input.focus ? { focus: input.focus } : {}),
    },
  }).catch((error: unknown) => {
    if (error instanceof AgentelseError && error.code === "BUDGET_EXCEEDED")
      return null;
    throw error;
  });
  if (!run) return { ok: false, reason: "BUDGET" };

  const language = await brandRuleLanguageOf(input.projectId);
  const rules = await loadBrandRules({ ...scope, language });
  const concepts = normalizeSeoIdeas(run.output.ideas, [
    ...pool,
    ...articles.map((post) => post.topic),
  ])
    .map((concept) =>
      quickWins.state === "ok" &&
      quickWins.items.some(
        (item) =>
          item.query.toLowerCase() === concept.draft.keyword.toLowerCase(),
      )
        ? { ...concept, source: "search" as const }
        : concept,
    )
    .map((concept) => applySeoOpportunity(concept, opportunities))
    .filter(
      (concept) =>
        blocksOf(
          checkText(
            `${concept.draft.title}\n${concept.draft.description}`,
            rules,
          ),
        ).length === 0,
    );
  const saved = await saveIdeaConcepts({
    scope,
    concepts,
    rows,
    isMock: run.isMock,
    now,
  });
  if (saved.ok && opportunities.length > 0) {
    await attachIdeasToFindings(input.projectId, saved.created).catch(() => 0);
  }
  return saved;
}

// --- ads ------------------------------------------------------------------------

export async function refreshAdIdeas(input: {
  projectId: string;
  now?: Date;
  rows?: readonly IdeaRow[];
}): Promise<GenerateIdeasResult> {
  const now = input.now ?? new Date();
  const available = await moduleIdeasAvailable(input.projectId);
  if (!available.ads) return { ok: false, reason: "EMPTY" };
  const scope = await scopeOf(input.projectId);
  if (!scope) return { ok: false, reason: "NO_BRAND" };
  const rows = input.rows ?? (await readIdeaRows(input.projectId));
  const room = ADS_TARGET - freshOf(rows, now).ads;
  if (room <= 0) return { ok: false, reason: "EMPTY" };

  const [posts, learnings] = await Promise.all([
    listSourcePosts(input.projectId),
    prisma.brandLearning.findMany({
      where: {
        brandId: scope.brandId,
        polarity: "WORKS",
        sourceRef: { endsWith: ":result" },
      },
      select: { sourceRef: true },
      take: 100,
    }),
  ]);
  const worked = new Set(learnings.map((row) => row.sourceRef ?? ""));
  const boosted = new Set(
    rows.flatMap((row) =>
      row.concept?.module === "ads" ? [row.concept.draft.creativeId] : [],
    ),
  );
  const candidates = posts
    .filter((post) => !boosted.has(post.creativeId))
    .map((post) => ({
      post,
      worked: worked.has(postResultSourceRef(post.creativeId)),
    }))
    .sort((a, b) => Number(b.worked) - Number(a.worked))
    .slice(0, room);
  const concepts: AdIdeaConcept[] = candidates.map(
    ({ post, worked: didWork }) => ({
      v: IDEA_CONCEPT_VERSION,
      module: "ads",
      source: didWork ? "results" : "brand",
      why: didWork ? IDEA_REASON_COPY.adWorked : IDEA_REASON_COPY.adRecent,
      strength: didWork ? 3 : 2,
      draft: {
        creativeId: post.creativeId,
        assetId: post.assetId,
        angle: post.title.slice(0, 200),
        objective: "engagement",
      },
    }),
  );
  return saveIdeaConcepts({
    scope,
    concepts: concepts as IdeaConcept[],
    rows,
    isMock: false,
    now,
  });
}

// --- refill ---------------------------------------------------------------------

// The module ideas due now: ad ideas at most daily while fewer than the target
// wait, article ideas at most weekly while Search Console is connected and
// few wait. Returns what was made.
export async function moduleRefillIfDue(
  projectId: string,
  now: Date = new Date(),
): Promise<string[]> {
  const available = await moduleIdeasAvailable(projectId);
  if (!available.seo && !available.ads) return [];
  const rows = await readIdeaRows(projectId);
  const fresh = freshOf(rows, now);
  const created: string[] = [];

  if (
    available.ads &&
    fresh.ads < ADS_TARGET &&
    (!fresh.lastAdAt ||
      now.getTime() - fresh.lastAdAt.getTime() >= ADS_INTERVAL_MS)
  ) {
    const result = await refreshAdIdeas({ projectId, now, rows });
    if (result.ok) created.push(...result.created);
  }

  if (available.seo && fresh.seo < SEO_LOW_WATER) {
    const [{ searchConsole }, last] = await Promise.all([
      findActiveGoogleConnections(projectId).catch(() => ({
        searchConsole: null,
      })),
      prisma.reasoningCall.findFirst({
        where: { projectId, purpose: ideaSeoDef.purpose },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true, status: true },
      }),
    ]);
    const wait = last?.status === "OK" ? SEO_INTERVAL_MS : SEO_RETRY_MS;
    if (
      searchConsole &&
      (!last || now.getTime() - last.createdAt.getTime() >= wait)
    ) {
      const result = await generateSeoIdeas({
        projectId,
        count: Math.min(SEO_PER_CALL, SEO_TARGET - fresh.seo),
        now,
      });
      if (result.ok) created.push(...result.created);
    }
  }
  // GA-F4: "From your website" makale fikirleri (GA_INSIGHTS=on; kendi kapıları sorgudan önce). Aynı çağrıda fikir eklendiyse satırlar yeniden okunur.
  if (available.seo) {
    const website = await refreshWebsiteIdeas({
      projectId,
      now,
      rows: created.length > 0 ? undefined : rows,
    });
    if (website.ok) created.push(...website.created);
  }
  return created;
}
