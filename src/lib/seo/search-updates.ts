// Google arama güncellemeleri takvimi (docs/search-health.md "Google
// güncellemeleri"). Kaynak: Google Search Status Dashboard'un
// incidents.json akışı ([{ id, begin, end?, external_desc, service_name,
// uri, ... }], son ~10 olay; biçim belgelenmemiş, ayrıştırıcı savunmacıdır).
// Serving olayları genel adlar taşıdığı için anahtar olay kimliğidir.

export const SEARCH_UPDATE_KINDS = [
  "CORE",
  "SPAM",
  "DISCOVER",
  "REVIEWS",
  "HELPFUL_CONTENT",
  "OTHER_RANKING",
  "SERVING",
  "CRAWLING",
  "INDEXING",
  "OTHER",
] as const;

export type SearchUpdateKind = (typeof SEARCH_UPDATE_KINDS)[number];

export type ParsedSearchUpdate = {
  externalId: string;
  name: string;
  kind: SearchUpdateKind;
  startedAt: Date;
  endedAt: Date | null;
  url: string | null;
};

export const STATUS_DASHBOARD_ORIGIN = "https://status.search.google.com";

const MAX_NAME = 200;
const MAX_INCIDENTS = 100;

export function isSearchUpdateKind(value: string): value is SearchUpdateKind {
  return (SEARCH_UPDATE_KINDS as readonly string[]).includes(value);
}

// Önce açıklamadaki güncelleme türü, sonra servis adı.
export function searchUpdateKind(
  serviceName: string | null,
  description: string,
): SearchUpdateKind {
  if (/\bcore update\b/i.test(description)) return "CORE";
  if (/\bspam\b/i.test(description)) return "SPAM";
  if (/\bdiscover\b/i.test(description)) return "DISCOVER";
  if (/\breviews? update\b/i.test(description)) return "REVIEWS";
  if (/\bhelpful content\b/i.test(description)) return "HELPFUL_CONTENT";
  const service = (serviceName ?? "").trim().toLowerCase();
  if (service === "ranking") return "OTHER_RANKING";
  if (service === "serving") return "SERVING";
  if (service === "crawling") return "CRAWLING";
  if (service === "indexing") return "INDEXING";
  return "OTHER";
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function date(value: unknown): Date | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// "incidents/abc" → mutlak https adresi; başka bir köke giden adres alınmaz.
function incidentUrl(uri: string | null): string | null {
  if (!uri) return null;
  try {
    const url = new URL(uri, `${STATUS_DASHBOARD_ORIGIN}/`);
    return url.origin === STATUS_DASHBOARD_ORIGIN ? url.toString() : null;
  } catch {
    return null;
  }
}

export function parseStatusIncidents(raw: unknown): ParsedSearchUpdate[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const updates: ParsedSearchUpdate[] = [];
  for (const item of raw.slice(0, MAX_INCIDENTS)) {
    const incident = record(item);
    const externalId = text(incident?.id);
    const name = text(incident?.external_desc);
    const startedAt = date(incident?.begin);
    if (!incident || !externalId || !name || !startedAt) continue;
    if (seen.has(externalId)) continue;
    seen.add(externalId);
    const end = date(incident.end);
    updates.push({
      externalId: externalId.slice(0, 100),
      name: name.slice(0, MAX_NAME),
      kind: searchUpdateKind(text(incident.service_name), name),
      startedAt,
      endedAt: end && end.getTime() >= startedAt.getTime() ? end : null,
      url: incidentUrl(text(incident.uri)),
    });
  }
  return updates;
}

// [from, to] ile örtüşen güncellemeler; bitişi olmayan (süren) güncelleme
// şu ana kadar sürüyor sayılır.
export function updatesOverlapping<
  T extends { startedAt: Date; endedAt: Date | null },
>(updates: readonly T[], from: Date, to: Date, now: Date): T[] {
  return updates.filter((update) => {
    const end = update.endedAt ?? now;
    return (
      update.startedAt.getTime() <= to.getTime() &&
      end.getTime() >= from.getTime()
    );
  });
}
