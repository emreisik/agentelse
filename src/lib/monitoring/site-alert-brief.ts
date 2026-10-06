import { siteAlertHref, type SiteAlertSource } from "./site-alert-href";

// Today özetindeki site uyarısı satırları (GA-F3): yalnız CRITICAL, en çok
// iki, gelen sırayla (listOpen önce en ciddi ve en yeni). Saf; bağlantılar
// ortamdan bağımsız site-alert-href'ten.

export type SiteAlertBriefRow = {
  id: string;
  source: SiteAlertSource;
  title: string;
  severity: "WARN" | "CRITICAL";
  href: string;
};

export const MAX_SITE_ALERT_BRIEF_ROWS = 2;

export function siteAlertBriefRows(
  alerts: readonly {
    id: string;
    source: SiteAlertSource;
    severity: "INFO" | "WARN" | "CRITICAL";
    title: string;
  }[],
  input: { projectId: string; websitePage: boolean },
): SiteAlertBriefRow[] {
  return alerts
    .filter((alert) => alert.severity === "CRITICAL")
    .slice(0, MAX_SITE_ALERT_BRIEF_ROWS)
    .map((alert) => ({
      id: `site-${alert.id}`,
      source: alert.source,
      title: alert.title,
      severity: "CRITICAL" as const,
      href: siteAlertHref({
        source: alert.source,
        projectId: input.projectId,
        websitePage: input.websitePage,
      }),
    }));
}
