import "server-only";

import type { GscSiteLink } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  autoBrandTerms,
  compactBrandTerm,
  effectiveBrandTerms,
  parseBrandTermsConfig,
  parseBrandTermsInput,
} from "@/lib/seo/brand-terms";
import { addWeeks, lastCompleteWeekStart } from "@/lib/seo/dates";
import {
  SeoInsightFlags,
  seoInsightsAllowedFor,
} from "@/lib/seo/insight-flags";
import { takeDistinct } from "@/lib/seo/llm-budget";
import { meaningfulTokens } from "@/lib/seo/tokens";
import { foldForMatch, tokenizeFolded } from "@/lib/text-fold";
import { ConstitutionService } from "@/server/agency/constitution/constitution-service";
import { MOCK_GSC_BRAND_TERM } from "@/server/integrations/search-console/mock";
import { seoBrandTermsDef } from "@/server/reasoning/prompts/seo-brand-terms";
import { ReasoningService } from "@/server/reasoning/reasoning-service";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { isAgentelseError } from "@/server/security/errors";
import { saveBrandTerms } from "@/server/seo/brand-terms";
import { primaryGscLink, readTopQueries } from "@/server/seo/store";

import { scopeForProject } from "./classify";
import { ensureEngineState, readEngineState, updateEngineState } from "./state";

// SC-F4 marka terimi önerileri (docs/search-opportunities.md "Marka terimi
// önerileri", SK8 (a)): markasız sayılan son 13 haftanın en çok gösterim alan
// 200 sorgusundan markayla ya da birbiriyle sözcük paylaşan en çok 20'si lite
// modele gider; model en çok 8 terim önerir. Terim bir sorgudan ya da
// marka/proje/alan adı metninden aynen kopyalanmamışsa (uydurma ya da çeviri)
// atılır. Kullanıcı Add ile onaylar (W1 saveBrandTerms), Dismiss ile gizler.
// Öneriler SeoEngineState.brandSuggestions'ta durur; AuditLog'a terim
// yazılmaz, yalnız sayı. Mock akıl yürütmede model çağrılmaz: mock ambarın
// marka terimi bir sorguda geçiyorsa o önerilir.

export type BrandTermSuggestion = { term: string; reason: string; at: string };

type SuggestionsState = {
  v: 1;
  items: BrandTermSuggestion[];
  dismissed: string[];
  lastAt: string | null;
  auto: boolean;
};

export type SuggestBrandTermsResult =
  | { ok: true; suggestions: BrandTermSuggestion[] }
  | {
      ok: false;
      reason: "off" | "no_link" | "budget" | "failed" | "too_soon";
    };

const CANDIDATE_ROWS = 200;
const CANDIDATE_WEEKS = 13;
export const BRAND_CANDIDATES_MAX = 20;
const SHARED_TOKEN_MIN = 3;
const OWN_TOKEN_MIN = 3;
const SUGGESTIONS_MAX = 8;
const DISMISSED_MAX = 100;
const REASON_MAX = 120;
const NAME_MAX = 60;
const NAMES_MAX = 10;
const THROTTLE_MS = 10 * 60_000;
const MOCK_REASON = "Appears in your searches.";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseSuggestions(value: unknown): SuggestionsState {
  const raw = record(value);
  const items = Array.isArray(raw?.items)
    ? raw.items.flatMap((entry) => {
        const item = record(entry);
        return item &&
          typeof item.term === "string" &&
          typeof item.reason === "string" &&
          typeof item.at === "string"
          ? [{ term: item.term, reason: item.reason, at: item.at }]
          : [];
      })
    : [];
  const dismissed = Array.isArray(raw?.dismissed)
    ? raw.dismissed.filter((item): item is string => typeof item === "string")
    : [];
  return {
    v: 1,
    items,
    dismissed,
    lastAt: typeof raw?.lastAt === "string" ? raw.lastAt : null,
    auto: raw?.auto === true,
  };
}

function gated(projectId: string): boolean {
  return SeoInsightFlags.userFacing() && seoInsightsAllowedFor(projectId);
}

function effectiveOf(link: Pick<GscSiteLink, "brandTerms">): string[] {
  return effectiveBrandTerms(parseBrandTermsConfig(link.brandTerms));
}

export type BrandOwnText = {
  brandName: string | null;
  projectName: string | null;
  domain: string | null;
};

// Marka adı, proje adı ve alan adının kök etiketi (W1 autoBrandTerms ile aynı).
function ownTexts(own: BrandOwnText, siteUrl: string | null): string[] {
  const roots = autoBrandTerms({
    brandName: null,
    projectName: null,
    domain: own.domain,
    siteUrl,
  });
  return [own.brandName ?? "", own.projectName ?? "", ...roots].filter(
    (text) => text.trim().length > 0,
  );
}

// Adaylar: markanın bir sözcüğünü (katlanmış, ayraçsız) içeren ya da en az 3
// adayla ortak anlamlı bir sözcüğü olan sorgular; sırayla en çok 20.
export function brandCandidates(
  queries: readonly string[],
  own: readonly string[],
): string[] {
  const ownTokens = [
    ...new Set(own.flatMap((text) => tokenizeFolded(text))),
  ].filter((token) => token.length >= OWN_TOKEN_MIN);
  const tokensOf = queries.map((query) => new Set(meaningfulTokens(query)));
  const counts = new Map<string, number>();
  for (const tokens of tokensOf) {
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  const kept = queries.filter((query, index) => {
    const compact = compactBrandTerm(query);
    if (ownTokens.some((token) => compact.includes(token))) return true;
    return [...(tokensOf[index] ?? [])].some(
      (token) => (counts.get(token) ?? 0) >= SHARED_TOKEN_MIN,
    );
  });
  return takeDistinct(kept, BRAND_CANDIDATES_MAX);
}

function cleanReason(value: string): string {
  const reason = value
    .replace(/\d/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, REASON_MAX)
    .trim();
  return reason.length > 0 ? reason : MOCK_REASON;
}

// Model çıktısının süzgeci: W1 girdi kuralı, zaten etkin ya da gizlenmiş terim
// yok, ayraçsız biçimi bir adayda ya da markanın kendi metninde geçmeli.
export function acceptedSuggestions(
  terms: readonly { term: string; reason: string }[],
  input: {
    candidates: readonly string[];
    own: readonly string[];
    effective: readonly string[];
    dismissed: readonly string[];
    at: string;
  },
): BrandTermSuggestion[] {
  const blocked = new Set(
    [...input.effective, ...input.dismissed].map(compactBrandTerm),
  );
  const sources = [...input.candidates, ...input.own].map(compactBrandTerm);
  const out: BrandTermSuggestion[] = [];
  for (const raw of terms) {
    const parsed = parseBrandTermsInput(raw.term);
    if (parsed.length !== 1) continue;
    const term = parsed[0]!;
    const compact = compactBrandTerm(term);
    if (!compact || blocked.has(compact)) continue;
    if (!sources.some((source) => source.includes(compact))) continue;
    blocked.add(compact);
    out.push({ term, reason: cleanReason(raw.reason), at: input.at });
    if (out.length >= SUGGESTIONS_MAX) break;
  }
  return out;
}

// Ürün adları (yalnız ad: açıklamanın ilk parçası, kırpılmış).
function productNames(context: Record<string, unknown>): string[] {
  const products = Array.isArray(context.products) ? context.products : [];
  return takeDistinct(
    products
      .filter((item): item is string => typeof item === "string")
      .map((item) => (item.split(/\s[-–—:(]\s?|[:(]/)[0] ?? "").trim())
      .filter((name) => name.length > 0 && name.length <= NAME_MAX),
    NAMES_MAX,
  );
}

async function ownTextOf(projectId: string): Promise<{
  own: BrandOwnText;
  brandId: string | null;
}> {
  const [brand, project] = await Promise.all([
    prisma.brand.findFirst({
      where: { projectId, isDefault: true },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true },
    }),
    prisma.project.findUnique({
      where: { id: projectId },
      select: { name: true, domain: true },
    }),
  ]);
  return {
    own: {
      brandName: brand?.name ?? null,
      projectName: project?.name ?? null,
      domain: project?.domain ?? null,
    },
    brandId: brand?.id ?? null,
  };
}

async function topNonBrandQueries(link: GscSiteLink): Promise<string[]> {
  const week =
    link.lastWeeklyWeek ??
    (link.lastFinalDate ? lastCompleteWeekStart(link.lastFinalDate) : null);
  if (!week) return [];
  const rows = await readTopQueries(
    link.id,
    { from: addWeeks(week, -(CANDIDATE_WEEKS - 1)), to: week },
    { limit: CANDIDATE_ROWS, brand: "non-brand", orderBy: "impressions" },
  );
  return rows.map((row) => row.label);
}

function isBudgetError(error: unknown): boolean {
  return isAgentelseError(error) && error.code === "BUDGET_EXCEEDED";
}

// Bağ için öneri üretir ve saklar (kapılar çağıranda). outputs.ts'in
// kendiliğinden ilk çalıştırması da buradan geçer.
export async function suggestBrandTermsForLink(input: {
  link: GscSiteLink;
  now: Date;
  auto: boolean;
}): Promise<
  | { ok: true; suggestions: BrandTermSuggestion[] }
  | { ok: false; reason: "budget" | "failed" | "too_soon" }
> {
  const { link, now } = input;
  const state = await ensureEngineState(link);
  const current = parseSuggestions(state.brandSuggestions);
  if (
    current.lastAt &&
    now.getTime() - Date.parse(current.lastAt) < THROTTLE_MS
  ) {
    return { ok: false, reason: "too_soon" };
  }
  const effective = effectiveOf(link);
  const [queries, ownInfo] = await Promise.all([
    topNonBrandQueries(link),
    ownTextOf(link.projectId),
  ]);
  const own = ownTexts(ownInfo.own, link.siteUrl);
  const candidates = brandCandidates(queries, own);
  const at = now.toISOString();

  let fresh: BrandTermSuggestion[];
  if (ReasoningService.isMockMode()) {
    const term = MOCK_GSC_BRAND_TERM;
    const mentioned = queries.some((query) =>
      foldForMatch(query).includes(term),
    );
    fresh = mentioned
      ? acceptedSuggestions([{ term, reason: MOCK_REASON }], {
          candidates: queries,
          own,
          effective,
          dismissed: current.dismissed,
          at,
        })
      : [];
  } else if (candidates.length === 0) {
    fresh = [];
  } else {
    const scope = await scopeForProject(link.projectId);
    if (!scope) return { ok: false, reason: "failed" };
    const brandContext = ownInfo.brandId
      ? await ConstitutionService.getBrandContext(ownInfo.brandId).catch(
          () => ({}),
        )
      : {};
    const run = await ReasoningService.run(seoBrandTermsDef, {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      brandId: scope.brandId,
      context: {
        brandName: ownInfo.own.brandName,
        projectName: ownInfo.own.projectName,
        domain: ownInfo.own.domain,
        currentTerms: effective,
        names: productNames(brandContext),
        candidates,
      },
    }).catch((error: unknown) => {
      if (isBudgetError(error)) return null;
      throw error;
    });
    if (!run) return { ok: false, reason: "budget" };
    fresh = acceptedSuggestions(run.output.terms, {
      candidates,
      own,
      effective,
      dismissed: current.dismissed,
      at,
    });
  }

  // Yeni öneriler önde; bekleyen eskiler (hâlâ terim değilse) arkada.
  const blocked = new Set(
    [...effective, ...fresh.map((item) => item.term)].map(compactBrandTerm),
  );
  const items = [
    ...fresh,
    ...current.items.filter(
      (item) => !blocked.has(compactBrandTerm(item.term)),
    ),
  ].slice(0, SUGGESTIONS_MAX);
  const next: SuggestionsState = {
    v: 1,
    items,
    dismissed: current.dismissed,
    lastAt: at,
    auto: current.auto || input.auto,
  };
  await updateEngineState(link.id, { brandSuggestions: next });
  return { ok: true, suggestions: items };
}

export async function readBrandTermSuggestions(
  projectId: string,
): Promise<BrandTermSuggestion[] | null> {
  if (!gated(projectId)) return null;
  const link = await primaryGscLink(projectId);
  if (!link) return null;
  const state = await readEngineState(link.id);
  if (!state) return [];
  const effective = new Set(effectiveOf(link).map(compactBrandTerm));
  return parseSuggestions(state.brandSuggestions).items.filter(
    (item) => !effective.has(compactBrandTerm(item.term)),
  );
}

export async function suggestBrandTerms(
  projectId: string,
  now: Date = new Date(),
): Promise<SuggestBrandTermsResult> {
  if (!gated(projectId)) return { ok: false, reason: "off" };
  const link = await primaryGscLink(projectId);
  if (!link) return { ok: false, reason: "no_link" };
  try {
    return await suggestBrandTermsForLink({ link, now, auto: false });
  } catch (error) {
    console.warn(
      "[seo-brand-suggest] failed:",
      error instanceof Error ? error.message : "unknown error",
    );
    return { ok: false, reason: "failed" };
  }
}

export async function acceptBrandTermSuggestion(input: {
  projectId: string;
  term: string;
  now?: Date;
  // Denetim kaydının aktörü (sunucu eylemi verir).
  userId?: string;
}): Promise<
  { ok: true } | { ok: false; reason: "no_link" | "not_suggested" | "too_long" }
> {
  if (!gated(input.projectId)) return { ok: false, reason: "not_suggested" };
  const link = await primaryGscLink(input.projectId);
  if (!link) return { ok: false, reason: "no_link" };
  const state = await readEngineState(link.id);
  const suggestions = parseSuggestions(state?.brandSuggestions ?? null);
  const key = compactBrandTerm(input.term);
  const item = suggestions.items.find(
    (entry) => compactBrandTerm(entry.term) === key,
  );
  if (!key || !item) return { ok: false, reason: "not_suggested" };

  const saved = await saveBrandTerms({
    projectId: input.projectId,
    terms: [...effectiveOf(link), item.term],
    now: input.now,
  });
  if (!saved.ok) return { ok: false, reason: saved.reason };
  await updateEngineState(link.id, {
    brandSuggestions: {
      ...suggestions,
      items: suggestions.items.filter(
        (entry) => compactBrandTerm(entry.term) !== key,
      ),
    },
  });
  await AuditLogRepository.record({
    workspaceId: link.workspaceId,
    projectId: input.projectId,
    actorType: input.userId ? "USER" : "SYSTEM",
    ...(input.userId ? { actorId: input.userId } : {}),
    action: "search_console.brand_term_suggestion_accepted",
    entityType: "GscSiteLink",
    entityId: link.id,
    metadata: { count: 1 },
  });
  return { ok: true };
}

export async function dismissBrandTermSuggestion(input: {
  projectId: string;
  term: string;
}): Promise<boolean> {
  if (!gated(input.projectId)) return false;
  const link = await primaryGscLink(input.projectId);
  if (!link) return false;
  const state = await readEngineState(link.id);
  if (!state) return false;
  const suggestions = parseSuggestions(state.brandSuggestions);
  const key = compactBrandTerm(input.term);
  const item = suggestions.items.find(
    (entry) => compactBrandTerm(entry.term) === key,
  );
  if (!key || !item) return false;
  await updateEngineState(link.id, {
    brandSuggestions: {
      ...suggestions,
      items: suggestions.items.filter(
        (entry) => compactBrandTerm(entry.term) !== key,
      ),
      dismissed: takeDistinct(
        [item.term, ...suggestions.dismissed],
        DISMISSED_MAX,
      ),
    },
  });
  return true;
}
