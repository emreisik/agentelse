import type { ParsedRobots } from "@/lib/seo/robots-parser";

import { GEO_CHECKS } from "./catalog";
import { crawlerRows, searchBlocked, trainingBlocked } from "./crawlers";
import { brandMatches } from "./entities";
import { parseLlmsTxt } from "./llms";
import { isQuestionHeading } from "./questions";
import {
  GEO_CHECK_IDS,
  isAcknowledgeable,
  type GeoAuditResult,
  type GeoCheckId,
  type GeoCheckResult,
  type GeoCrawlerRow,
  type GeoFacts,
  type GeoStatus,
  type LlmsFacts,
  type OrgFacts,
} from "./types";

// GEO1-GEO11 değerlendirmesi (SC-F8, docs/ai-search-visibility.md): saf ve
// belirleyici. Aynı girdi her zaman aynı JSON'u verir. Puan = 100 × Σ(ağırlık ×
// değer) / Σ(ağırlık) yalnız puanlı ve NA/ACK olmayan kontroller üzerinden
// (PASS 1, INFO 0.5, WARN 0); hiçbiri uygulanmıyorsa null. ACK ("I decided
// this") yalnız GEO2 ve GEO9 için ve altta yatan durum WARN iken uygulanır.

export type GeoInput = {
  robots: ParsedRobots | null;
  robotsVerdict: string | null;
  llms: { state: LlmsFacts["state"]; text: string | null };
  home: {
    status: number | null;
    schemaTypes: string[];
    renderRisk: boolean;
    title: string | null;
    org: OrgFacts | null;
  } | null;
  pages: {
    path: string;
    wordCount: number | null;
    schemaTypes: string[];
    h2: string[];
    robotsMeta: string | null;
    xRobotsTag: string | null;
    indexable: boolean | null;
    status: number | null;
  }[];
  brandName: string | null;
  connectedHandles: string[];
  acknowledged: readonly GeoCheckId[];
  now: Date;
};

export const GEO_MIN_PAGES = 5;
export const GEO_CONTENT_WORDS = 300;
export const GEO_LONG_WORDS = 600;
export const GEO_QUESTION_SHARE = 0.2;
export const GEO_LONG_NO_H2_SHARE = 0.2;
export const GEO_SAME_AS_HOSTS = 2;

const VALUE: Record<GeoStatus, number | null> = {
  PASS: 1,
  INFO: 0.5,
  WARN: 0,
  NA: null,
  ACK: null,
};

function pct(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((100 * part) / whole);
}

function robotsKnown(input: GeoInput): boolean {
  if (input.robots !== null) return true;
  // robots.txt yoksa (404) her şey serbesttir; ulaşılamıyorsa bilinmez.
  return input.robotsVerdict === "MISSING";
}

function homeUsable(input: GeoInput): GeoInput["home"] {
  const home = input.home;
  if (!home || home.status === null) return null;
  return home.status >= 200 && home.status < 300 ? home : null;
}

function result(
  id: GeoCheckId,
  status: GeoStatus,
  facts: GeoFacts = {},
): GeoCheckResult {
  return { id, status, facts };
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function schemaHas(types: readonly string[], wanted: readonly string[]) {
  const lower = new Set(types.map((type) => type.toLowerCase()));
  return wanted.some((type) => lower.has(type.toLowerCase()));
}

const SNIPPET_BLOCK = /(?:^|[\s,:;])nosnippet(?:$|[\s,;])|max-snippet\s*:\s*0(?!\d)/i;

function blocksSnippet(page: GeoInput["pages"][number]): boolean {
  return [page.robotsMeta, page.xRobotsTag].some(
    (value) => value !== null && SNIPPET_BLOCK.test(value),
  );
}

export function llmsFactsOf(input: GeoInput["llms"]): LlmsFacts {
  const { state, text } = input;
  if (state === "present" || state === "invalid") {
    if (text === null) {
      return { state: "unknown", bytes: 0, hasTitle: false, links: 0, sections: 0 };
    }
    const parsed = parseLlmsTxt(text);
    return {
      state: parsed.valid && parsed.hasTitle ? "present" : "invalid",
      bytes: parsed.bytes,
      hasTitle: parsed.hasTitle,
      links: parsed.links,
      sections: parsed.sections,
    };
  }
  return { state, bytes: 0, hasTitle: false, links: 0, sections: 0 };
}

function checkLlms(llms: LlmsFacts): GeoCheckResult {
  const facts: GeoFacts = {
    state: llms.state,
    bytes: llms.bytes,
    hasTitle: llms.hasTitle,
    links: llms.links,
    sections: llms.sections,
  };
  switch (llms.state) {
    case "present":
      return result("GEO1", "PASS", facts);
    case "invalid":
      return result("GEO1", "WARN", facts);
    case "missing":
      return result("GEO1", "INFO", facts);
    default:
      return result("GEO1", "NA", facts);
  }
}

function checkSearchCrawlers(
  known: boolean,
  rows: readonly GeoCrawlerRow[],
): GeoCheckResult {
  if (!known) return result("GEO2", "NA");
  const searchRows = rows.filter((row) => row.purpose === "search");
  const blocked = searchBlocked(rows);
  const facts: GeoFacts = {
    allowed: searchRows.length - blocked.length,
    blockedCount: blocked.length,
    blocked,
  };
  return result("GEO2", blocked.length === 0 ? "PASS" : "WARN", facts);
}

function checkTrainingCrawlers(
  known: boolean,
  rows: readonly GeoCrawlerRow[],
): GeoCheckResult {
  if (!known) return result("GEO3", "NA");
  const trainingRows = rows.filter((row) => row.purpose === "training");
  const blocked = trainingBlocked(rows);
  return result("GEO3", "INFO", {
    allowed: trainingRows.length - blocked.length,
    blockedCount: blocked.length,
    blocked,
  });
}

function checkHomeHtml(input: GeoInput): GeoCheckResult {
  const home = homeUsable(input);
  if (!home) return result("GEO4", "NA");
  return result("GEO4", home.renderRisk ? "WARN" : "PASS", {
    renderRisk: home.renderRisk,
  });
}

function checkOrganization(input: GeoInput): GeoCheckResult {
  const home = homeUsable(input);
  if (!home) return result("GEO5", "NA");
  const org = home.org;
  if (org?.present) {
    return result("GEO5", "PASS", {
      types: org.types,
      hasLogo: org.hasLogo,
      hasName: org.name !== null,
    });
  }
  return result("GEO5", "WARN", { types: [], hasLogo: false, hasName: false });
}

function checkSameAs(input: GeoInput): GeoCheckResult {
  const org = homeUsable(input)?.org;
  if (!org?.present) return result("GEO6", "NA");
  const hosts = new Set<string>();
  for (const url of org.sameAs) {
    const host = hostOf(url);
    if (host) hosts.add(host);
  }
  const handles = input.connectedHandles
    .map((handle) => handle.replace(/^@/, "").trim().toLowerCase())
    .filter((handle) => handle.length >= 2);
  const facts: GeoFacts = {
    sameAsCount: org.sameAs.length,
    hosts: hosts.size,
  };
  if (hosts.size < GEO_SAME_AS_HOSTS) return result("GEO6", "WARN", facts);
  const linked =
    handles.length === 0 ||
    org.sameAs.some((url) =>
      handles.some((handle) => url.toLowerCase().includes(handle)),
    );
  return result("GEO6", linked ? "PASS" : "INFO", {
    ...facts,
    connectedHandles: handles.length,
  });
}

function indexablePages(input: GeoInput) {
  return input.pages.filter((page) => page.indexable === true);
}

function checkStructuredAnswers(input: GeoInput): GeoCheckResult {
  const indexable = indexablePages(input);
  if (indexable.length < GEO_MIN_PAGES) return result("GEO7", "NA");
  const withFaq = indexable.filter((page) =>
    schemaHas(page.schemaTypes, ["FAQPage", "HowTo"]),
  ).length;
  return result("GEO7", withFaq > 0 ? "PASS" : "INFO", {
    indexable: indexable.length,
    withFaqSchema: withFaq,
  });
}

function contentPages(input: GeoInput) {
  return indexablePages(input).filter(
    (page) => (page.wordCount ?? 0) >= GEO_CONTENT_WORDS,
  );
}

function checkQuestionHeadings(input: GeoInput): GeoCheckResult {
  const content = contentPages(input);
  if (content.length < GEO_MIN_PAGES) return result("GEO8", "NA");
  const withQuestions = content.filter((page) =>
    page.h2.some(isQuestionHeading),
  ).length;
  const share = withQuestions / content.length;
  return result("GEO8", share >= GEO_QUESTION_SHARE ? "PASS" : "WARN", {
    contentPages: content.length,
    withQuestionHeadings: withQuestions,
    sharePct: pct(withQuestions, content.length),
  });
}

function checkSnippetControls(input: GeoInput): GeoCheckResult {
  const indexable = indexablePages(input);
  if (indexable.length === 0) return result("GEO9", "NA");
  const blocked = indexable.filter(blocksSnippet).length;
  return result("GEO9", blocked === 0 ? "PASS" : "WARN", {
    indexable: indexable.length,
    snippetBlocked: blocked,
  });
}

function checkStructure(input: GeoInput): GeoCheckResult {
  const long = indexablePages(input).filter(
    (page) => (page.wordCount ?? 0) >= GEO_LONG_WORDS,
  );
  if (long.length === 0) return result("GEO10", "NA");
  const withoutH2 = long.filter((page) => page.h2.length === 0).length;
  const share = withoutH2 / long.length;
  return result("GEO10", share < GEO_LONG_NO_H2_SHARE ? "PASS" : "WARN", {
    longPages: long.length,
    longWithoutHeadings: withoutH2,
    sharePct: pct(withoutH2, long.length),
  });
}

function checkEntityConsistency(input: GeoInput): GeoCheckResult {
  const home = homeUsable(input);
  const orgName = home?.org?.name ?? null;
  const title = home?.title?.trim() || null;
  const brand = input.brandName?.trim() || null;
  if (!orgName || !title || !brand) return result("GEO11", "NA");
  const nameAgrees = brandMatches(orgName, brand);
  const titleMentions = brandMatches(title, brand);
  return result("GEO11", nameAgrees && titleMentions ? "PASS" : "INFO", {
    nameAgrees,
    titleMentionsBrand: titleMentions,
  });
}

function scoreOf(checks: readonly GeoCheckResult[]): number | null {
  let weighted = 0;
  let total = 0;
  for (const check of checks) {
    const def = GEO_CHECKS[check.id];
    if (!def.scored) continue;
    const value = VALUE[check.status];
    if (value === null) continue;
    weighted += def.weight * value;
    total += def.weight;
  }
  return total === 0 ? null : Math.round((100 * weighted) / total);
}

// Kabul edilen kontrollerde WARN → ACK; diğer durumlar olduğu gibi kalır.
function applyAcknowledgements(
  checks: readonly GeoCheckResult[],
  acknowledged: readonly GeoCheckId[],
): GeoCheckResult[] {
  const wanted = new Set<GeoCheckId>(
    acknowledged.filter((id) => isAcknowledgeable(id)),
  );
  return checks.map((check) =>
    wanted.has(check.id) && check.status === "WARN"
      ? { ...check, status: "ACK" as const }
      : check,
  );
}

function ordered(checks: readonly GeoCheckResult[]): GeoCheckResult[] {
  return GEO_CHECK_IDS.flatMap((id) => {
    const found = checks.find((check) => check.id === id);
    return found ? [found] : [];
  });
}

export function evaluateGeo(input: GeoInput): GeoAuditResult {
  const known = robotsKnown(input);
  const crawlers = known ? crawlerRows(input.robots) : [];
  const llms = llmsFactsOf(input.llms);

  const base: GeoCheckResult[] = [
    checkLlms(llms),
    checkSearchCrawlers(known, crawlers),
    checkTrainingCrawlers(known, crawlers),
    checkHomeHtml(input),
    checkOrganization(input),
    checkSameAs(input),
    checkStructuredAnswers(input),
    checkQuestionHeadings(input),
    checkSnippetControls(input),
    checkStructure(input),
    checkEntityConsistency(input),
  ];
  const checks = applyAcknowledgements(base, input.acknowledged);

  const indexable = indexablePages(input);
  const content = contentPages(input);
  const long = indexable.filter(
    (page) => (page.wordCount ?? 0) >= GEO_LONG_WORDS,
  );
  const home = homeUsable(input);
  return {
    v: 1,
    score: scoreOf(checks),
    checks: ordered(checks),
    crawlers,
    llms,
    org: input.home?.org ?? null,
    pages: {
      audited: input.pages.length,
      indexable: indexable.length,
      withFaqSchema: indexable.filter((page) =>
        schemaHas(page.schemaTypes, ["FAQPage", "HowTo"]),
      ).length,
      withQuestionHeadings: content.filter((page) =>
        page.h2.some(isQuestionHeading),
      ).length,
      longWithoutHeadings: long.filter((page) => page.h2.length === 0).length,
      snippetBlocked: indexable.filter(blocksSnippet).length,
      renderRisk: home?.renderRisk ? 1 : 0,
    },
    auditedAt: input.now.toISOString(),
  };
}

// Yeni denetim yapmadan kabulleri yeniden uygular: önceki ACK'lar WARN'a döner,
// sonra verilen liste uygulanır. evaluateGeo ile aynı kabuller aynı sonucu verir.
export function rescore(
  result: GeoAuditResult,
  acknowledged: readonly GeoCheckId[],
): GeoAuditResult {
  const undone = result.checks.map((check) =>
    check.status === "ACK" ? { ...check, status: "WARN" as const } : check,
  );
  const checks = applyAcknowledgements(undone, acknowledged);
  return { ...result, checks, score: scoreOf(checks) };
}
