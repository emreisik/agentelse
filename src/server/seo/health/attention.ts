import "server-only";

import { cache } from "react";

import { GscFlags } from "@/lib/seo/flags";
import { SeoFlags, seoWorkAllowedFor } from "@/lib/seo/health-flags";

import { listSearchAlerts } from "./alerts";

// Today özeti ve sıradaki adım için açık arama sağlığı uyarıları
// (docs/search-health.md "Arayüz"). Her Today görüntülemesinde ve journey
// yenilemesinde koşar: bayraklar (SEO_HEALTH + GSC_SEARCH_PAGE) ve izin
// listesi kapalıyken veritabanına hiç gitmez; React cache iki çağıranın tek
// okumayı paylaşmasını sağlar.

export type SearchAttention = {
  critical: { id: string; kind: string; title: string; href: string }[];
  criticalCount: number;
  warnCount: number;
  href: string;
};

const ATTENTION_ROWS = 10;
const CRITICAL_SHOWN = 2;

export function searchIssueHref(
  projectId: string,
  alertId?: string | null,
): string {
  return alertId
    ? `/projects/${projectId}/arama?issue=${encodeURIComponent(alertId)}#health`
    : `/projects/${projectId}/arama#health`;
}

export const loadSearchAttention = cache(
  async (projectId: string): Promise<SearchAttention | null> => {
    if (
      !SeoFlags.health() ||
      !GscFlags.searchPage() ||
      !seoWorkAllowedFor(projectId)
    ) {
      return null;
    }
    const rows = await listSearchAlerts(projectId, ATTENTION_ROWS);
    const critical = rows
      .filter((row) => row.severity === "CRITICAL")
      .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
    return {
      critical: critical.slice(0, CRITICAL_SHOWN).map((row) => ({
        id: row.id,
        kind: row.kind,
        title: row.title,
        href: searchIssueHref(projectId, row.id),
      })),
      criticalCount: critical.length,
      warnCount: rows.filter((row) => row.severity === "WARN").length,
      href: searchIssueHref(projectId),
    };
  },
);
