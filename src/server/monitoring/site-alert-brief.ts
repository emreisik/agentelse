import "server-only";

import {
  siteAlertBriefRows,
  type SiteAlertBriefRow,
} from "@/lib/monitoring/site-alert-brief";
import type { SiteAlertSource } from "@/lib/monitoring/site-alert-href";
import { GaFlags } from "@/lib/website-analytics/flags";
import { gaHealthEnabled } from "@/lib/website-analytics/health/flags";

import { SiteAlerts } from "./site-alerts";

// Today özetinin site uyarısı okuması (GA-F3): açık kaynak yoksa sorgu yok.

// Özete giren kaynaklar. SC-F3 (arama sağlığı) kendi bayrağıyla "GSC" ve
// "SEO" kaynaklarını buraya ekler.
export function siteAlertSourcesForBrief(): SiteAlertSource[] {
  return gaHealthEnabled() ? ["GA4"] : [];
}

export async function loadSiteAlertBrief(
  projectId: string,
  sources: readonly SiteAlertSource[],
): Promise<SiteAlertBriefRow[]> {
  if (sources.length === 0) return [];
  const alerts = await SiteAlerts.listOpen(projectId, [...sources], 10);
  return siteAlertBriefRows(alerts, {
    projectId,
    websitePage: GaFlags.websitePage(),
  });
}
