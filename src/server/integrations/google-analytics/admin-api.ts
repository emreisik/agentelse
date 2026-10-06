import "server-only";

import { GoogleApiError } from "@/server/integrations/google/errors";
import { googleFetchJson } from "@/server/integrations/google/http";
import { recordGaApiOutcome } from "@/server/website-analytics/api-counters";

import { gaMockMode } from "./data-api";
import { mockGaPropertyDetails } from "./mock";

// GA4 Admin API v1beta: mülkün ayrıntıları (saat dilimi, para birimi, web
// akışı ve ölçüm kimliği, key event'ler, veri saklama, Google Ads
// bağlantıları). Senkron günde bir okur (docs/google-analytics-plan.md §5,
// "metadata"). Mülkün kendisi okunamazsa hata yükselir (izin, silinmiş
// mülk); yardımcı okumalar başarısız olursa o alan boş kalır.

const ADMIN_BASE = "https://analyticsadmin.googleapis.com/v1beta";

export type GaStream = {
  streamId: string;
  measurementId: string | null;
  uri: string | null;
};

export type GaKeyEvent = {
  eventName: string;
  countingMethod: string | null;
  createTime: string | null;
};

export type GaPropertyDetails = {
  propertyName: string | null;
  accountId: string | null;
  timeZone: string | null;
  currencyCode: string | null;
  industryCategory: string | null;
  serviceLevel: string | null;
  createTime: string | null;
  streams: GaStream[];
  keyEvents: GaKeyEvent[] | null;
  dataRetention: string | null;
  googleAdsLinks: number | null;
};

// Her Admin API çağrısı /health sayaçlarına yazılır (yalnız sayı).
async function get<T>(accessToken: string, path: string): Promise<T> {
  try {
    const result = await googleFetchJson<T>(
      `${ADMIN_BASE}/${path}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
      { kind: "admin" },
    );
    recordGaApiOutcome("ok");
    return result;
  } catch (error) {
    recordGaApiOutcome(
      error instanceof GoogleApiError ? error.errorClass : "UNKNOWN",
    );
    throw error;
  }
}

// Yardımcı okuma: izin ya da bulunamadı hatasında null (ör. key event'leri
// okuma izni olmayan Viewer rolü); geçici hatalar da işi düşürmez.
async function optional<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof GoogleApiError && error.errorClass === "AUTH") {
      throw error;
    }
    return null;
  }
}

export async function fetchGaPropertyDetails(
  accessToken: string,
  propertyId: string,
): Promise<GaPropertyDetails> {
  if (gaMockMode()) return mockGaPropertyDetails(propertyId);
  const id = encodeURIComponent(propertyId);

  const property = await get<{
    displayName?: string;
    parent?: string;
    timeZone?: string;
    currencyCode?: string;
    industryCategory?: string;
    serviceLevel?: string;
    createTime?: string;
  }>(accessToken, `properties/${id}`);

  const [streams, keyEvents, retention, adsLinks] = await Promise.all([
    optional(() =>
      get<{
        dataStreams?: {
          name?: string;
          type?: string;
          webStreamData?: { measurementId?: string; defaultUri?: string };
        }[];
      }>(accessToken, `properties/${id}/dataStreams?pageSize=50`),
    ),
    optional(() =>
      get<{
        keyEvents?: {
          eventName?: string;
          countingMethod?: string;
          createTime?: string;
        }[];
      }>(accessToken, `properties/${id}/keyEvents?pageSize=200`),
    ),
    optional(() =>
      get<{ eventDataRetention?: string }>(
        accessToken,
        `properties/${id}/dataRetentionSettings`,
      ),
    ),
    optional(() =>
      get<{ googleAdsLinks?: unknown[] }>(
        accessToken,
        `properties/${id}/googleAdsLinks?pageSize=50`,
      ),
    ),
  ]);

  return {
    propertyName: property?.displayName ?? null,
    accountId: property?.parent?.replace(/^accounts\//, "") ?? null,
    timeZone: property?.timeZone ?? null,
    currencyCode: property?.currencyCode ?? null,
    industryCategory: property?.industryCategory ?? null,
    serviceLevel: property?.serviceLevel ?? null,
    createTime: property?.createTime ?? null,
    streams: (streams?.dataStreams ?? [])
      .filter((stream) => stream.type === "WEB_DATA_STREAM")
      .map((stream) => ({
        streamId: stream.name?.split("/").pop() ?? "",
        measurementId: stream.webStreamData?.measurementId ?? null,
        uri: stream.webStreamData?.defaultUri ?? null,
      })),
    keyEvents: keyEvents
      ? (keyEvents.keyEvents ?? [])
          .filter((event) => event.eventName)
          .map((event) => ({
            eventName: event.eventName!,
            countingMethod: event.countingMethod ?? null,
            createTime: event.createTime ?? null,
          }))
      : null,
    dataRetention: retention?.eventDataRetention ?? null,
    googleAdsLinks: adsLinks ? (adsLinks.googleAdsLinks ?? []).length : null,
  };
}
