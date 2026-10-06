import "server-only";

import {
  gaCatalogRequiredFields,
  type GaFieldMeta,
  type GaMetadataFields,
} from "@/lib/website-analytics/catalog-fields";
import { recordGaApiOutcome } from "@/server/website-analytics/api-counters";
import { GoogleApiError } from "@/server/integrations/google/errors";
import { googleFetchJson } from "@/server/integrations/google/http";

import { gaMockMode } from "./data-api";

// GA4 Data API getMetadata ve checkCompatibility (docs/google-analytics-plan.md
// §3.3): katalog denetimi haftada bir mülkün alan listesini okur, isteğe
// bağlı raporlar (google_ads, search_console) için alanların birlikte
// istenebildiğini doğrular. İkisi de runReport çekirdek kotasından token
// harcamaz. Mock modda ağa gidilmez.

const DATA_BASE = "https://analyticsdata.googleapis.com/v1beta";

type RawField = {
  apiName?: string;
  deprecatedApiNames?: string[];
  blockedReasons?: string[];
};

function headers(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
}

// Her Google çağrısı /health sayaçlarına yazılır (yalnız sayı).
async function counted<T>(call: () => Promise<T>): Promise<T> {
  try {
    const result = await call();
    recordGaApiOutcome("ok");
    return result;
  } catch (error) {
    recordGaApiOutcome(
      error instanceof GoogleApiError ? error.errorClass : "UNKNOWN",
    );
    throw error;
  }
}

function toFields(raw: RawField[] | undefined): GaFieldMeta[] {
  return (raw ?? [])
    .filter((field) => typeof field.apiName === "string" && field.apiName)
    .map((field) => ({
      apiName: field.apiName!,
      deprecatedApiNames: Array.isArray(field.deprecatedApiNames)
        ? field.deprecatedApiNames
        : [],
      blockedReasons: Array.isArray(field.blockedReasons)
        ? field.blockedReasons
        : [],
    }));
}

// Mock: katalogun istediği her alan var; keyEvents eski "conversions" adını
// taşır (gerçek mülkte olduğu gibi).
function mockMetadata(): GaMetadataFields {
  const dimensions = new Set<string>();
  const metrics = new Set<string>();
  for (const fields of Object.values(gaCatalogRequiredFields())) {
    for (const name of fields.dimensions) dimensions.add(name);
    for (const name of fields.metrics) metrics.add(name);
  }
  const field = (apiName: string): GaFieldMeta => ({
    apiName,
    deprecatedApiNames: apiName === "keyEvents" ? ["conversions"] : [],
    blockedReasons: [],
  });
  return {
    dimensions: [...dimensions].map(field),
    metrics: [...metrics].map(field),
  };
}

export async function fetchGaMetadata(
  accessToken: string,
  propertyId: string,
): Promise<GaMetadataFields> {
  if (gaMockMode()) return mockMetadata();
  const raw = await counted(() =>
    googleFetchJson<{ dimensions?: RawField[]; metrics?: RawField[] }>(
      `${DATA_BASE}/properties/${encodeURIComponent(propertyId)}/metadata`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
      { kind: "read" },
    ),
  );
  return {
    dimensions: toFields(raw?.dimensions),
    metrics: toFields(raw?.metrics),
  };
}

type RawCompatibility = {
  dimensionCompatibilities?: {
    dimensionMetadata?: { apiName?: string };
    compatibility?: string;
  }[];
  metricCompatibilities?: {
    metricMetadata?: { apiName?: string };
    compatibility?: string;
  }[];
};

export async function checkGaCompatibility(
  accessToken: string,
  propertyId: string,
  fields: { dimensions: string[]; metrics: string[] },
): Promise<{ compatible: boolean; incompatible: string[] }> {
  if (gaMockMode()) return { compatible: true, incompatible: [] };
  const raw = await counted(() =>
    googleFetchJson<RawCompatibility>(
      `${DATA_BASE}/properties/${encodeURIComponent(propertyId)}:checkCompatibility`,
      {
        method: "POST",
        headers: headers(accessToken),
        body: JSON.stringify({
          dimensions: fields.dimensions.map((name) => ({ name })),
          metrics: fields.metrics.map((name) => ({ name })),
          compatibilityFilter: "INCOMPATIBLE",
        }),
      },
      { kind: "read" },
    ),
  );
  const flagged = new Set<string>();
  for (const item of raw?.dimensionCompatibilities ?? []) {
    const name = item.dimensionMetadata?.apiName;
    if (name && item.compatibility === "INCOMPATIBLE") flagged.add(name);
  }
  for (const item of raw?.metricCompatibilities ?? []) {
    const name = item.metricMetadata?.apiName;
    if (name && item.compatibility === "INCOMPATIBLE") flagged.add(name);
  }
  const incompatible = [
    ...new Set([...fields.dimensions, ...fields.metrics]),
  ].filter((name) => flagged.has(name));
  return { compatible: incompatible.length === 0, incompatible };
}
