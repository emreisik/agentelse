// Sunucu tarafında kullanılır: crawl-url (node:crypto) içe aktarır, istemci
// bileşenleri bunu içe aktarmaz.
import { normalizeCrawlUrl } from "@/lib/seo/crawl-url";
import type { SeoEvidence } from "@/lib/seo/opportunity-types";

import {
  HEALTH_FIX_KINDS,
  fixKindForFinding,
  type SeoActionProposal,
  type SeoActionProposalStored,
  type SeoFixKind,
  type TechIssue,
} from "./types";

// Bulgu ya da sağlık uyarısından eylem taslağı
// (docs/google-search-console-plan.md SC-F6 "Fix this"). Saf; veritabanı yok.
// Google'dan gelen anahtar kelime yalnız proposal.primaryKeyword'de durur,
// başka hiçbir alana (başlık, konu) yazılmaz.

export type ActionDraft = {
  kind: SeoFixKind;
  targetUrl: string | null;
  pageId: string | null;
  targetQueries: string[];
  proposal: SeoActionProposalStored;
  managerMode: "snippet" | "refresh" | "article" | null;
};

const QUERIES_MAX = 10;
const LINKS_MAX = 5;
const CONSOLIDATE_FROM_MAX = 4;
const ISSUE_CODES_MAX = 10;

function originOf(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

// Sitenin kökeni: tarayıcının kaydı varsa o, yoksa GSC mülkü (URL öneki ya da
// sc-domain). Sonda eğik çizgi yoktur.
export function originFor(input: {
  siteOrigin: string | null;
  gscSiteUrl: string | null;
}): string | null {
  const fromSite = originOf(input.siteOrigin);
  if (fromSite) return fromSite;
  const gsc = input.gscSiteUrl?.trim() ?? "";
  if (gsc.startsWith("sc-domain:")) {
    const domain = gsc.slice("sc-domain:".length).trim().toLowerCase();
    return domain ? originOf(`https://${domain}`) : null;
  }
  return originOf(gsc);
}

// Maskelenmiş yol ("[id]", "[email]" ...) içeren ya da normalleşmeyen adres
// kullanılamaz.
export function usableUrl(url: string | null): string | null {
  if (!url || url.includes("[")) return null;
  return normalizeCrawlUrl(url);
}

function join(origin: string | null, path: string | null | undefined): string | null {
  if (!origin || !path) return null;
  return usableUrl(`${origin}${path.startsWith("/") ? path : `/${path}`}`);
}

// Bulgunun taslağa gereken alanları (SeoFindingView'in alt kümesi).
export type FindingForDraft = {
  id: string;
  actionKind: string;
  evidence: SeoEvidence;
  pageId: string | null;
  queryId: string | null;
  keyword: string | null;
};

function techIssueFromCode(code: string | undefined): TechIssue {
  const match = /^TA(\d+)/.exec(code ?? "");
  switch (match?.[1]) {
    case "7":
      return "NOINDEX";
    case "9":
    case "10":
      return "STATUS";
    case "8":
      return "CANONICAL";
    case "11":
      return "REDIRECT";
    case "20":
      return "HREFLANG";
    default:
      return "OTHER";
  }
}

function withEnvelope(
  body: SeoActionProposal,
  alert: SeoActionProposalStored["alert"] = null,
): SeoActionProposalStored {
  return { ...body, v: 1, note: null, alert };
}

export function actionDraftFromFinding(
  finding: FindingForDraft,
  origin: string | null,
): ActionDraft | null {
  const kind = fixKindForFinding(finding.actionKind);
  if (kind === null) return null;
  const evidence = finding.evidence;
  const pages = evidence.pages ?? [];
  const first = pages[0];
  const targetUrl =
    usableUrl(first?.url ?? null) ?? join(origin, first?.path ?? null);
  const targetQueries = [
    ...new Set(
      [finding.queryId, ...(evidence.queries ?? []).map((q) => q.queryId)].filter(
        (id): id is string => typeof id === "string" && id.length > 0,
      ),
    ),
  ].slice(0, QUERIES_MAX);
  const base = {
    kind,
    targetUrl,
    pageId: finding.pageId ?? first?.pageId ?? null,
    targetQueries,
  };
  switch (kind) {
    case "TITLE_META":
      return {
        ...base,
        proposal: withEnvelope({ kind, before: null, after: null, variants: [] }),
        managerMode: "snippet",
      };
    case "CONTENT_REFRESH":
      return {
        ...base,
        proposal: withEnvelope({
          kind,
          primaryKeyword: finding.keyword,
          missing: [],
          after: null,
        }),
        managerMode: "refresh",
      };
    case "NEW_CONTENT":
    case "LOCALIZE":
      return {
        ...base,
        proposal: withEnvelope({
          kind,
          title: "",
          primaryKeyword: finding.keyword,
          language: null,
          liveUrl: null,
        }),
        managerMode: "article",
      };
    case "INTERNAL_LINKS": {
      const links: { fromUrl: string; toUrl: string; anchor: string }[] = [];
      for (const link of evidence.links ?? []) {
        const fromUrl = join(origin, link.fromPath);
        const toUrl = join(origin, link.toPath);
        if (fromUrl && toUrl) links.push({ fromUrl, toUrl, anchor: link.anchor });
        if (links.length >= LINKS_MAX) break;
      }
      return {
        ...base,
        proposal: withEnvelope({ kind, links }),
        managerMode: null,
      };
    }
    case "CONSOLIDATE": {
      const from = pages
        .slice(1)
        .map((page) => usableUrl(page.url) ?? join(origin, page.path))
        .filter((url): url is string => url !== null)
        .slice(0, CONSOLIDATE_FROM_MAX);
      return {
        ...base,
        proposal: withEnvelope({ kind, from, to: targetUrl ?? "", method: null }),
        managerMode: null,
      };
    }
    case "TECH_FIX":
      return {
        ...base,
        proposal: withEnvelope({
          kind,
          issue: techIssueFromCode(evidence.issueCodes?.[0]),
          issueCodes: (evidence.issueCodes ?? []).slice(0, ISSUE_CODES_MAX),
        }),
        managerMode: null,
      };
    case "SCHEMA":
      return {
        ...base,
        proposal: withEnvelope({ kind, types: [] }),
        managerMode: null,
      };
    default:
      // CWV_FIX ve SITEMAP_FIX bulgudan doğmaz (yalnız sağlık uyarısından).
      return null;
  }
}

// "I fixed this" (sağlık sorunu): yalnız HEALTH_FIX_KINDS'teki uyarılar.
// Tek bir yol varsa o sayfa hedeftir; aksi hâlde hedef yoktur (ana sayfa
// varsayılmaz).
export function actionDraftFromHealthIssue(input: {
  alertKind: string;
  alertSource: "GSC" | "SEO";
  dedupeKey: string;
  origin: string | null;
  alertPaths: readonly string[];
}): ActionDraft | null {
  const mapping = HEALTH_FIX_KINDS[input.alertKind];
  if (!mapping) return null;
  const { kind } = mapping;
  const alert = {
    kind: input.alertKind,
    dedupeKey: input.dedupeKey,
    source: input.alertSource,
  };
  const targetUrl =
    (kind === "TECH_FIX" || kind === "SCHEMA") && input.alertPaths.length === 1
      ? join(input.origin, input.alertPaths[0])
      : null;
  let body: SeoActionProposal;
  switch (kind) {
    case "TECH_FIX":
      body = { kind, issue: mapping.issue ?? "OTHER", issueCodes: [] };
      break;
    case "SCHEMA":
      body = { kind, types: [] };
      break;
    case "CWV_FIX":
      body = { kind, metric: null, formFactor: null };
      break;
    case "SITEMAP_FIX":
      body = { kind, sitemapUrls: [] };
      break;
    default:
      return null;
  }
  return {
    kind,
    targetUrl,
    pageId: null,
    targetQueries: [],
    proposal: withEnvelope(body, alert),
    managerMode: null,
  };
}
