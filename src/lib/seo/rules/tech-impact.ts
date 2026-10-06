import { reachImpact } from "@/lib/seo/impact";
import type { SeoSeverity } from "@/lib/seo/opportunity-types";
import { TA_CATALOG, type TaCode } from "@/lib/seo/technical-audit";

import { techImpactCopy } from "./copy";
import {
  currentPageMetric,
  evidencePage,
  finishRule,
  makeDraft,
  type RankedDraft,
} from "./helpers";
import type { SeoRule } from "./types";

// SO16 teknik etki (tarama gerekir): WARN/CRITICAL sorunlu ve GSC sayfasına
// eşlenmiş taranan sayfalar sorun koduna göre toplanır; toplam şimdiki
// gösterim ≥ 100 ise ta:<kod> bulgusu (en çok 5 sayfa). Önem, sorunun
// sayfalardaki en yüksek önemidir. Başlık TA_CATALOG'dan gelir.

export const SO16_MIN_IMPRESSIONS = 100;
export const SO16_MAX_PAGES = 5;
export const SO16_MAX = 5;

const SEVERITY_RANK: Readonly<Record<SeoSeverity, number>> = {
  INFO: 0,
  WARN: 1,
  CRITICAL: 2,
};

function isTaCode(code: string): code is TaCode {
  return Object.prototype.hasOwnProperty.call(TA_CATALOG, code);
}

export const SO16: SeoRule = {
  key: "SO16_TECH_IMPACT",
  version: 1,
  querySignal: false,
  evaluate(snapshot) {
    const crawl = snapshot.crawl;
    if (!crawl) return { evaluable: false, reason: "NO_CRAWL" };
    const byCode = new Map<
      string,
      { pages: Map<string, number>; severity: SeoSeverity }
    >();
    for (const facts of crawl.pages) {
      if (!facts.pageId) continue;
      for (const issue of facts.issues) {
        if (issue.severity !== "WARN" && issue.severity !== "CRITICAL")
          continue;
        const entry = byCode.get(issue.code) ?? {
          pages: new Map<string, number>(),
          severity: issue.severity,
        };
        entry.pages.set(
          facts.pageId,
          currentPageMetric(snapshot, facts.pageId).impressions,
        );
        if (SEVERITY_RANK[issue.severity] > SEVERITY_RANK[entry.severity]) {
          entry.severity = issue.severity;
        }
        byCode.set(issue.code, entry);
      }
    }

    const items: RankedDraft[] = [];
    for (const [code, entry] of byCode) {
      if (!isTaCode(code)) continue;
      const impressions = [...entry.pages.values()].reduce((s, v) => s + v, 0);
      if (impressions < SO16_MIN_IMPRESSIONS) continue;
      const top = [...entry.pages]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, SO16_MAX_PAGES);
      const metrics = {
        pages: entry.pages.size,
        impressions: Math.round(impressions),
      };
      items.push({
        rank: impressions,
        draft: makeDraft(snapshot, {
          ruleKey: "SO16_TECH_IMPACT",
          kind: "RISK",
          subject: `ta:${code}`,
          severity: entry.severity,
          confidence: "SIGNIFICANT",
          effort: "VARIES",
          actionKind: "TECH_FIX",
          impact: reachImpact(impressions),
          ...techImpactCopy({ issueTitle: TA_CATALOG[code].title, ...metrics }),
          evidence: {
            window: snapshot.current,
            metrics,
            pages: top.map(([pageId]) =>
              evidencePage(
                snapshot,
                pageId,
                currentPageMetric(snapshot, pageId),
              ),
            ),
            issueCodes: [code],
          },
        }),
      });
    }
    return finishRule(items, SO16_MAX);
  },
};
