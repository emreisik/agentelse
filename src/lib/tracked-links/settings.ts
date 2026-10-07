// Link izleme ayarı (GK10): Settings → Publishing → "Add tracking (UTM) to
// links". Satır yoksa açık sayılır. Saf yardımcılar; kayıt
// src/server/tracked-links/settings.ts'te.

export type LinkTrackingSettingsValue = { utmEnabled: boolean };
export type LinkTrackingSettingsView = LinkTrackingSettingsValue & {
  // Veritabanında satır var mı (false = varsayılanlar gösteriliyor).
  stored: boolean;
};

export const LINK_TRACKING_DEFAULTS: Readonly<LinkTrackingSettingsValue> =
  Object.freeze({ utmEnabled: true });

export function readLinkTrackingSettings(
  row: { utmEnabled?: unknown } | null,
): LinkTrackingSettingsView {
  return {
    utmEnabled:
      typeof row?.utmEnabled === "boolean"
        ? row.utmEnabled
        : LINK_TRACKING_DEFAULTS.utmEnabled,
    stored: row !== null,
  };
}

// İşaret kutusu: "on" → açık, alan yoksa → kapalı.
export function parseLinkTrackingForm(formData: FormData): LinkTrackingSettingsValue {
  return { utmEnabled: formData.get("utmEnabled") === "on" };
}
