import type {
  DidMetric,
  EvaluationReason,
  SeoActionProposalStored,
  SeoActionStatus,
  SeoEvaluation,
  SeoFixKind,
} from "./types";

// SEO eylem döngüsünün İngilizce arayüz metinleri (docs/google-search-console-plan.md
// SC-F6). Yalnız dize içerir; kinds.ts dışında hiçbir şey içe aktarmaz
// (tipler hariç), bu yüzden istemci bileşenleri de alabilir. Sonuç metinleri
// şablondur: Google sayıları üzerinde model anlatısı üretilmez.

export const FIX_KIND_LABEL: Readonly<Record<SeoFixKind, string>> = {
  TITLE_META: "Title and description",
  CONTENT_REFRESH: "Content refresh",
  NEW_CONTENT: "New page",
  LOCALIZE: "Translated page",
  INTERNAL_LINKS: "Internal links",
  CONSOLIDATE: "Merge pages",
  TECH_FIX: "Technical fix",
  SCHEMA: "Structured data",
  CWV_FIX: "Page speed",
  SITEMAP_FIX: "Sitemap fix",
};

export const ACTION_STATUS_LABEL: Readonly<Record<SeoActionStatus, string>> = {
  PROPOSED: "Suggested",
  ACCEPTED: "To do",
  APPLIED: "Checking your site",
  VERIFIED: "Live · waiting for Google",
  EVALUATING: "Measuring",
  WORKED: "Worked",
  DIDNT: "Didn't work",
  INCONCLUSIVE: "No clear result",
  DISMISSED: "Dismissed",
  EXPIRED: "Expired",
};

export const DID_METRIC_LABEL: Readonly<Record<DidMetric, string>> = {
  ctr_adj: "CTR",
  clicks: "clicks",
  impressions: "impressions",
};

export const EVALUATION_REASON_TEXT: Readonly<Record<EvaluationReason, string>> = {
  LOW_DATA: "Not enough search traffic to measure this yet",
  NO_DATA: "Search Console data for this period isn't available",
  NO_SEARCH_DATA: "Connect Search Console to measure search results",
  NO_PAGE: "Search Console has no record of this page",
  GOOGLE_UPDATE: "A Google update overlapped, so the result is unclear",
  OVERLAPPING_CHANGE: "Another change to this page overlapped, so the result is unclear",
  ALERT_GONE: "The issue is no longer tracked",
};

// "Fix this" listesi olmayan türlerin kontrol listesi adımları (2-4 adım,
// rakamsız).
export const FIX_INSTRUCTIONS: Readonly<Record<SeoFixKind, readonly string[]>> = {
  TITLE_META: [
    "Open the page in your website editor.",
    "Replace the title and meta description with the new text.",
    "Publish the change, then tap Mark as done.",
  ],
  CONTENT_REFRESH: [
    "Open the page in your website editor.",
    "Add what is missing and update outdated parts.",
    "Publish the change, then tap Mark as done.",
  ],
  NEW_CONTENT: [
    "Write the new page for this topic.",
    "Publish it on your website.",
    "Tap Mark as done once it is live.",
  ],
  LOCALIZE: [
    "Translate the page for the target language.",
    "Publish it with language tags in place.",
    "Tap Mark as done once it is live.",
  ],
  INTERNAL_LINKS: [
    "Open the page that should link out.",
    "Add a link with clear anchor text to the target page.",
    "Publish the change, then tap Mark as done.",
  ],
  CONSOLIDATE: [
    "Pick the strongest page to keep.",
    "Move the useful parts into it and redirect the other pages to it.",
    "Publish the change, then tap Mark as done.",
  ],
  TECH_FIX: [
    "Open the page or site settings where the problem comes from.",
    "Fix the problem and publish the change.",
    "Tap Mark as done so we can check the page.",
  ],
  SCHEMA: [
    "Add the structured data to the page.",
    "Test it with a rich results test.",
    "Publish the change, then tap Mark as done.",
  ],
  CWV_FIX: [
    "Reduce heavy images, scripts and layout shifts on the slow pages.",
    "Publish the change.",
    "Tap Mark as done. Field data takes weeks to catch up.",
  ],
  SITEMAP_FIX: [
    "Fix the sitemap file so it lists only live pages.",
    "Publish the change.",
    "Tap Mark as done so we can check the sitemap.",
  ],
};

function pct(fraction: number): number {
  const value = Math.round(fraction * 100);
  return value === 0 ? 0 : value;
}

// "+18%", "−4%" (U+2212), "0%".
export function percentChangeText(fraction: number): string {
  if (!Number.isFinite(fraction)) return "0%";
  const value = pct(fraction);
  if (value > 0) return `+${value}%`;
  if (value < 0) return `−${Math.abs(value)}%`;
  return "0%";
}

const DID_METHODS: ReadonlySet<string> = new Set(["DID", "DID_SITE", "PRE_POST"]);

function headlinePrefix(outcome: SeoEvaluation["outcome"]): string {
  if (outcome === "WORKED") return "Worked";
  if (outcome === "DIDNT") return "Didn't work";
  return "No clear result";
}

export function outcomeHeadline(evaluation: SeoEvaluation): string {
  const { method, outcome } = evaluation;
  if (outcome === "INCONCLUSIVE") return "No clear result";
  const prefix = headlinePrefix(outcome);
  const worked = outcome === "WORKED";
  if (DID_METHODS.has(method)) {
    const metric = evaluation.metric;
    const label =
      metric === "ctr_adj" || metric === "clicks" || metric === "impressions"
        ? DID_METRIC_LABEL[metric]
        : null;
    if (evaluation.effect !== null && label) {
      return `${prefix}: ${percentChangeText(evaluation.effect)} ${label}`;
    }
    return prefix;
  }
  switch (method) {
    case "LAUNCH":
      return worked
        ? "Worked: the new page is getting search impressions"
        : "Didn't work: the new page isn't getting search traffic";
    case "ALERT":
      return worked
        ? "Worked: the issue stayed fixed"
        : "Didn't work: the issue came back";
    case "CRUX":
      return worked
        ? "Worked: page speed improved"
        : "Didn't work: page speed didn't improve";
    case "SITEMAP":
      return worked
        ? "Worked: the sitemap is clean"
        : "Didn't work: the sitemap still has errors";
    default:
      return prefix;
  }
}

function comparisonText(evaluation: SeoEvaluation): string | null {
  switch (evaluation.method) {
    case "DID":
      return evaluation.controls > 0
        ? `Compared with ${evaluation.controls} similar page${evaluation.controls === 1 ? "" : "s"}`
        : "Compared with similar pages on your site";
    case "DID_SITE":
      return "Compared with similar pages on your site";
    case "PRE_POST":
      return evaluation.yoyAdjusted
        ? "Before and after, adjusted for last year"
        : "Before and after only";
    default:
      return null;
  }
}

// İnsan okunur ayrıntı; yalnız şablon ve hesaplanmış yüzdeler.
export function outcomeDetail(evaluation: SeoEvaluation): string | null {
  const parts: string[] = [];
  const comparison = comparisonText(evaluation);
  if (comparison) parts.push(comparison);
  const reason = evaluation.reason;
  const intervalOk =
    reason === null || reason === "GOOGLE_UPDATE" || reason === "OVERLAPPING_CHANGE";
  if (
    DID_METHODS.has(evaluation.method) &&
    intervalOk &&
    evaluation.low !== null &&
    evaluation.high !== null
  ) {
    parts.push(
      `likely between ${percentChangeText(evaluation.low)} and ${percentChangeText(evaluation.high)}`,
    );
  }
  if (evaluation.updates.length > 0 && reason !== "GOOGLE_UPDATE") {
    parts.push("A Google update overlapped");
  }
  if (reason) parts.push(EVALUATION_REASON_TEXT[reason]);
  return parts.length > 0 ? parts.join(" · ") : null;
}

const ASK_TEXT: Readonly<Record<SeoFixKind, string>> = {
  TITLE_META: "Did you update this page's title and description?",
  CONTENT_REFRESH: "Did you refresh this page?",
  NEW_CONTENT: "Did you publish this page?",
  LOCALIZE: "Did you publish the translated page?",
  INTERNAL_LINKS: "Did you add these links?",
  CONSOLIDATE: "Did you merge these pages?",
  TECH_FIX: "Did you fix this problem?",
  SCHEMA: "Did you add the structured data?",
  CWV_FIX: "Did you speed up these pages?",
  SITEMAP_FIX: "Did you fix the sitemap?",
};

// Doğrulanamayan eylemde kullanıcıya sorulan soru.
export function askText(kind: SeoFixKind): string {
  return ASK_TEXT[kind];
}

const ISSUE_TEXT: Readonly<Record<string, string>> = {
  NOINDEX: "Remove the noindex tag",
  STATUS: "Make the page return a normal response",
  CANONICAL: "Point the canonical to the page itself",
  ROBOTS: "Allow crawling in robots.txt",
  REDIRECT: "Shorten the redirect chain",
  HREFLANG: "Fix the language alternates",
  OTHER: "Fix the reported technical problem",
};

const CWV_TEXT: Readonly<Record<string, string>> = {
  lcp: "Speed up the main content loading",
  inp: "Make the page respond faster to taps",
  cls: "Stop the layout from jumping while loading",
};

// Teklifin okunur satırları. primaryKeyword Google kaynaklıdır; hiçbir satıra
// girmez.
export function proposalLines(
  proposal: SeoActionProposalStored,
  pathOf: (url: string) => string,
): string[] {
  const lines: string[] = [];
  switch (proposal.kind) {
    case "TITLE_META":
      if (proposal.after) {
        lines.push(`New title: ${proposal.after.title}`);
        if (proposal.after.metaDescription) {
          lines.push(`New description: ${proposal.after.metaDescription}`);
        }
      } else if (proposal.variants.length > 0) {
        lines.push("Choose a new title and description");
      }
      break;
    case "CONTENT_REFRESH":
      if (proposal.missing.length > 0) {
        lines.push(`Cover: ${proposal.missing.join(", ")}`);
      }
      if (proposal.after) lines.push(`New title: ${proposal.after.title}`);
      break;
    case "NEW_CONTENT":
    case "LOCALIZE":
      if (proposal.title) lines.push(`Page: ${proposal.title}`);
      if (proposal.language) lines.push(`Language: ${proposal.language}`);
      if (proposal.liveUrl) lines.push(`Live at ${pathOf(proposal.liveUrl)}`);
      break;
    case "INTERNAL_LINKS":
      for (const link of proposal.links) {
        lines.push(
          `Link "${link.anchor}" from ${pathOf(link.fromUrl)} to ${pathOf(link.toUrl)}`,
        );
      }
      break;
    case "CONSOLIDATE":
      if (proposal.from.length > 0 && proposal.to) {
        lines.push(
          `Merge ${proposal.from.map(pathOf).join(", ")} into ${pathOf(proposal.to)}`,
        );
      }
      if (proposal.method === "REDIRECT") lines.push("Use a permanent redirect");
      if (proposal.method === "CANONICAL") lines.push("Use a canonical tag");
      break;
    case "TECH_FIX":
      lines.push(ISSUE_TEXT[proposal.issue] ?? ISSUE_TEXT.OTHER!);
      break;
    case "SCHEMA":
      if (proposal.types.length > 0) {
        lines.push(`Add structured data: ${proposal.types.join(", ")}`);
      }
      break;
    case "CWV_FIX":
      if (proposal.metric) lines.push(CWV_TEXT[proposal.metric] ?? "Improve page speed");
      break;
    case "SITEMAP_FIX":
      for (const url of proposal.sitemapUrls) lines.push(`Fix ${pathOf(url)}`);
      break;
  }
  if (proposal.note) lines.push(`Note: ${proposal.note}`);
  return lines;
}

const TITLE_PATH_MAX = 60;

export function actionTitle(kind: SeoFixKind, path: string | null): string {
  const label = FIX_KIND_LABEL[kind];
  if (!path) return label;
  const clamped =
    path.length > TITLE_PATH_MAX ? `${path.slice(0, TITLE_PATH_MAX - 1)}…` : path;
  return `${label} · ${clamped}`;
}

function metricNoun(metric: DidMetric): string {
  if (metric === "ctr_adj") return "click-through";
  if (metric === "clicks") return "clicks";
  return "search visibility";
}

// Öğrenme metni: yalnız WORKED için, rakamsız; yol, sorgu, adres ve tırnak
// içermez. Sayılar yalnız SeoAction.evaluation'da kalır.
export function learningInsight(input: {
  kind: SeoFixKind;
  metric: DidMetric;
}): string {
  const noun = metricNoun(input.metric);
  switch (input.kind) {
    case "TITLE_META":
      return `On this site, rewriting the title and meta description of a page to match what people search for raised ${noun} compared with similar pages.`;
    case "CONTENT_REFRESH":
      return `On this site, refreshing an existing page with what searchers were missing raised ${noun} compared with similar pages.`;
    case "INTERNAL_LINKS":
      return `On this site, adding internal links that point to a page raised its ${noun} compared with similar pages.`;
    case "SCHEMA":
      return `On this site, adding structured data to a page raised ${noun} compared with similar pages.`;
    case "CONSOLIDATE":
      return `On this site, merging overlapping pages into one stronger page raised ${noun} compared with similar pages.`;
    case "TECH_FIX":
      return `On this site, fixing a technical problem on a page raised its ${noun} compared with similar pages.`;
    case "NEW_CONTENT":
      return "On this site, publishing a new page for a topic people search for brought in search traffic.";
    case "LOCALIZE":
      return "On this site, publishing a translated page brought in search traffic from new readers.";
    case "CWV_FIX":
      return "On this site, speeding up slow pages improved their real-user loading speed.";
    case "SITEMAP_FIX":
      return "On this site, fixing the sitemap cleared its errors.";
  }
}

export const SUGGESTED_TOPIC_LABEL = "Suggested from Search Console";
