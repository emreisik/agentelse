import { siteAlertHref } from "@/lib/monitoring/site-alert-href";

import { WEBSITE_REPORT_VARIANTS, type WebsiteReportVariant } from "./types";

// GA-F5 kimlikleri ve ekran bağlantıları. Komut kimlikleri belirlenimcidir;
// aynı dönem iki kez gönderilmez (P2002 = "exists"). Saf ve izomorfik.

// Proje başına tek "Website analytics" Work'ü.
export const WEBSITE_WORK_PREFIX = "wkga_";
export const WEBSITE_WORK_TITLE = "Website analytics";
export const WEBSITE_WORK_MODULE = "analytics";

export function websiteWorkId(projectId: string): string {
  return `${WEBSITE_WORK_PREFIX}${projectId}`;
}

// Rapor komutlarının kimlik öneki; saklama temizliği ve bağlantı kesme
// önek üzerinden siler.
export const WEBSITE_REPORT_COMMAND_PREFIX = "garep_";

export function reportCommandPrefix(variant: WebsiteReportVariant): string {
  return `${WEBSITE_REPORT_COMMAND_PREFIX}${variant}_`;
}

export function reportCommandId(
  variant: WebsiteReportVariant,
  projectId: string,
  periodKey: string,
): string {
  return `${reportCommandPrefix(variant)}${projectId}_${periodKey}`;
}

// Uyarı kartının dönem anahtarı: şiddet anahtarın parçasıdır; WARN -> CRITICAL
// yükselmesi firstSeenAt'i korusa da yeni kart gönderilir.
export function alertPeriodKey(
  alertId: string,
  firstSeenAt: Date,
  severity: string,
): string {
  return `${alertId}_${firstSeenAt.getTime()}_${severity}`;
}

// Komut kimliğinden çeşit; tanınmayan kimlik null.
export function variantOfCommandId(id: string): WebsiteReportVariant | null {
  for (const variant of WEBSITE_REPORT_VARIANTS) {
    if (id.startsWith(reportCommandPrefix(variant))) return variant;
  }
  return null;
}

export type ReportHrefs = {
  website: string;
  integrations: string;
  measurement: string;
  insights: string;
  goals: string;
  settings: string;
  chat: string;
  finding: (id: string) => string;
};

// Kartlardaki bağlantılar. Website sayfasında "#insights" çapası yoktur:
// insights doğrudan sayfanın kendisidir; bulgular `#finding-<id>` çapasını
// kullanır.
export function reportHrefs(
  projectId: string,
  websitePage: boolean,
): ReportHrefs {
  const integrations = `/projects/${projectId}/integrations?integration=google_analytics`;
  const website = websitePage ? `/projects/${projectId}/site` : integrations;
  return {
    website,
    integrations,
    measurement: siteAlertHref({ source: "GA4", projectId, websitePage }),
    insights: website,
    goals: `/projects/${projectId}?panel=brand-brain&sub=goals`,
    settings: `/projects/${projectId}?panel=settings&sub=autonomy#website-reports`,
    chat: `/projects/${projectId}?work=${encodeURIComponent(websiteWorkId(projectId))}`,
    finding: (id: string) =>
      websitePage ? `/projects/${projectId}/site#finding-${id}` : website,
  };
}

// Erişimin kaybolduğu (yeniden bağlanma) uyarı türleri.
export const GA_RECONNECT_ALERT_KINDS: readonly string[] = ["GA_MH24"];

// Uyarı kartının "Open" bağlantısı: yeniden bağlanma Integrations'a, diğerleri
// ölçüm sağlığına gider.
export function alertHref(kind: string, hrefs: ReportHrefs): string {
  return GA_RECONNECT_ALERT_KINDS.includes(kind)
    ? hrefs.integrations
    : hrefs.measurement;
}
