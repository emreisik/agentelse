import "server-only";

import {
  fetchGa4PropertyList,
  fetchSearchConsoleSiteList,
  reconcileGa4Selection,
  reconcileSearchConsoleSelection,
  type GoogleAccountIdentity,
  type GoogleAnalyticsMetadata,
  type GoogleSearchConsoleMetadata,
  type GoogleService,
} from "@/server/integrations/google-client";

// Yeni bağlantının metadata'sı (OAuth dönüşü ve "Use existing connection"):
// mülk/site listesi tazelenir; hâlâ erişilebilen önceki seçim ve tarama
// kayıtları korunur, böylece yeniden bağlanmak tarayıcıyı sıfırlamaz.
// Koparılmış satırın `disconnectedAt` işareti ve eski token'ın sağlık kaydı
// (`googleHealth`) düşer; yeni token'ın sağlığını günlük kontrol yeniden yazar.
// Liste alınamasa da (API kapalı vb.) hata metadata'ya yazılır, bağlantı kurulur.
export async function buildGoogleConnectionMetadata(
  service: GoogleService,
  accessToken: string,
  account: GoogleAccountIdentity,
  existing: Record<string, unknown>,
): Promise<GoogleAnalyticsMetadata | GoogleSearchConsoleMetadata> {
  const kept: Record<string, unknown> = { ...existing };
  delete kept.disconnectedAt;
  delete kept.googleHealth;
  if (service === "analytics") {
    const previous = kept as Partial<GoogleAnalyticsMetadata>;
    const lists = await fetchGa4PropertyList(accessToken);
    return {
      ...previous,
      ...account,
      ga4ListError: undefined,
      ...lists,
      ...reconcileGa4Selection(previous, lists),
    };
  }
  const previous = kept as Partial<GoogleSearchConsoleMetadata>;
  const lists = await fetchSearchConsoleSiteList(accessToken);
  return {
    ...previous,
    ...account,
    gscListError: undefined,
    ...lists,
    ...reconcileSearchConsoleSelection(previous, lists),
  };
}
