import type { GaChangeHistoryEvent } from "./resources";
import { retentionRank } from "./plan";

// GA-F7 değişiklik geçmişi: Google Analytics'te Agentelse dışında yapılan
// anahtar olay silme ve saklama kısaltma değişikliklerini bulur. Saf;
// çıktıda kimse (e-posta, ad) yoktur, olaylar saklanmaz.

export type GaOwnTouch = { resource: string; at: Date };

export type GaManualChangeFindings = {
  removedKeyEvents: string[];
  retentionShortened: boolean;
  retentionBefore: string | null;
  unparsed: number;
  eventsSeen: number;
};

const OWN_WINDOW_MS = 15 * 60 * 1000;
const MAX_REMOVED = 10;
// Google olay adı biçimi; alarm anahtarına girdiği için sıkı tutulur.
const EVENT_NAME = /^[A-Za-z0-9_]{1,40}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nested(
  source: Record<string, unknown> | null,
  key: string,
): Record<string, unknown> | null {
  const value = source?.[key];
  return isRecord(value) ? value : null;
}

// Hem v1beta keyEvents hem eski conversionEvents biçimi okunur.
function removedEventName(
  before: Record<string, unknown> | null,
): string | null {
  const candidates = [
    nested(before, "keyEvent")?.eventName,
    nested(before, "conversionEvent")?.eventName,
    before?.eventName,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && EVENT_NAME.test(candidate)) {
      return candidate;
    }
  }
  return null;
}

function retentionValue(
  side: Record<string, unknown> | null,
): string | null {
  const value =
    nested(side, "dataRetentionSettings")?.eventDataRetention ??
    side?.eventDataRetention;
  return typeof value === "string" && value ? value : null;
}

function isOwn(
  resource: string,
  changeTime: number,
  touches: readonly GaOwnTouch[],
): boolean {
  return touches.some((touch) => {
    const sameResource =
      resource === touch.resource || resource.startsWith(`${touch.resource}/`);
    return (
      sameResource && Math.abs(changeTime - touch.at.getTime()) <= OWN_WINDOW_MS
    );
  });
}

export function detectManualChanges(
  events: GaChangeHistoryEvent[],
  ctx: { ownTouches: GaOwnTouch[] },
): GaManualChangeFindings {
  const removed = new Set<string>();
  let retentionShortened = false;
  let retentionBefore: string | null = null;
  let unparsed = 0;

  for (const event of events) {
    if (event.actorType !== "USER") continue;
    const changeTime = Date.parse(event.changeTime);
    for (const change of event.changes) {
      const resource = change.resource;
      if (
        Number.isFinite(changeTime) &&
        isOwn(resource, changeTime, ctx.ownTouches)
      ) {
        continue;
      }
      if (
        change.action === "DELETED" &&
        (resource.includes("/keyEvents/") ||
          resource.includes("/conversionEvents/"))
      ) {
        const name = removedEventName(change.before);
        if (name) removed.add(name);
        else unparsed += 1;
        continue;
      }
      if (
        change.action === "UPDATED" &&
        resource.includes("/dataRetentionSettings")
      ) {
        const before = retentionValue(change.before);
        const after = retentionValue(change.after);
        if (!before || !after) {
          unparsed += 1;
          continue;
        }
        if (retentionRank(after) < retentionRank(before)) {
          retentionShortened = true;
          if (
            retentionBefore === null ||
            retentionRank(before) > retentionRank(retentionBefore)
          ) {
            retentionBefore = before;
          }
        }
      }
    }
  }

  return {
    removedKeyEvents: [...removed].sort().slice(0, MAX_REMOVED),
    retentionShortened,
    retentionBefore,
    unparsed,
    eventsSeen: events.length,
  };
}
