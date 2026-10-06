import { GaSubjects } from "./keys";
import { GA_LABEL_MAX, window28Context } from "./landing-pages";
import type {
  An8Evidence,
  GaFindingCandidate,
  GaWeeklyAnalysisInput,
} from "./types";

// GA-F4 AN8 site içi arama (docs/website-insights.md): ziyaretçilerin sitede
// en çok aradığı terimler içerik fırsatıdır. Son ≤4 haftalık site_search WEEK
// dilimi (GA_WEEKLY gerekir; terimler zaten maskeli). Arama teriminin savunulur
// bir dönüşüm tahmini yok: etki bilerek null. Saf modül, hata atmaz.

const MAX_WEEKS = 4;
const MIN_SEARCHES = 5;
const MAX_TERMS = 10;
const MASK_TOKENS = /\[(?:email|phone|id)\]/g;
const IGNORED_TERMS = new Set(["(not set)", "(other)"]);

// Boş, çok uzun ya da tamamen maskeden oluşan terim atılır.
function usableTerm(term: string): boolean {
  if (term === "" || term.length > GA_LABEL_MAX) return false;
  if (IGNORED_TERMS.has(term.toLowerCase())) return false;
  return term.replace(MASK_TOKENS, "").trim() !== "";
}

export function evaluateSiteSearch(
  input: GaWeeklyAnalysisInput,
): GaFindingCandidate | null {
  if (!input.siteSearch || input.siteSearch.length === 0) return null;
  const weeks = input.siteSearch
    .filter((week) => week.monday <= input.week.monday)
    .sort((a, b) => (a.monday < b.monday ? 1 : a.monday > b.monday ? -1 : 0))
    .slice(0, MAX_WEEKS);
  if (weeks.length === 0) return null;

  const searches = new Map<string, number>();
  for (const week of weeks) {
    for (const row of week.rows) {
      const term = (row.key[0] ?? "").replace(/\s+/g, " ").trim();
      if (!usableTerm(term)) continue;
      searches.set(term, (searches.get(term) ?? 0) + (row.values[0] ?? 0));
    }
  }
  const totalSearches = [...searches.values()].reduce((a, b) => a + b, 0);
  const terms = [...searches.entries()]
    .filter(([, count]) => count >= MIN_SEARCHES)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_TERMS)
    .map(([term, count]) => ({ term, searches: count }));
  if (terms.length === 0) return null;

  const context = window28Context(input);
  const siteSessions = input.window28.totals.sessions;
  const evidence: An8Evidence = {
    v: 1,
    rule: "AN8",
    weeks: weeks.map((week) => week.monday).sort(),
    terms,
    totalSearches,
    siteSessions,
  };
  return {
    ruleKey: "AN8",
    kind: "OPPORTUNITY",
    subject: GaSubjects.siteSearch(),
    period: context.period,
    severity: "INFO",
    confidence: "DIRECTIONAL",
    evidence,
    impact: null,
    impactShare: Math.min(1, totalSearches / Math.max(1, siteSessions)),
  };
}
