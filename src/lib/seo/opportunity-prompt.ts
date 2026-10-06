// SC-F4: SEO fikir isteminin (idea-seo.ts) fırsat parçaları
// (docs/search-opportunities.md "Brand Brain ve fikirler"). Bağlamda boş
// olmayan bir `opportunities` dizisi yoksa null döner: SEO_INSIGHTS=on değilken
// istem bugünküyle bayt bayt aynı kalır. Satırlar
// [anahtar sözcük, neden, 4 haftalık gösterim, pozisyon] biçimindedir ve
// quick wins ile birlikte en çok 20 Google dizgisi taşır (ideas.ts). Saf.

export type SeoOpportunityPromptParts = { rule: string; line: string };

export const SEO_OPPORTUNITY_PROMPT_RULE =
  "Prefer the evidence-backed opportunities first, then the quick wins; keep the keyword exactly as given.";

export function seoOpportunityPromptParts(
  context: Record<string, unknown>,
): SeoOpportunityPromptParts | null {
  const opportunities = context.opportunities;
  if (!Array.isArray(opportunities) || opportunities.length === 0) return null;
  return {
    rule: SEO_OPPORTUNITY_PROMPT_RULE,
    line: `Evidence-backed opportunities from the site's search data (keyword, why, impressions in 4 weeks, position): ${JSON.stringify(opportunities)}`,
  };
}
