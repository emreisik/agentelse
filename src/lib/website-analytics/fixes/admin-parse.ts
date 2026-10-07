import { GoogleApiError } from "@/server/integrations/google/errors";

import type {
  GaAnnotationResource,
  GaChangeHistoryChange,
  GaChangeHistoryEvent,
  GaChannelGroupResource,
  GaEnhancedMeasurementPatch,
  GaEnhancedMeasurementResource,
  GaKeyEventResource,
  GaRetentionResource,
} from "./resources";

// GA-F7: Analytics Admin API yanıtlarının toleranslı ayrıştırıcıları ve yol
// doğrulayıcıları (saf modül: ağ ve DB yok). Bilinmeyen ek alanlar yok
// sayılır, isteğe bağlı alanlar varsayılan alır; ZORUNLU bir alan eksikse ya
// da türü yanlışsa UNEXPECTED_SHAPE fırlatılır (v1alpha biçimi sessizce
// değişebilir; hata sınıfı UNKNOWN, tüketici bunu "google_changed" yapar).
// Eylemi yapanın e-postası (userActorEmail) hiçbir çıktıya girmez.

const SHAPE_MESSAGE = "Google returned an unexpected response";

export function gaShapeError(): GoogleApiError {
  return new GoogleApiError(SHAPE_MESSAGE, "UNEXPECTED_SHAPE", {
    errorClass: "UNKNOWN",
  });
}

// Yerel (Google'a gitmeden) doğrulama hatası: istek hiç yapılmaz.
export function gaValidationError(message: string): GoogleApiError {
  return new GoogleApiError(message, "INVALID_ARGUMENT", {
    errorClass: "VALIDATION",
  });
}

// --- Yol doğrulayıcıları (SSRF ve yol enjeksiyonuna karşı) ---

const NUMERIC_ID = /^\d{1,20}$/;
const RESOURCE_NAME =
  /^properties\/\d+\/(keyEvents|channelGroups|reportingDataAnnotations)\/[A-Za-z0-9_-]+$/;

export type GaResourceCollection =
  | "keyEvents"
  | "channelGroups"
  | "reportingDataAnnotations";

export function isGaResourceName(value: string): boolean {
  return typeof value === "string" && RESOURCE_NAME.test(value);
}

// Belirli bir koleksiyona ait kaynak adı (deleteKeyEvent'e kanal grubu adı
// verilemez).
export function isGaResourceNameOf(
  value: string,
  collection: GaResourceCollection,
): boolean {
  return (
    isGaResourceName(value) && value.split("/")[2] === collection
  );
}

export function requireGaResourceName(
  value: string,
  collection: GaResourceCollection,
): string {
  if (!isGaResourceNameOf(value, collection)) {
    throw gaValidationError("Invalid Google Analytics resource name");
  }
  return value;
}

export function requireGaNumericId(value: string, label: string): string {
  if (typeof value !== "string" || !NUMERIC_ID.test(value)) {
    throw gaValidationError(`Invalid Google Analytics ${label}`);
  }
  return value;
}

const EVENT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
export function requireGaEventName(value: string): string {
  if (typeof value !== "string" || !EVENT_NAME.test(value)) {
    throw gaValidationError("Invalid event name");
  }
  return value;
}

const RETENTION_VALUE = /^[A-Z][A-Z_]{1,40}$/;
export function requireGaRetentionValue(value: string): string {
  if (typeof value !== "string" || !RETENTION_VALUE.test(value)) {
    throw gaValidationError("Invalid retention value");
  }
  return value;
}

// YYYY-MM-DD gerçek bir takvim günü mü; değilse VALIDATION.
export function parseGaDay(day: string): {
  year: number;
  month: number;
  day: number;
} {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(
    typeof day === "string" ? day : "",
  );
  if (!match) throw gaValidationError("Invalid day");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, date));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== date
  ) {
    throw gaValidationError("Invalid day");
  }
  return { year, month, day: date };
}

// Gelişmiş ölçüm yaması: izinli alanlar sabit sırayla (updateMask sırası
// kararlı olsun), tür denetimli. Boş yama VALIDATION.
const ENHANCED_BOOLEAN_KEYS = [
  "streamEnabled",
  "scrollsEnabled",
  "outboundClicksEnabled",
  "siteSearchEnabled",
  "fileDownloadsEnabled",
  "formInteractionsEnabled",
] as const;
const ENHANCED_PATCH_KEYS: readonly string[] = [
  ...ENHANCED_BOOLEAN_KEYS,
  "searchQueryParameter",
];

export function buildEnhancedMeasurementPatch(patch: GaEnhancedMeasurementPatch): {
  keys: string[];
  body: Record<string, boolean | string>;
} {
  for (const key of Object.keys(patch)) {
    if (!ENHANCED_PATCH_KEYS.includes(key)) {
      throw gaValidationError("Unknown enhanced measurement field");
    }
  }
  const keys: string[] = [];
  const body: Record<string, boolean | string> = {};
  for (const key of ENHANCED_BOOLEAN_KEYS) {
    const value = patch[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") {
      throw gaValidationError("Invalid enhanced measurement value");
    }
    keys.push(key);
    body[key] = value;
  }
  const query = patch.searchQueryParameter;
  if (query !== undefined) {
    if (typeof query !== "string" || query.length > 200) {
      throw gaValidationError("Invalid enhanced measurement value");
    }
    keys.push("searchQueryParameter");
    body.searchQueryParameter = query;
  }
  if (keys.length === 0) {
    throw gaValidationError("Nothing to change");
  }
  return { keys, body };
}

// --- Ayrıştırıcı yardımcıları ---

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function obj(value: unknown): Json {
  if (!isObject(value)) throw gaShapeError();
  return value;
}

function reqStr(source: Json, key: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.length === 0) throw gaShapeError();
  return value;
}

function optStr(source: Json, key: string): string | null {
  const value = source[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw gaShapeError();
  return value;
}

function optBool(source: Json, key: string): boolean {
  const value = source[key];
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") throw gaShapeError();
  return value;
}

function listOf<T>(raw: unknown, key: string, parse: (item: unknown) => T): T[] {
  const body = obj(raw);
  const items = body[key];
  // Google boş listede alanı hiç göndermez.
  if (items === undefined || items === null) return [];
  if (!Array.isArray(items)) throw gaShapeError();
  return items.map(parse);
}

// --- Kaynak ayrıştırıcıları ---

export function parseKeyEvent(raw: unknown): GaKeyEventResource {
  const source = obj(raw);
  return {
    name: reqStr(source, "name"),
    eventName: reqStr(source, "eventName"),
    countingMethod: optStr(source, "countingMethod"),
    custom: optBool(source, "custom"),
    deletable: optBool(source, "deletable"),
  };
}

export function parseKeyEventList(raw: unknown): GaKeyEventResource[] {
  return listOf(raw, "keyEvents", parseKeyEvent);
}

export function parseRetention(raw: unknown): GaRetentionResource {
  const source = obj(raw);
  return {
    eventDataRetention: reqStr(source, "eventDataRetention"),
    resetUserDataOnNewActivity: optBool(source, "resetUserDataOnNewActivity"),
  };
}

export function parseEnhanced(raw: unknown): GaEnhancedMeasurementResource {
  const source = obj(raw);
  return {
    name: reqStr(source, "name"),
    streamEnabled: optBool(source, "streamEnabled"),
    scrollsEnabled: optBool(source, "scrollsEnabled"),
    outboundClicksEnabled: optBool(source, "outboundClicksEnabled"),
    siteSearchEnabled: optBool(source, "siteSearchEnabled"),
    videoEngagementEnabled: optBool(source, "videoEngagementEnabled"),
    fileDownloadsEnabled: optBool(source, "fileDownloadsEnabled"),
    formInteractionsEnabled: optBool(source, "formInteractionsEnabled"),
    pageChangesEnabled: optBool(source, "pageChangesEnabled"),
    searchQueryParameter: optStr(source, "searchQueryParameter") ?? "",
    uriQueryParameter: optStr(source, "uriQueryParameter"),
  };
}

export function parseChannelGroup(raw: unknown): GaChannelGroupResource {
  const source = obj(raw);
  const rules = source.groupingRule;
  if (rules !== undefined && rules !== null && !Array.isArray(rules)) {
    throw gaShapeError();
  }
  return {
    name: reqStr(source, "name"),
    displayName: reqStr(source, "displayName"),
    description: optStr(source, "description"),
    systemDefined: optBool(source, "systemDefined"),
    ruleCount: Array.isArray(rules) ? rules.length : 0,
  };
}

export function parseChannelGroupList(raw: unknown): GaChannelGroupResource[] {
  return listOf(raw, "channelGroups", parseChannelGroup);
}

function dayFromDate(value: unknown): string | null {
  if (!isObject(value)) return null;
  const { year, month, day } = value;
  if (
    typeof year !== "number" ||
    typeof month !== "number" ||
    typeof day !== "number" ||
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    return null;
  }
  const pad = (n: number, width: number) => String(n).padStart(width, "0");
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

export function parseAnnotation(raw: unknown): GaAnnotationResource {
  const source = obj(raw);
  return {
    name: reqStr(source, "name"),
    title: reqStr(source, "title"),
    description: optStr(source, "description"),
    // Tarih aralığı (annotationDateRange) ya da eksik tarih: day null.
    day: dayFromDate(source.annotationDate),
    color: optStr(source, "color"),
    systemGenerated: optBool(source, "systemGenerated"),
  };
}

export function parseAnnotationList(raw: unknown): GaAnnotationResource[] {
  return listOf(raw, "reportingDataAnnotations", parseAnnotation);
}

// Değişim geçmişi: "before/after" Google'ın ChangeHistoryResource sarmalayıcısı
// (ör. { keyEvent: {...} }) olduğu gibi, ama e-posta içeren her anahtar
// ve e-posta gibi görünen her metin değeri özyinelemeli silinir (Limited Use;
// actor e-postası hiçbir yerde kalmaz).
const EMAIL_VALUE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
function scrub(value: unknown, depth: number): unknown {
  if (depth > 6) return null;
  if (Array.isArray(value)) return value.map((item) => scrub(item, depth + 1));
  if (isObject(value)) {
    const out: Json = {};
    for (const [key, item] of Object.entries(value)) {
      if (/email/i.test(key)) continue;
      if (typeof item === "string" && EMAIL_VALUE.test(item)) continue;
      out[key] = scrub(item, depth + 1);
    }
    return out;
  }
  return value;
}

function resourceSnapshot(value: unknown): Json | null {
  if (value === undefined || value === null) return null;
  if (!isObject(value)) throw gaShapeError();
  return scrub(value, 0) as Json;
}

function parseActorType(value: unknown): GaChangeHistoryEvent["actorType"] {
  return value === "USER" || value === "SYSTEM" || value === "SUPPORT"
    ? value
    : "UNKNOWN";
}

function parseAction(value: unknown): GaChangeHistoryChange["action"] {
  return value === "CREATED" || value === "UPDATED" || value === "DELETED"
    ? value
    : "UNKNOWN";
}

function parseChange(raw: unknown): GaChangeHistoryChange {
  const source = obj(raw);
  return {
    resource: reqStr(source, "resource"),
    action: parseAction(source.action),
    before: resourceSnapshot(source.resourceBeforeChange),
    after: resourceSnapshot(source.resourceAfterChange),
  };
}

function parseEvent(raw: unknown): GaChangeHistoryEvent {
  const source = obj(raw);
  const changes = source.changes;
  if (changes !== undefined && changes !== null && !Array.isArray(changes)) {
    throw gaShapeError();
  }
  return {
    id: reqStr(source, "id"),
    changeTime: reqStr(source, "changeTime"),
    actorType: parseActorType(source.actorType),
    changes: Array.isArray(changes) ? changes.map(parseChange) : [],
  };
}

export function parseChangeHistory(raw: unknown): {
  events: GaChangeHistoryEvent[];
  nextPageToken: string | null;
} {
  const body = obj(raw);
  const token = body.nextPageToken;
  if (token !== undefined && token !== null && typeof token !== "string") {
    throw gaShapeError();
  }
  return {
    events: listOf(body, "changeHistoryEvents", parseEvent),
    nextPageToken: typeof token === "string" && token ? token : null,
  };
}
