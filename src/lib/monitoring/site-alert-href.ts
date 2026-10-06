// Site uyarıları (GK8: AdsAlert.source; docs/measurement-health.md
// "Uyarılar") için kaynak listesi ve ekran bağlantıları. Saf ve ortam
// değişkeninden bağımsız: istemci tarafı, Today özeti ve journey de içe
// aktarabilir. Telegram metni (appUrl → env) site-alert-text.ts'te.

export type SiteAlertSource = "GA4" | "GSC" | "SEO";

export const SITE_ALERT_SOURCES: readonly SiteAlertSource[] = [
  "GA4",
  "GSC",
  "SEO",
];

export function isSiteAlertSource(value: unknown): value is SiteAlertSource {
  return (
    typeof value === "string" &&
    (SITE_ALERT_SOURCES as readonly string[]).includes(value)
  );
}

// dedupeKey her kaynakta kendi önekiyle başlar; SiteAlerts.raise uyuşmazlıkta
// hata verir.
export const SITE_ALERT_DEDUPE_PREFIX: Readonly<
  Record<SiteAlertSource, string>
> = {
  GA4: "ga4:",
  GSC: "gsc:",
  SEO: "seo:",
};

// Uyarının açıldığı ekran (göreli yol). GA4: Website sayfası açıksa ölçüm
// sağlığı paneli, değilse Integrations'taki GA diyaloğu. GSC/SEO: Search
// sayfasının sağlık bölümü.
export function siteAlertHref(input: {
  source: SiteAlertSource;
  projectId: string;
  websitePage: boolean;
}): string {
  if (input.source === "GA4") {
    return input.websitePage
      ? `/projects/${input.projectId}/site#measurement-health`
      : `/projects/${input.projectId}/integrations?integration=google_analytics`;
  }
  return `/projects/${input.projectId}/arama#health`;
}
