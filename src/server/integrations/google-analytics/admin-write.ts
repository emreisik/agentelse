import "server-only";

import {
  buildEnhancedMeasurementPatch,
  gaValidationError,
  isGaResourceName,
  parseAnnotation,
  parseAnnotationList,
  parseChangeHistory,
  parseChannelGroup,
  parseChannelGroupList,
  parseEnhanced,
  parseGaDay,
  parseKeyEvent,
  parseKeyEventList,
  parseRetention,
  requireGaEventName,
  requireGaNumericId,
  requireGaResourceName,
  requireGaRetentionValue,
} from "@/lib/website-analytics/fixes/admin-parse";
import type {
  GaAnnotationCreate,
  GaAnnotationResource,
  GaChangeHistoryEvent,
  GaChannelGroupCreate,
  GaChannelGroupResource,
  GaEnhancedMeasurementPatch,
  GaEnhancedMeasurementResource,
  GaKeyEventResource,
  GaRetentionResource,
} from "@/lib/website-analytics/fixes/resources";
import { GoogleApiError } from "@/server/integrations/google/errors";
import {
  googleFetchJson,
  type GoogleRequestOptions,
} from "@/server/integrations/google/http";
import { recordGaApiOutcome } from "@/server/website-analytics/api-counters";

import { gaMockMode } from "./data-api";
import { createMockGaAdminWriter } from "./admin-write-mock";

// GA-F7: Analytics Admin API yazma istemcisi (docs/website-fixes.md). Okuma
// tarafı admin-api.ts'te kalır; burada yalnız onaylı düzeltmelerin ihtiyaç
// duyduğu çağrılar vardır. Bütün HTTP google/http.ts'ten (kind "admin") geçer.
// Her URL GA_ADMIN_PATHS + doğrulanmış kimliklerden kurulur: mülk, akış ve
// hesap kimliği yalnız rakam, kaynak adı yalnız bilinen üç koleksiyon
// (SSRF ve yol enjeksiyonu yok). Oluşturma çağrıları tekrar edilmez
// (retry:false: zaman aşımına uğrayan POST ikinci kez yaratmasın); PATCH ve
// DELETE varsayılan tekrarı kullanır. Yanıt biçimi beklenmedik ise
// UNEXPECTED_SHAPE fırlatılır. Mock modunda hiçbir çağrı fetch'e ulaşmaz.

export const GA_ADMIN_PATHS = {
  v1beta: "https://analyticsadmin.googleapis.com/v1beta",
  v1alpha: "https://analyticsadmin.googleapis.com/v1alpha",
} as const;

export { isGaResourceName };

export interface GaAdminWriter {
  listKeyEvents(propertyId: string): Promise<GaKeyEventResource[]>;
  createKeyEvent(
    propertyId: string,
    eventName: string,
  ): Promise<GaKeyEventResource>;
  deleteKeyEvent(resourceName: string): Promise<void>;
  getDataRetention(propertyId: string): Promise<GaRetentionResource>;
  updateDataRetention(
    propertyId: string,
    eventDataRetention: string,
  ): Promise<GaRetentionResource>;
  getEnhancedMeasurement(
    propertyId: string,
    streamId: string,
  ): Promise<GaEnhancedMeasurementResource>;
  updateEnhancedMeasurement(
    propertyId: string,
    streamId: string,
    patch: GaEnhancedMeasurementPatch,
  ): Promise<GaEnhancedMeasurementResource>;
  listChannelGroups(propertyId: string): Promise<GaChannelGroupResource[]>;
  createChannelGroup(
    propertyId: string,
    body: GaChannelGroupCreate,
  ): Promise<GaChannelGroupResource>;
  deleteChannelGroup(resourceName: string): Promise<void>;
  listAnnotations(propertyId: string): Promise<GaAnnotationResource[]>;
  createAnnotation(
    propertyId: string,
    input: GaAnnotationCreate,
  ): Promise<GaAnnotationResource>;
  deleteAnnotation(resourceName: string): Promise<void>;
  searchChangeHistory(input: {
    accountId: string;
    propertyId: string;
    earliest: Date;
    latest: Date;
    pageToken?: string;
    pageSize?: number;
  }): Promise<{ events: GaChangeHistoryEvent[]; nextPageToken: string | null }>;
}

// Testlerde bekleme süresini ve jitter'ı sabitlemek için (üretimde verilmez).
export type GaAdminHttpOptions = Pick<GoogleRequestOptions, "sleep" | "random">;

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 200;

type Send = (
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  options?: { body?: unknown; retry?: boolean },
) => Promise<unknown>;

// Çağrının sonucu /health sayaçlarına yazılır (yalnız sayı): başarıda "ok",
// hatada hata sınıfı.
async function counted<T>(run: () => Promise<T>): Promise<T> {
  try {
    const result = await run();
    recordGaApiOutcome("ok");
    return result;
  } catch (error) {
    recordGaApiOutcome(
      error instanceof GoogleApiError ? error.errorClass : "UNKNOWN",
    );
    throw error;
  }
}

function makeSend(accessToken: string, http: GaAdminHttpOptions): Send {
  return (method, url, options = {}) => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
    };
    const init: RequestInit = { method, headers };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    return googleFetchJson<unknown>(url, init, {
      kind: "admin",
      retry: options.retry,
      sleep: http.sleep,
      random: http.random,
    });
  };
}

// DELETE yanıtı boş gövdedir; içeriği kullanılmaz.
function ignoreBody(): void {}

function propertyPath(propertyId: string): string {
  return `properties/${requireGaNumericId(propertyId, "property id")}`;
}

function createRealGaAdminWriter(
  accessToken: string,
  http: GaAdminHttpOptions,
): GaAdminWriter {
  const rawSend = makeSend(accessToken, http);
  // Sayım yanıtın ayrıştırılmasını da kapsar: biçim kayması "UNKNOWN" sayılır.
  const send = <T,>(
    parse: (raw: unknown) => T,
    ...args: Parameters<Send>
  ): Promise<T> => counted(async () => parse(await rawSend(...args)));
  const beta = GA_ADMIN_PATHS.v1beta;
  const alpha = GA_ADMIN_PATHS.v1alpha;

  return {
    async listKeyEvents(propertyId) {
      const url = `${beta}/${propertyPath(propertyId)}/keyEvents?pageSize=200`;
      return send(parseKeyEventList, "GET", url);
    },

    async createKeyEvent(propertyId, eventName) {
      requireGaEventName(eventName);
      const url = `${beta}/${propertyPath(propertyId)}/keyEvents`;
      return send(parseKeyEvent, "POST", url, {
        body: { eventName, countingMethod: "ONCE_PER_EVENT" },
        retry: false,
      });
    },

    async deleteKeyEvent(resourceName) {
      requireGaResourceName(resourceName, "keyEvents");
      await send(ignoreBody, "DELETE", `${beta}/${resourceName}`);
    },

    async getDataRetention(propertyId) {
      const url = `${beta}/${propertyPath(propertyId)}/dataRetentionSettings`;
      return send(parseRetention, "GET", url);
    },

    async updateDataRetention(propertyId, eventDataRetention) {
      requireGaRetentionValue(eventDataRetention);
      const url = `${beta}/${propertyPath(propertyId)}/dataRetentionSettings?updateMask=eventDataRetention`;
      return send(parseRetention, "PATCH", url, {
        body: { eventDataRetention },
      });
    },

    async getEnhancedMeasurement(propertyId, streamId) {
      const url = enhancedUrl(alpha, propertyId, streamId);
      return send(parseEnhanced, "GET", url);
    },

    async updateEnhancedMeasurement(propertyId, streamId, patch) {
      const { keys, body } = buildEnhancedMeasurementPatch(patch);
      const url = `${enhancedUrl(alpha, propertyId, streamId)}?updateMask=${keys.join(",")}`;
      return send(parseEnhanced, "PATCH", url, { body });
    },

    async listChannelGroups(propertyId) {
      const url = `${alpha}/${propertyPath(propertyId)}/channelGroups?pageSize=200`;
      return send(parseChannelGroupList, "GET", url);
    },

    async createChannelGroup(propertyId, body) {
      const url = `${alpha}/${propertyPath(propertyId)}/channelGroups`;
      return send(parseChannelGroup, "POST", url, { body, retry: false });
    },

    async deleteChannelGroup(resourceName) {
      requireGaResourceName(resourceName, "channelGroups");
      await send(ignoreBody, "DELETE", `${alpha}/${resourceName}`);
    },

    async listAnnotations(propertyId) {
      const url = `${alpha}/${propertyPath(propertyId)}/reportingDataAnnotations?pageSize=200`;
      return send(parseAnnotationList, "GET", url);
    },

    async createAnnotation(propertyId, input) {
      const annotationDate = parseGaDay(input.day);
      const url = `${alpha}/${propertyPath(propertyId)}/reportingDataAnnotations`;
      return send(parseAnnotation, "POST", url, {
        body: {
          title: input.title,
          description: input.description,
          color: input.color,
          annotationDate,
        },
        retry: false,
      });
    },

    async deleteAnnotation(resourceName) {
      requireGaResourceName(resourceName, "reportingDataAnnotations");
      await send(ignoreBody, "DELETE", `${alpha}/${resourceName}`);
    },

    async searchChangeHistory(input) {
      const accountId = requireGaNumericId(input.accountId, "account id");
      const propertyId = requireGaNumericId(input.propertyId, "property id");
      if (
        Number.isNaN(input.earliest.getTime()) ||
        Number.isNaN(input.latest.getTime())
      ) {
        throw gaValidationError("Invalid time range");
      }
      const pageSize = Math.min(
        Math.max(input.pageSize ?? DEFAULT_PAGE_SIZE, 1),
        MAX_PAGE_SIZE,
      );
      const body: Record<string, unknown> = {
        property: `properties/${propertyId}`,
        earliestChangeTime: input.earliest.toISOString(),
        latestChangeTime: input.latest.toISOString(),
        pageSize,
      };
      if (input.pageToken) body.pageToken = input.pageToken;
      const url = `${beta}/accounts/${accountId}:searchChangeHistoryEvents`;
      return send(parseChangeHistory, "POST", url, { body });
    },
  };
}

function enhancedUrl(base: string, propertyId: string, streamId: string): string {
  const stream = requireGaNumericId(streamId, "stream id");
  return `${base}/${propertyPath(propertyId)}/dataStreams/${stream}/enhancedMeasurementSettings`;
}

// Mock modunda (gaMockMode) bütün yöntemler bellek içi mock'a gider ve fetch'e
// asla ulaşılmaz; mod her çağrıda okunur (bayrak çağrı anında).
export function createGaAdminWriter(
  accessToken: string,
  http: GaAdminHttpOptions = {},
): GaAdminWriter {
  const real = createRealGaAdminWriter(accessToken, http);
  const mock = createMockGaAdminWriter();
  const pick = (): GaAdminWriter => (gaMockMode() ? mock : real);

  return {
    listKeyEvents: (propertyId) => pick().listKeyEvents(propertyId),
    createKeyEvent: (propertyId, eventName) =>
      pick().createKeyEvent(propertyId, eventName),
    deleteKeyEvent: (resourceName) => pick().deleteKeyEvent(resourceName),
    getDataRetention: (propertyId) => pick().getDataRetention(propertyId),
    updateDataRetention: (propertyId, value) =>
      pick().updateDataRetention(propertyId, value),
    getEnhancedMeasurement: (propertyId, streamId) =>
      pick().getEnhancedMeasurement(propertyId, streamId),
    updateEnhancedMeasurement: (propertyId, streamId, patch) =>
      pick().updateEnhancedMeasurement(propertyId, streamId, patch),
    listChannelGroups: (propertyId) => pick().listChannelGroups(propertyId),
    createChannelGroup: (propertyId, body) =>
      pick().createChannelGroup(propertyId, body),
    deleteChannelGroup: (resourceName) => pick().deleteChannelGroup(resourceName),
    listAnnotations: (propertyId) => pick().listAnnotations(propertyId),
    createAnnotation: (propertyId, input) =>
      pick().createAnnotation(propertyId, input),
    deleteAnnotation: (resourceName) => pick().deleteAnnotation(resourceName),
    searchChangeHistory: (input) => pick().searchChangeHistory(input),
  };
}
