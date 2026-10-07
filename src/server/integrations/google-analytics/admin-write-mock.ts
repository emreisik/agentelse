import "server-only";

import {
  buildEnhancedMeasurementPatch,
  gaValidationError,
  parseGaDay,
  requireGaEventName,
  requireGaNumericId,
  requireGaResourceName,
  requireGaRetentionValue,
  type GaResourceCollection,
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
import { recordGaApiOutcome } from "@/server/website-analytics/api-counters";

import type { GaAdminWriter } from "./admin-write";

// GA-F7 mock modu (AGENTELSE_PROVIDER_MODE=mock): Analytics Admin yazma
// istemcisinin bellek içi karşılığı. Google'a hiçbir çağrı gitmez, hiçbir şey
// loglanmaz. Mülk başına belirlenimci tohum: key event ['purchase'], saklama
// TWO_MONTHS, gelişmiş ölçümde yalnız streamEnabled açık, kanal grubu ve not
// yok. Kaynak adları mülk başına sayaçla belirlenimcidir (keyEvents/1, /2...).
// Bu modül aynı zamanda tüketici testlerinin yardımcısıdır: hata enjekte etme,
// "yazıldı ama istek hata verdi" (timeout) ve "kabul edildi ama saklanmadı"
// (geri okuma yalanı) kipleri vardır.

// Standart GA4 mülkünde key event sınırı 30'dur.
const MOCK_KEY_EVENT_LIMIT = 30;
const RETENTION_VALUES = new Set([
  "TWO_MONTHS",
  "FOURTEEN_MONTHS",
  "TWENTY_SIX_MONTHS",
  "THIRTY_EIGHT_MONTHS",
  "FIFTY_MONTHS",
]);

type MockProperty = {
  counters: { keyEvents: number; channelGroups: number; annotations: number };
  keyEvents: GaKeyEventResource[];
  retention: GaRetentionResource;
  enhancedBase: Partial<GaEnhancedMeasurementResource>;
  enhanced: Map<string, GaEnhancedMeasurementResource>;
  channelGroups: GaChannelGroupResource[];
  annotations: GaAnnotationResource[];
  history: { event: GaChangeHistoryEvent; at: number }[];
};

type Fault = { error: GoogleApiError; after: boolean; remaining: number };

type LieMethod =
  | "createKeyEvent"
  | "updateDataRetention"
  | "updateEnhancedMeasurement"
  | "createChannelGroup"
  | "createAnnotation";

const store = new Map<string, MockProperty>();
let calls: string[] = [];
const faults = new Map<keyof GaAdminWriter, Fault>();
const lies = new Set<LieMethod>();
let eventCounter = 0;

export function resetMockGaAdmin(): void {
  store.clear();
  calls = [];
  faults.clear();
  lies.clear();
  eventCounter = 0;
}

function freshProperty(propertyId: string): MockProperty {
  const property: MockProperty = {
    counters: { keyEvents: 0, channelGroups: 0, annotations: 0 },
    keyEvents: [],
    retention: {
      eventDataRetention: "TWO_MONTHS",
      resetUserDataOnNewActivity: false,
    },
    enhancedBase: {},
    enhanced: new Map(),
    channelGroups: [],
    annotations: [],
    history: [],
  };
  addKeyEvent(propertyId, property, "purchase");
  return property;
}

function addKeyEvent(
  propertyId: string,
  property: MockProperty,
  eventName: string,
): GaKeyEventResource {
  property.counters.keyEvents += 1;
  // GA4'ün yerleşik "purchase" key event'i silinemez, ötekiler özeldir.
  const builtIn = eventName === "purchase" && property.keyEvents.length === 0;
  const resource: GaKeyEventResource = {
    name: `properties/${propertyId}/keyEvents/${property.counters.keyEvents}`,
    eventName,
    countingMethod: "ONCE_PER_EVENT",
    custom: !builtIn,
    deletable: !builtIn,
  };
  property.keyEvents.push(resource);
  return resource;
}

function propertyOf(propertyId: string): MockProperty {
  let property = store.get(propertyId);
  if (!property) {
    property = freshProperty(propertyId);
    store.set(propertyId, property);
  }
  return property;
}

function enhancedOf(
  propertyId: string,
  property: MockProperty,
  streamId: string,
): GaEnhancedMeasurementResource {
  let settings = property.enhanced.get(streamId);
  if (!settings) {
    settings = {
      name: `properties/${propertyId}/dataStreams/${streamId}/enhancedMeasurementSettings`,
      streamEnabled: true,
      scrollsEnabled: false,
      outboundClicksEnabled: false,
      siteSearchEnabled: false,
      videoEngagementEnabled: false,
      fileDownloadsEnabled: false,
      formInteractionsEnabled: false,
      pageChangesEnabled: false,
      searchQueryParameter: "",
      uriQueryParameter: null,
      ...property.enhancedBase,
    };
    property.enhanced.set(streamId, settings);
  }
  return settings;
}

// Tohumlama: verilen alanlar o mülkün durumunu değiştirir (verilmeyenler
// belirlenimci varsayılanda kalır); mülk her çağrıda sıfırdan kurulur.
export function seedMockGaAdmin(
  propertyId: string,
  seed: Partial<{
    keyEvents: string[];
    retention: string;
    enhanced: Partial<GaEnhancedMeasurementResource>;
    channelGroups: string[];
    annotations: { title: string; day: string }[];
  }>,
): void {
  requireGaNumericId(propertyId, "property id");
  const property = freshProperty(propertyId);
  if (seed.keyEvents) {
    property.keyEvents = [];
    property.counters.keyEvents = 0;
    for (const eventName of seed.keyEvents) {
      addKeyEvent(propertyId, property, eventName);
    }
  }
  if (seed.retention) property.retention.eventDataRetention = seed.retention;
  if (seed.enhanced) property.enhancedBase = { ...seed.enhanced };
  for (const displayName of seed.channelGroups ?? []) {
    property.counters.channelGroups += 1;
    property.channelGroups.push({
      name: `properties/${propertyId}/channelGroups/${property.counters.channelGroups}`,
      displayName,
      description: null,
      systemDefined: false,
      ruleCount: 1,
    });
  }
  for (const note of seed.annotations ?? []) {
    property.counters.annotations += 1;
    property.annotations.push({
      name: `properties/${propertyId}/reportingDataAnnotations/${property.counters.annotations}`,
      title: note.title,
      description: null,
      day: note.day,
      color: "BLUE",
      systemGenerated: false,
    });
  }
  store.set(propertyId, property);
}

export function mockGaAdminCalls(): string[] {
  return [...calls];
}

// after:true => yazma gerçekleşir, sonra çağrı hata fırlatır (zaman aşımına
// uğrayan yazma). times: hata kaç çağrıda geçerli olsun (varsayılan: temizlenene
// kadar). error null => kaldırır.
export function setMockGaAdminFault(
  method: keyof GaAdminWriter,
  error: GoogleApiError | null,
  options: { after?: boolean; times?: number } = {},
): void {
  if (!error) {
    faults.delete(method);
    return;
  }
  faults.set(method, {
    error,
    after: options.after === true,
    remaining: options.times ?? Number.POSITIVE_INFINITY,
  });
}

// Yazma kabul edilir (yanıt başarılı) ama saklanmaz: geri okuma uyuşmazlığı.
export function setMockGaAdminReadBackLie(method: LieMethod, on: boolean): void {
  if (on) lies.add(method);
  else lies.delete(method);
}

// searchChangeHistory'yi besler. Mock, kendi yazmalarını geçmişe EKLEMEZ;
// yalnız buradan itilenler görünür.
export function mockGaAdminPushChange(
  propertyId: string,
  change: {
    resource: string;
    action: "CREATED" | "UPDATED" | "DELETED";
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    at?: Date;
  },
): void {
  requireGaNumericId(propertyId, "property id");
  const property = propertyOf(propertyId);
  eventCounter += 1;
  const at = change.at ?? new Date();
  property.history.push({
    at: at.getTime(),
    event: {
      id: `mock-event-${eventCounter}`,
      changeTime: at.toISOString(),
      actorType: "USER",
      changes: [
        {
          resource: change.resource,
          action: change.action,
          before: change.before ?? null,
          after: change.after ?? null,
        },
      ],
    },
  });
}

// Her çağrı: çağrı kaydı, hata enjeksiyonu, sayaç. Doğrulama run'dan ÖNCE
// yapılır; yerel olarak reddedilen çağrı Google çağrısı sayılmaz.
async function run<T>(method: keyof GaAdminWriter, op: () => T): Promise<T> {
  calls.push(method);
  try {
    const fault = faults.get(method);
    const active = fault !== undefined && fault.remaining > 0;
    if (active && !fault.after) {
      fault.remaining -= 1;
      throw fault.error;
    }
    const result = op();
    if (active && fault.after) {
      fault.remaining -= 1;
      throw fault.error;
    }
    recordGaApiOutcome("ok");
    return result;
  } catch (error) {
    recordGaApiOutcome(
      error instanceof GoogleApiError ? error.errorClass : "UNKNOWN",
    );
    throw error;
  }
}

function notFound(): GoogleApiError {
  return new GoogleApiError("Requested entity was not found.", "NOT_FOUND", {
    httpStatus: 404,
  });
}

function owningProperty(name: string, collection: GaResourceCollection): {
  propertyId: string;
  property: MockProperty;
} {
  requireGaResourceName(name, collection);
  const propertyId = name.split("/")[1] ?? "";
  // Mülk ilk kullanımda belirlenimci tohumla kurulur (kaynak yoksa 404 yine
  // koleksiyon aramasından gelir).
  return { propertyId, property: propertyOf(propertyId) };
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

export function createMockGaAdminWriter(): GaAdminWriter {
  return {
    async listKeyEvents(propertyId) {
      requireGaNumericId(propertyId, "property id");
      return run("listKeyEvents", () =>
        copy(propertyOf(propertyId).keyEvents),
      );
    },

    async createKeyEvent(propertyId, eventName) {
      requireGaNumericId(propertyId, "property id");
      requireGaEventName(eventName);
      return run("createKeyEvent", () => {
        const property = propertyOf(propertyId);
        if (property.keyEvents.some((item) => item.eventName === eventName)) {
          throw new GoogleApiError(
            "Key event already exists.",
            "ALREADY_EXISTS",
            { httpStatus: 409 },
          );
        }
        if (property.keyEvents.length >= MOCK_KEY_EVENT_LIMIT) {
          throw new GoogleApiError(
            `Maximum number of key events (${MOCK_KEY_EVENT_LIMIT}) exceeded.`,
            "INVALID_ARGUMENT",
            { httpStatus: 400 },
          );
        }
        if (lies.has("createKeyEvent")) {
          return {
            name: `properties/${propertyId}/keyEvents/${property.counters.keyEvents + 1}`,
            eventName,
            countingMethod: "ONCE_PER_EVENT",
            custom: true,
            deletable: true,
          };
        }
        return copy(addKeyEvent(propertyId, property, eventName));
      });
    },

    async deleteKeyEvent(resourceName) {
      requireGaResourceName(resourceName, "keyEvents");
      return run("deleteKeyEvent", () => {
        const { property } = owningProperty(resourceName, "keyEvents");
        const index = property.keyEvents.findIndex(
          (item) => item.name === resourceName,
        );
        if (index < 0) throw notFound();
        if (!property.keyEvents[index]?.deletable) {
          throw new GoogleApiError(
            "This key event cannot be deleted.",
            "FAILED_PRECONDITION",
            { httpStatus: 400 },
          );
        }
        property.keyEvents.splice(index, 1);
      });
    },

    async getDataRetention(propertyId) {
      requireGaNumericId(propertyId, "property id");
      return run("getDataRetention", () =>
        copy(propertyOf(propertyId).retention),
      );
    },

    async updateDataRetention(propertyId, eventDataRetention) {
      requireGaNumericId(propertyId, "property id");
      requireGaRetentionValue(eventDataRetention);
      return run("updateDataRetention", () => {
        if (!RETENTION_VALUES.has(eventDataRetention)) {
          throw new GoogleApiError(
            "Invalid value for eventDataRetention.",
            "INVALID_ARGUMENT",
            { httpStatus: 400 },
          );
        }
        const property = propertyOf(propertyId);
        if (lies.has("updateDataRetention")) {
          return { ...copy(property.retention), eventDataRetention };
        }
        property.retention.eventDataRetention = eventDataRetention;
        return copy(property.retention);
      });
    },

    async getEnhancedMeasurement(propertyId, streamId) {
      requireGaNumericId(propertyId, "property id");
      requireGaNumericId(streamId, "stream id");
      return run("getEnhancedMeasurement", () =>
        copy(enhancedOf(propertyId, propertyOf(propertyId), streamId)),
      );
    },

    async updateEnhancedMeasurement(
      propertyId,
      streamId,
      patch: GaEnhancedMeasurementPatch,
    ) {
      requireGaNumericId(propertyId, "property id");
      requireGaNumericId(streamId, "stream id");
      const { body } = buildEnhancedMeasurementPatch(patch);
      return run("updateEnhancedMeasurement", () => {
        const property = propertyOf(propertyId);
        const current = enhancedOf(propertyId, property, streamId);
        if (lies.has("updateEnhancedMeasurement")) {
          return { ...copy(current), ...body };
        }
        Object.assign(current, body);
        return copy(current);
      });
    },

    async listChannelGroups(propertyId) {
      requireGaNumericId(propertyId, "property id");
      return run("listChannelGroups", () =>
        copy(propertyOf(propertyId).channelGroups),
      );
    },

    async createChannelGroup(propertyId, body: GaChannelGroupCreate) {
      requireGaNumericId(propertyId, "property id");
      if (
        typeof body?.displayName !== "string" ||
        !body.displayName ||
        !Array.isArray(body.groupingRule) ||
        body.groupingRule.length === 0
      ) {
        throw gaValidationError("Invalid channel group");
      }
      return run("createChannelGroup", () => {
        const property = propertyOf(propertyId);
        const next = property.counters.channelGroups + 1;
        const resource: GaChannelGroupResource = {
          name: `properties/${propertyId}/channelGroups/${next}`,
          displayName: body.displayName,
          description: body.description || null,
          systemDefined: false,
          ruleCount: body.groupingRule.length,
        };
        if (lies.has("createChannelGroup")) return resource;
        property.counters.channelGroups = next;
        property.channelGroups.push(resource);
        return copy(resource);
      });
    },

    async deleteChannelGroup(resourceName) {
      requireGaResourceName(resourceName, "channelGroups");
      return run("deleteChannelGroup", () => {
        const { property } = owningProperty(resourceName, "channelGroups");
        const index = property.channelGroups.findIndex(
          (item) => item.name === resourceName,
        );
        if (index < 0) throw notFound();
        property.channelGroups.splice(index, 1);
      });
    },

    async listAnnotations(propertyId) {
      requireGaNumericId(propertyId, "property id");
      return run("listAnnotations", () =>
        copy(propertyOf(propertyId).annotations),
      );
    },

    async createAnnotation(propertyId, input: GaAnnotationCreate) {
      requireGaNumericId(propertyId, "property id");
      parseGaDay(input?.day);
      if (typeof input.title !== "string" || !input.title) {
        throw gaValidationError("Invalid annotation");
      }
      return run("createAnnotation", () => {
        const property = propertyOf(propertyId);
        const next = property.counters.annotations + 1;
        const resource: GaAnnotationResource = {
          name: `properties/${propertyId}/reportingDataAnnotations/${next}`,
          title: input.title,
          description: input.description || null,
          day: input.day,
          color: input.color,
          systemGenerated: false,
        };
        if (lies.has("createAnnotation")) return resource;
        property.counters.annotations = next;
        property.annotations.push(resource);
        return copy(resource);
      });
    },

    async deleteAnnotation(resourceName) {
      requireGaResourceName(resourceName, "reportingDataAnnotations");
      return run("deleteAnnotation", () => {
        const { property } = owningProperty(
          resourceName,
          "reportingDataAnnotations",
        );
        const index = property.annotations.findIndex(
          (item) => item.name === resourceName,
        );
        if (index < 0) throw notFound();
        property.annotations.splice(index, 1);
      });
    },

    async searchChangeHistory(input) {
      requireGaNumericId(input.accountId, "account id");
      requireGaNumericId(input.propertyId, "property id");
      const earliest = input.earliest.getTime();
      const latest = input.latest.getTime();
      if (Number.isNaN(earliest) || Number.isNaN(latest)) {
        throw gaValidationError("Invalid time range");
      }
      const pageSize = Math.min(Math.max(input.pageSize ?? 100, 1), 200);
      return run("searchChangeHistory", () => {
        const property = propertyOf(input.propertyId);
        // Google en yeni olayı önce döndürür; aynı anda gelenler ekleme sırasıyla.
        const matching = property.history
          .filter((item) => item.at >= earliest && item.at <= latest)
          .sort((a, b) => b.at - a.at)
          .map((item) => item.event);
        const offset = input.pageToken ? Number(input.pageToken) : 0;
        if (!Number.isInteger(offset) || offset < 0) {
          throw gaValidationError("Invalid page token");
        }
        const page = matching.slice(offset, offset + pageSize);
        const next = offset + pageSize;
        return {
          events: copy(page),
          nextPageToken: next < matching.length ? String(next) : null,
        };
      });
    },
  };
}
