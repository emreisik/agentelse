import "server-only";

import { prisma } from "@/lib/prisma";
import { GscFlags } from "@/lib/seo/flags";
import {
  SeoInsightFlags,
  seoInsightsAllowedFor,
} from "@/lib/seo/insight-flags";
import type {
  SeoActionKind,
  SeoConfidence,
  SeoEffort,
  SeoImpact,
} from "@/lib/seo/opportunity-types";
import { isPlatformOperator } from "@/server/security/operator";
import {
  listProjectFindings,
  resolveFindingHighlight,
  type SeoFindingView,
} from "@/server/seo/opportunities/findings-store";
import { readEngineState } from "@/server/seo/opportunities/state";
import { primaryGscLink } from "@/server/seo/store";

// Search sayfasındaki "Opportunities" bölümünün verisi (SC-F4,
// docs/search-opportunities.md). SEO_INSIGHTS, GSC_SEARCH_PAGE ya da açılış
// listesi kapalıyken veritabanına hiç gitmez. Gölge kipte yalnız platform
// operatörü kendi erişebildiği projede gölge bulguları inceler; kullanıcı
// hiçbir şey görmez. Etiketler sabit İngilizcedir; bulgunun başlığı ve özeti
// kuralın kendi metnidir (sayılar kanıttan).

export type OpportunityItem = SeoFindingView & {
  actionLabel: string;
  impactLabel: string | null;
  confidenceLabel: "Solid" | "Directional";
  effortLabel: string;
  highlighted: boolean;
};

export type OpportunitiesPanel = {
  projectId: string;
  mode: "shadow" | "on";
  state: "collecting" | "low_data" | "ready";
  week: string | null;
  lastRunAt: Date | null;
  items: OpportunityItem[];
  accepted: OpportunityItem[];
  shadowReview: OpportunityItem[] | null;
  counts: { open: number; accepted: number; done30d: number };
  notes: string[];
};

export const ACTION_LABEL: Readonly<Record<SeoActionKind, string>> = {
  TITLE_META: "Fix the snippet",
  CONTENT_REFRESH: "Refresh the page",
  NEW_CONTENT: "Write a new page",
  INTERNAL_LINKS: "Add internal links",
  CONSOLIDATE: "Merge or separate pages",
  TECH_FIX: "Fix the technical issue",
  SCHEMA: "Add structured data",
  LOCALIZE: "Add a localized version",
  INVESTIGATE: "Look into it",
};

export const EFFORT_LABEL: Readonly<Record<SeoEffort, string>> = {
  S: "Quick fix",
  M: "Some work",
  L: "Bigger project",
  VARIES: "Varies",
};

export const LOW_DATA_NOTE =
  "Your site gets fewer than 1,000 search impressions a month, so opportunities focus on content and indexing first.";
export const COLLECTING_NOTE =
  "We need four complete weeks of Search Console data before we suggest opportunities.";

const ITEM_LIMIT = 20;
const ACCEPTED_LIMIT = 10;
const SHADOW_LIMIT = 30;
const DONE_WINDOW_MS = 30 * 24 * 3_600_000;

const COUNT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

// "Expected +120 clicks/month" (yön gösteren tahminde " (directional)") ya
// da erişim etkisi "Affects pages with 3,400 impressions a month".
export function impactLabel(
  impact: SeoImpact | null,
  confidence: SeoConfidence,
): string | null {
  if (!impact) return null;
  if (impact.kind === "clicks") {
    if (!Number.isFinite(impact.perMonth) || impact.perMonth < 1) return null;
    const label = `Expected +${COUNT.format(impact.perMonth)} clicks/month`;
    return confidence === "DIRECTIONAL" ? `${label} (directional)` : label;
  }
  if (
    !Number.isFinite(impact.impressionsPerMonth) ||
    impact.impressionsPerMonth < 1
  ) {
    return null;
  }
  return `Affects pages with ${COUNT.format(impact.impressionsPerMonth)} impressions a month`;
}

function itemOf(
  view: SeoFindingView,
  highlight: string | null,
): OpportunityItem {
  return {
    ...view,
    actionLabel: ACTION_LABEL[view.actionKind] ?? ACTION_LABEL.INVESTIGATE,
    impactLabel: impactLabel(view.impact, view.confidence),
    confidenceLabel:
      view.confidence === "SIGNIFICANT" ? "Solid" : "Directional",
    effortLabel: EFFORT_LABEL[view.effort] ?? EFFORT_LABEL.VARIES,
    highlighted: highlight !== null && view.id === highlight,
  };
}

// lastRunStats Json'ı yalnız runner yazar; burada yalnız lowData okunur.
function lowDataOf(stats: unknown): boolean {
  return (
    typeof stats === "object" &&
    stats !== null &&
    (stats as { lowData?: unknown }).lowData === true
  );
}

function highlightId(value: string | null | undefined): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value)
    ? value
    : null;
}

export async function loadOpportunitiesPanel(
  projectId: string,
  options: { userId: string; now?: Date; highlight?: string | null },
): Promise<OpportunitiesPanel | null> {
  // Bayraklar ve izin listesi yalnız ortamdan okunur: kapalıyken sorgu yok.
  if (!SeoInsightFlags.active() || !GscFlags.searchPage()) return null;
  if (!seoInsightsAllowedFor(projectId)) return null;
  const mode: "shadow" | "on" =
    SeoInsightFlags.mode() === "on" ? "on" : "shadow";
  if (mode === "shadow" && !isPlatformOperator(options.userId)) return null;

  const now = options.now ?? new Date();
  const link = await primaryGscLink(projectId);
  if (!link) return null;
  const engine = await readEngineState(link.id);
  const week = engine?.lastWeek ?? null;
  const state: OpportunitiesPanel["state"] =
    !engine || week === null
      ? "collecting"
      : lowDataOf(engine.lastRunStats)
        ? "low_data"
        : "ready";
  const notes =
    state === "collecting"
      ? [COLLECTING_NOTE]
      : state === "low_data"
        ? [LOW_DATA_NOTE]
        : [];
  const base = {
    projectId,
    mode,
    state,
    week,
    lastRunAt: engine?.lastRunAt ?? null,
    notes,
  };
  // Motor henüz bir hafta değerlendirmediyse bulgu yoktur.
  if (state === "collecting") {
    return {
      ...base,
      items: [],
      accepted: [],
      shadowReview: mode === "shadow" ? [] : null,
      counts: { open: 0, accepted: 0, done30d: 0 },
    };
  }

  const requested = highlightId(options.highlight);
  const highlight = requested
    ? await resolveFindingHighlight(projectId, requested).catch(() => null)
    : null;

  if (mode === "shadow") {
    const [shadow, open] = await Promise.all([
      listProjectFindings(projectId, {
        statuses: ["OPEN"],
        shadow: true,
        limit: SHADOW_LIMIT,
      }),
      prisma.seoFinding.count({
        where: { linkId: link.id, status: "OPEN", shadow: true },
      }),
    ]);
    return {
      ...base,
      items: [],
      accepted: [],
      shadowReview: shadow.map((view) => itemOf(view, highlight)),
      counts: { open, accepted: 0, done30d: 0 },
    };
  }

  const [items, accepted, open, acceptedCount, done30d] = await Promise.all([
    listProjectFindings(projectId, {
      statuses: ["OPEN"],
      shadow: false,
      limit: ITEM_LIMIT,
    }),
    listProjectFindings(projectId, {
      statuses: ["ACCEPTED"],
      shadow: false,
      limit: ACCEPTED_LIMIT,
    }),
    prisma.seoFinding.count({
      where: { linkId: link.id, status: "OPEN", shadow: false },
    }),
    prisma.seoFinding.count({
      where: { linkId: link.id, status: "ACCEPTED", shadow: false },
    }),
    prisma.seoFinding.count({
      where: {
        linkId: link.id,
        status: "DONE",
        shadow: false,
        decidedAt: { gte: new Date(now.getTime() - DONE_WINDOW_MS) },
      },
    }),
  ]);
  return {
    ...base,
    items: items.map((view) => itemOf(view, highlight)),
    accepted: accepted.map((view) => itemOf(view, highlight)),
    shadowReview: null,
    counts: { open, accepted: acceptedCount, done30d },
  };
}
