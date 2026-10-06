import type {
  SeoReportOpportunity,
  SeoRoadmapItem,
  SeoSeverity,
} from "./types";

// SEO yol haritası sıralaması (docs/search-reports.md "Yol haritası"). LLM yok,
// saf: önce CRITICAL uyarılar ("Fix first"), sonra W3 fırsatları (verilen
// sırada), fırsat yoksa hızlı kazanımlar. Teknik borç: WARN ve INFO uyarılar,
// ardından site denetimi grupları.

export const ROADMAP_ACTION_LIMIT = 10;
export const ROADMAP_DEBT_LIMIT = 10;

export type RoadmapInput = {
  opportunities: readonly SeoReportOpportunity[];
  alerts: readonly { kind: string; title: string; severity: SeoSeverity }[];
  audit: readonly { title: string; severity: SeoSeverity; count: number }[];
  quickWins: readonly {
    query: string;
    impressions: number;
    position: number;
  }[];
};

const SEVERITY_RANK: Readonly<Record<SeoSeverity, number>> = {
  CRITICAL: 3,
  WARN: 2,
  INFO: 1,
};

function item(
  partial: Pick<SeoRoadmapItem, "title" | "action" | "source"> &
    Partial<SeoRoadmapItem>,
): SeoRoadmapItem {
  return {
    findingId: null,
    impactPerMonth: null,
    effort: null,
    severity: null,
    count: null,
    ...partial,
  };
}

export function buildRoadmap(input: RoadmapInput): {
  actions: SeoRoadmapItem[];
  techDebt: SeoRoadmapItem[];
} {
  const actions: SeoRoadmapItem[] = [];
  const seenActions = new Set<string>();

  for (const alert of input.alerts) {
    if (alert.severity !== "CRITICAL" || seenActions.has(alert.title)) continue;
    seenActions.add(alert.title);
    actions.push(
      item({
        title: alert.title,
        action: "Fix first",
        source: "health",
        severity: "CRITICAL",
      }),
    );
  }
  for (const opportunity of input.opportunities) {
    actions.push(
      item({
        title: opportunity.title,
        action: opportunity.action,
        source: "opportunity",
        findingId: opportunity.id,
        impactPerMonth: opportunity.impactPerMonth,
        effort: opportunity.effort,
      }),
    );
  }
  // Hızlı kazanımlar yalnız hiç fırsat yokken devreye girer.
  if (input.opportunities.length === 0) {
    for (const win of input.quickWins) {
      actions.push(
        item({
          title: `Improve the page that ranks for “${win.query}”`,
          action: "Title & content",
          source: "quick_win",
        }),
      );
    }
  }

  const techDebt: SeoRoadmapItem[] = [];
  const seenDebt = new Set<string>();
  const addDebt = (debt: SeoRoadmapItem) => {
    if (seenDebt.has(debt.title)) return;
    seenDebt.add(debt.title);
    techDebt.push(debt);
  };
  for (const severity of ["WARN", "INFO"] as const) {
    for (const alert of input.alerts) {
      if (alert.severity !== severity) continue;
      addDebt(
        item({
          title: alert.title,
          action: severity === "WARN" ? "Fix soon" : "Keep an eye on it",
          source: "health",
          severity,
        }),
      );
    }
  }
  const groups = [...input.audit].sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      b.count - a.count ||
      a.title.localeCompare(b.title),
  );
  for (const group of groups) {
    addDebt(
      item({
        title: group.title,
        action: "Fix across the site",
        source: "audit",
        severity: group.severity,
        count: group.count,
      }),
    );
  }

  return {
    actions: actions.slice(0, ROADMAP_ACTION_LIMIT),
    techDebt: techDebt.slice(0, ROADMAP_DEBT_LIMIT),
  };
}
