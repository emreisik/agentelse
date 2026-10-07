// Google Analytics ve Search Console iki ayrı entegrasyondur: her birinin kendi
// onay ekranı (yalnız kendi izni), kendi refresh token'ı ve kendi
// IntegrationCredential satırı vardır; farklı Google hesaplarıyla bağlanıp
// ayrı ayrı koparılabilirler. İkisi aynı Google Cloud projesini ve aynı
// yönlendirme adresini kullanır; hangi servis olduğu imzalı OAuth state'te
// taşınır (docs/google-analytics-plan.md §3.2). Saf modül: ağ ve DB yok.
//
// Google Analytics, ilk bağlanışta yalnız salt okunur izni ister; ek
// analytics.edit izni YALNIZCA isteğe bağlı yükseltme akışında (GA-F7,
// GA_FIXES açıkken, ikinci bir onay ekranıyla) istenir. Search Console
// sonsuza kadar salt okunur kalır (SK10): googleScopesFor('search_console')
// hiçbir koşulda yazma izni döndürmez.

export const GOOGLE_SERVICES = ["analytics", "search_console"] as const;
export type GoogleService = (typeof GOOGLE_SERVICES)[number];

export const GOOGLE_PROVIDER = {
  analytics: "google_analytics",
  search_console: "google_search_console",
} as const satisfies Record<GoogleService, string>;

export const GOOGLE_SERVICE_LABEL: Record<GoogleService, string> = {
  analytics: "Google Analytics",
  search_console: "Google Search Console",
};

// Hata mesajlarında servisin neye eriştiğini söyleyen ad.
export const GOOGLE_RESOURCE_NOUN: Record<GoogleService, string> = {
  analytics: "property",
  search_console: "site",
};

// Servisin ilk bağlanıştaki tek veri izni. İkisi de salt okunurdur
// (sitemap gönderimi yok, Search Console planı SK10).
export const GOOGLE_SERVICE_SCOPE: Record<GoogleService, string> = {
  analytics: "https://www.googleapis.com/auth/analytics.readonly",
  search_console: "https://www.googleapis.com/auth/webmasters.readonly",
};

// Hangi Google hesabının bağlandığını bilmek için (e-posta + hesap kimliği).
export const GOOGLE_IDENTITY_SCOPE =
  "https://www.googleapis.com/auth/userinfo.email";

// GA-F7 isteğe bağlı yazma izni (anahtar olay, saklama süresi vb.).
export const GA_EDIT_SCOPE = "https://www.googleapis.com/auth/analytics.edit";

// `edit` yalnız analytics için anlamlıdır; search_console onu yok sayar.
export function googleScopesFor(
  service: GoogleService,
  options?: { edit?: boolean },
): string[] {
  if (service === "analytics" && options?.edit) {
    return [
      GOOGLE_SERVICE_SCOPE.analytics,
      GA_EDIT_SCOPE,
      GOOGLE_IDENTITY_SCOPE,
    ];
  }
  return [GOOGLE_SERVICE_SCOPE[service], GOOGLE_IDENTITY_SCOPE];
}

export function hasGaEditScope(granted: readonly string[]): boolean {
  return granted.includes(GA_EDIT_SCOPE);
}

export function parseGoogleService(value: unknown): GoogleService | null {
  return GOOGLE_SERVICES.includes(value as GoogleService)
    ? (value as GoogleService)
    : null;
}

export function googleServiceForProvider(
  provider: string,
): GoogleService | null {
  const match = GOOGLE_SERVICES.find(
    (service) => GOOGLE_PROVIDER[service] === provider,
  );
  return match ?? null;
}

// Token yanıtının `scope` alanı boşlukla ayrılmış listedir.
export function parseGrantedScopes(scope: string | null | undefined): string[] {
  return (scope ?? "").split(/\s+/).filter(Boolean);
}

// Google, bir giriş izni (e-posta) + bir veri izni istendiğinde onay
// kutuları gösterir; kullanıcı veri iznini kaldırabilir. Bağlantı yalnız
// servisin kendi izni gerçekten verildiyse kurulur.
export function hasServiceScope(
  service: GoogleService,
  grantedScopes: readonly string[],
): boolean {
  return grantedScopes.includes(GOOGLE_SERVICE_SCOPE[service]);
}
