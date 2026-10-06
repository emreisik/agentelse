import type { DecayCause, SeoRuleKey } from "@/lib/seo/opportunity-types";

// Bulgu metinleri (İngilizce, deterministik). Kural:
// - başlık ≤ 90, özet ≤ 280 karakter, URL yok;
// - içindeki tek Google dizgileri bulgunun keyword'ü ve birincil sayfa (ya da
//   bölüm) yoludur; ikisi de kısaltılarak yerleştirilir;
// - geçen her sayı evidence.metrics'te gösterildiği gibi yuvarlanmış durur
//   (sabit sayılar yazıyla: "four weeks", "page one").
// SEO_SIGNAL_TEXT Brand Brain sinyalleri içindir: genel, sayısız, sorgusuz ve
// yolsuz (Telegram'a gidebilir).

export const TITLE_MAX = 90;
export const SUMMARY_MAX = 280;
export const KEYWORD_DISPLAY_MAX = 48;
export const PATH_DISPLAY_MAX = 48;

export const SEO_RULE_LABEL: Readonly<Record<SeoRuleKey, string>> = {
  SO1_STRIKING_DISTANCE: "Close to the top",
  SO2_CTR_GAP: "Low click rate",
  SO3_CONTENT_DECAY: "Losing clicks",
  SO4_CANNIBALIZATION: "Competing pages",
  SO5_CONTENT_GAP: "Content gap",
  SO6_RISING_QUERY: "Rising search",
  SO7_LOST: "Lost clicks",
  SO8_INTERNAL_LINKS: "Internal links",
  SO9_PAGE_GROUP_TREND: "Section trend",
  SO10_BRAND_DEMAND: "Brand demand",
  SO11_LOCAL_INTENT: "Local search",
  SO12_RICH_RESULTS: "Rich results",
  SO13_INTERNATIONAL: "International",
  SO14_MEDIA_SEARCH: "Image and video search",
  SO15_NEW_CONTENT: "New pages",
  SO16_TECH_IMPACT: "Technical issues",
};

export const SEO_SIGNAL_TEXT: Readonly<
  Partial<Record<SeoRuleKey, { title: string; summary: string }>>
> = {
  SO3_CONTENT_DECAY: {
    title: "Search: a page is losing clicks",
    summary:
      "A page that used to bring visitors from Google is getting fewer clicks. Details are on the Search page.",
  },
  SO6_RISING_QUERY: {
    title: "Search: a search about your topics is rising",
    summary:
      "More people are finding your site through a growing search. Details are on the Search page.",
  },
  SO7_LOST: {
    title: "Search: a page stopped getting clicks",
    summary:
      "A page that brought visitors from Google is no longer getting clicks. Details are on the Search page.",
  },
  SO9_PAGE_GROUP_TREND: {
    title: "Search: clicks to a section of your site changed",
    summary:
      "Clicks from Google to one section of your site changed noticeably. Details are on the Search page.",
  },
  SO10_BRAND_DEMAND: {
    title: "Search: brand searches changed",
    summary:
      "The number of people searching for your brand changed noticeably. Details are on the Search page.",
  },
  SO13_INTERNATIONAL: {
    title: "Search: visitors from another country",
    summary:
      "People in a country whose language your site does not offer are finding you. Details are on the Search page.",
  },
};

export function formatCount(n: number): string {
  return Math.round(Number.isFinite(n) ? n : 0).toLocaleString("en-US");
}

export function formatPosition(n: number): string {
  return (Number.isFinite(n) ? n : 0).toFixed(1);
}

// Kod noktasıyla kısaltır; kesilen metin "…" ile biter.
export function shortText(text: string, max: number): string {
  const chars = Array.from(text.trim());
  if (chars.length <= max) return chars.join("");
  return `${chars
    .slice(0, max - 1)
    .join("")
    .trimEnd()}…`;
}

export function displayKeyword(keyword: string): string {
  return shortText(keyword, KEYWORD_DISPLAY_MAX);
}

export function displayPath(path: string): string {
  return shortText(path, PATH_DISPLAY_MAX);
}

// Güvenlik ağı: sınırı aşan metin son boşlukta kesilir (sayı bölünmez).
function fit(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const head = chars.slice(0, max - 1).join("");
  const cut = head.lastIndexOf(" ");
  return `${(cut > 0 ? head.slice(0, cut) : head).trimEnd()}…`;
}

export type FindingCopy = { title: string; summary: string };

function copy(title: string, summary: string): FindingCopy {
  return { title: fit(title, TITLE_MAX), summary: fit(summary, SUMMARY_MAX) };
}

function quoted(keyword: string): string {
  return `“${displayKeyword(keyword)}”`;
}

function pageLabel(path: string): string {
  return path ? displayPath(path) : "A page";
}

function plural(n: number, one: string, many: string): string {
  return `${formatCount(n)} ${Math.round(n) === 1 ? one : many}`;
}

export function strikingDistanceCopy(input: {
  path: string;
  queries: number;
  impressions: number;
  gain: number;
}): FindingCopy {
  return copy(
    `${pageLabel(input.path)} is close to the top results`,
    `It ranks just below the top results for ${plural(input.queries, "search", "searches")} with ${formatCount(input.impressions)} impressions in four weeks. Moving up could bring about ${formatCount(input.gain)} more clicks a month.`,
  );
}

export function ctrGapCopy(input: {
  path: string;
  clicks: number;
  impressions: number;
  expectedClicks: number;
}): FindingCopy {
  return copy(
    `${pageLabel(input.path)} gets fewer clicks than its ranking suggests`,
    `On page one it earned ${formatCount(input.clicks)} clicks from ${formatCount(input.impressions)} impressions in four weeks, while similar positions usually earn about ${formatCount(input.expectedClicks)}. A clearer title and description could close the gap.`,
  );
}

const DECAY_CAUSE_TEXT: Readonly<Record<DecayCause, string>> = {
  INDEX: "Google may not be able to index it right now.",
  CANNIBALIZATION: "Another page of yours now takes more of its searches.",
  RANKING: "Its average position in Google has dropped.",
  DEMAND: "Fewer people are searching for its topics.",
  CTR: "Its position held, but fewer searchers clicked.",
  MIXED: "Several smaller changes add up.",
};

export function contentDecayCopy(input: {
  path: string;
  recentClicks: number;
  priorClicks: number;
  dropPercent: number;
  yearAgo: boolean;
  cause: DecayCause;
}): FindingCopy {
  return copy(
    `${pageLabel(input.path)} is losing search clicks`,
    `It got ${formatCount(input.recentClicks)} clicks in the last three months, down from ${formatCount(input.priorClicks)} in the three months before (${formatCount(input.dropPercent)}% fewer).${input.yearAgo ? " It is also below the same months last year." : ""} ${DECAY_CAUSE_TEXT[input.cause]}`,
  );
}

export function cannibalizationCopy(input: {
  keyword: string;
  pages: number;
  impressions: number;
  switches: number;
}): FindingCopy {
  return copy(
    `Several pages compete for ${quoted(input.keyword)}`,
    `${formatCount(input.pages)} of your pages share ${formatCount(input.impressions)} impressions for this search in four weeks, so none ranks as well as one strong page could.${input.switches > 0 ? ` Google switched the leading page ${plural(input.switches, "time", "times")}.` : ""}`,
  );
}

export function contentGapCopy(
  input:
    | { variant: "missing" | "deep"; keyword: string; impressions: number }
    | { variant: "partial"; keyword: string; impressions: number; path: string }
    | {
        variant: "cluster";
        keyword: string;
        impressions: number;
        queries: number;
      },
): FindingCopy {
  const impressions = formatCount(input.impressions);
  switch (input.variant) {
    case "missing":
      return copy(
        `No page of yours answers ${quoted(input.keyword)}`,
        `This search had ${impressions} impressions in four weeks, but none of your pages shows up for it. A page made for it could earn a share of these clicks.`,
      );
    case "deep":
      return copy(
        `No strong page answers ${quoted(input.keyword)}`,
        `This search had ${impressions} impressions in four weeks, but your best page for it ranks beyond the second page of results. A page made for it could earn a share of these clicks.`,
      );
    case "partial":
      return copy(
        `Your page only partly covers ${quoted(input.keyword)}`,
        `This search had ${impressions} impressions in four weeks and ${pageLabel(input.path)} ranks for it, but its title and headings miss most of the search words.`,
      );
    case "cluster":
      return copy(
        `A topic around ${quoted(input.keyword)} has no strong page`,
        `${plural(input.queries, "related search", "related searches")} had ${impressions} impressions in four weeks without a page that fully covers them.`,
      );
  }
}

export function risingCopy(input: {
  variant: "new" | "growth" | "cluster";
  keyword: string;
  impressions: number;
  previousImpressions: number;
  queries: number;
  refresh: boolean;
}): FindingCopy {
  const action = input.refresh
    ? " You already rank near the top; keep that page fresh."
    : " A page made for it could catch this demand.";
  const impressions = formatCount(input.impressions);
  const previous = formatCount(input.previousImpressions);
  if (input.variant === "new") {
    return copy(
      `New search: ${quoted(input.keyword)}`,
      `It started showing your site in the last four weeks with ${impressions} impressions.${action}`,
    );
  }
  if (input.variant === "growth") {
    return copy(
      `Rising search: ${quoted(input.keyword)}`,
      `Its impressions grew from ${previous} to ${impressions} compared with the four weeks before.${action}`,
    );
  }
  return copy(
    `Rising topic: ${quoted(input.keyword)}`,
    `${plural(input.queries, "related search", "related searches")} grew from ${previous} to ${impressions} impressions compared with the four weeks before.${action}`,
  );
}

export function lostCopy(
  input:
    | { variant: "page"; path: string; previousClicks: number }
    | { variant: "query"; keyword: string; previousClicks: number },
): FindingCopy {
  const clicks = formatCount(input.previousClicks);
  if (input.variant === "page") {
    return copy(
      `${pageLabel(input.path)} stopped getting search clicks`,
      `It had ${clicks} clicks from Google in the four weeks before and none in the last four weeks.`,
    );
  }
  return copy(
    `${quoted(input.keyword)} stopped bringing clicks`,
    `This search brought ${clicks} clicks in the four weeks before and none in the last four weeks.`,
  );
}

export function internalLinksCopy(input: {
  path: string;
  impressions: number;
  inlinks: number;
  sources: number;
}): FindingCopy {
  const links =
    input.inlinks === 0
      ? "no internal links point to it"
      : `only ${plural(input.inlinks, "internal link points", "internal links point")} to it`;
  return copy(
    `Link to ${pageLabel(input.path)} from related pages`,
    `It had ${formatCount(input.impressions)} impressions in four weeks, but ${links}. Links from ${plural(input.sources, "related page", "related pages")} could help it rank.`,
  );
}

export function pageGroupCopy(input: {
  group: string;
  clicks: number;
  previousClicks: number;
  yearAgo: boolean;
}): FindingCopy {
  const drop = input.clicks < input.previousClicks;
  const group = displayPath(input.group);
  return copy(
    `Search clicks to ${group} ${drop ? "fell" : "grew"}`,
    `Pages in this section got ${formatCount(input.clicks)} clicks in the last four weeks, ${drop ? "down" : "up"} from ${formatCount(input.previousClicks)} in the four weeks before.${input.yearAgo ? ` The same weeks last year confirm the ${drop ? "drop" : "rise"}.` : ""}`,
  );
}

export function brandDemandCopy(input: {
  weeklyImpressions: number;
  previousWeeklyImpressions: number;
}): FindingCopy {
  const drop = input.weeklyImpressions < input.previousWeeklyImpressions;
  return copy(
    `Searches for your brand ${drop ? "fell" : "grew"}`,
    `Brand searches averaged ${formatCount(input.weeklyImpressions)} impressions a week over the last four weeks, against ${formatCount(input.previousWeeklyImpressions)} in the four weeks before.`,
  );
}

export function localIntentCopy(input: {
  keyword: string;
  impressions: number;
  place: boolean;
}): FindingCopy {
  return copy(
    `Local search without a matching page: ${quoted(input.keyword)}`,
    input.place
      ? `This local search had ${formatCount(input.impressions)} impressions in four weeks, but no page of yours names the place it asks about.`
      : `This local search had ${formatCount(input.impressions)} impressions in four weeks, but your site ranks below page one for it.`,
  );
}

export function richResultsCopy(
  input:
    | { variant: "organization" }
    | { variant: "article" | "product"; group: string }
    | { variant: "breadcrumbs"; pages: number; impressions: number },
): FindingCopy {
  switch (input.variant) {
    case "organization":
      return copy(
        "Tell Google who you are with organization markup",
        "Your homepage has no Organization or LocalBusiness structured data. Adding it helps Google show your name, logo and contact details correctly.",
      );
    case "article":
      return copy(
        `Add article markup to ${displayPath(input.group)}`,
        "Pages in this section have no Article structured data, which helps Google understand and show your posts.",
      );
    case "product":
      return copy(
        `Add product markup to ${displayPath(input.group)}`,
        "Pages in this section have no Product structured data, which lets Google show price and availability in results.",
      );
    case "breadcrumbs":
      return copy(
        "Add breadcrumb markup to deeper pages",
        `${plural(input.pages, "deeper page", "deeper pages")} with ${formatCount(input.impressions)} impressions in four weeks have no breadcrumb structured data. Breadcrumbs help Google show where a page sits.`,
      );
  }
}

export function internationalCopy(input: {
  country: string;
  language: string;
  impressions: number;
}): FindingCopy {
  return copy(
    `People in ${input.country} find you, but you have no ${input.language} pages`,
    `Searchers in ${input.country} saw your site ${formatCount(input.impressions)} times in four weeks. A version in ${input.language} could serve them better.`,
  );
}

export function mediaSearchCopy(
  input:
    | { variant: "images"; impressions: number; pages: number }
    | { variant: "video"; impressions: number },
): FindingCopy {
  if (input.variant === "images") {
    return copy(
      "Add alt text to images on popular pages",
      `Your site had ${formatCount(input.impressions)} image search impressions in four weeks, and ${plural(input.pages, "of your most visited pages has", "of your most visited pages have")} images without alt text.`,
    );
  }
  return copy(
    "Mark up your videos",
    `Your site had ${formatCount(input.impressions)} video search impressions in four weeks, but no page has video structured data.`,
  );
}

export function newContentCopy(input: {
  path: string;
  impressions: number;
  typicalImpressions: number;
}): FindingCopy {
  return copy(
    `${pageLabel(input.path)} gets little search traffic yet`,
    `It is new and had ${formatCount(input.impressions)} impressions in four weeks, while new pages on your site usually get about ${formatCount(input.typicalImpressions)}.`,
  );
}

export function techImpactCopy(input: {
  issueTitle: string;
  pages: number;
  impressions: number;
}): FindingCopy {
  return copy(
    input.issueTitle,
    `${plural(input.pages, "page", "pages")} with ${formatCount(input.impressions)} search impressions in four weeks ${Math.round(input.pages) === 1 ? "has" : "have"} this issue. Fixing it protects the traffic they already get.`,
  );
}
