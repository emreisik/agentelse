// GA4 BigQuery dışa aktarımı yapılandırması (GA-F8, docs/website-agency.md).
// Saf modül. İKİ BAĞLAMA KURALI (karışık vekil): servis hesabı tüm müşterilerin
// paylaştığı tek kimliktir, bu yüzden (1) veri kümesi adı yalnız
// analytics_<GA4 mülk kimliği> olabilir, (2) tek bir Google Cloud projesi vardır:
// hem veri kümesinin hem sorgu işlerinin (faturalanan) projesi. Ayrı faturalama
// projesi alanı yoktur; girdideki fazladan alanlar hiç okunmaz.

export type GaBigQueryConfig = {
  // Veri kümesinin ve sorgu işlerinin tek Google Cloud projesi
  gcpProjectId: string;
  datasetId: string;
  location: string | null;
};

const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const LOCATION = /^[A-Za-z0-9-]{2,30}$/;
const PROPERTY_ID = /^\d{1,20}$/;
// GA4 olay adları: harfle başlar, harf/rakam/alt çizgi, en çok 40 karakter.
const EVENT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

export function defaultExportDataset(propertyId: string): string {
  return `analytics_${propertyId}`;
}

export type ParsedBigQueryConfig =
  | { ok: true; value: GaBigQueryConfig }
  | { ok: false; message: string };

export function parseBigQueryConfigInput(
  input: { gcpProjectId: string; datasetId: string; location?: string },
  propertyId: string,
): ParsedBigQueryConfig {
  if (!PROPERTY_ID.test(propertyId)) {
    return { ok: false, message: "This property can't be exported." };
  }
  // Yalnız bilinen üç alan okunur; fazladan alan (ör. faturalama projesi) yok sayılır.
  const gcpProjectId =
    typeof input.gcpProjectId === "string" ? input.gcpProjectId.trim() : "";
  const datasetId =
    typeof input.datasetId === "string" ? input.datasetId.trim() : "";
  const rawLocation =
    typeof input.location === "string" ? input.location.trim() : "";

  if (!PROJECT_ID.test(gcpProjectId)) {
    return {
      ok: false,
      message:
        "Enter the id of the Google Cloud project that holds the export, for example my-company-123456.",
    };
  }
  const expected = defaultExportDataset(propertyId);
  if (datasetId !== expected) {
    return {
      ok: false,
      message: `The export dataset of this property is ${expected}.`,
    };
  }
  if (rawLocation && !LOCATION.test(rawLocation)) {
    return {
      ok: false,
      message: "Enter the dataset location, for example US or EU.",
    };
  }
  return {
    ok: true,
    value: {
      gcpProjectId,
      datasetId: expected,
      location: rawLocation || null,
    },
  };
}

// GaPropertyLink.keyEvents ([{ eventName, ... }]) → geçerli olay adları.
// Geçersiz adlar (virgül içerenler dahil) atılır: SQL'e tek virgüllü dize gider.
export function keyEventNamesOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const name = (item as { eventName?: unknown }).eventName;
    if (typeof name === "string" && EVENT_NAME.test(name)) {
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}

export function isValidGaEventName(value: string): boolean {
  return EVENT_NAME.test(value);
}
