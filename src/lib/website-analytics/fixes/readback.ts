import { GA_AI_CHANNEL_GROUP_NAME } from "./channel-group";
import type {
  GaAnnotationResource,
  GaChannelGroupResource,
  GaEnhancedMeasurementPatch,
  GaEnhancedMeasurementResource,
  GaKeyEventResource,
} from "./resources";
import type {
  GaFixCurrent,
  GaFixParams,
  GaFixSnapshot,
  GaFixUndoOp,
  GaFixWrite,
} from "./types";

// GA-F7 geri okuma doğrulaması: yazmadan sonra canlı durum yeniden okunur ve
// değişikliğin gerçekten orada olduğu kanıtlanır. Anlık görüntü kurucuları
// planlama (plan.ts) ile ortaktır.

// Gelişmiş ölçümde Agentelse'in dokunabildiği beş otomatik öğe.
export const ENHANCED_BOOLEAN_KEYS = [
  "streamEnabled",
  "scrollsEnabled",
  "outboundClicksEnabled",
  "siteSearchEnabled",
  "fileDownloadsEnabled",
] as const;
export type EnhancedBooleanKey = (typeof ENHANCED_BOOLEAN_KEYS)[number];

export function keyEventSnapshot(
  found: GaKeyEventResource | undefined,
): GaFixSnapshot {
  return {
    kind: "KEY_EVENT_CREATE",
    exists: Boolean(found),
    resourceName: found?.name ?? null,
    deletable: found ? found.deletable : null,
  };
}

export function retentionSnapshot(value: string | null): GaFixSnapshot {
  return { kind: "RETENTION_14M", eventDataRetention: value };
}

export function enhancedSnapshot(
  streamId: string,
  settings: GaEnhancedMeasurementResource,
): GaFixSnapshot {
  return {
    kind: "ENHANCED_MEASUREMENT",
    streamId,
    streamEnabled: settings.streamEnabled,
    scrollsEnabled: settings.scrollsEnabled,
    outboundClicksEnabled: settings.outboundClicksEnabled,
    siteSearchEnabled: settings.siteSearchEnabled,
    fileDownloadsEnabled: settings.fileDownloadsEnabled,
    searchQueryParameter: settings.searchQueryParameter || null,
  };
}

export function channelGroupSnapshot(
  found: GaChannelGroupResource | undefined,
): GaFixSnapshot {
  return {
    kind: "CHANNEL_GROUP_AI",
    exists: Boolean(found),
    resourceName: found?.name ?? null,
  };
}

export function annotationSnapshot(
  found: GaAnnotationResource | undefined,
): GaFixSnapshot {
  return {
    kind: "ANNOTATION_CREATE",
    exists: Boolean(found),
    resourceName: found?.name ?? null,
  };
}

export function findKeyEvent(
  keyEvents: readonly GaKeyEventResource[],
  eventName: string,
): GaKeyEventResource | undefined {
  return keyEvents.find((event) => event.eventName === eventName);
}

export function findAiChannelGroup(
  groups: readonly GaChannelGroupResource[],
): GaChannelGroupResource | undefined {
  return groups.find(
    (group) => group.displayName.trim() === GA_AI_CHANNEL_GROUP_NAME,
  );
}

export function findAnnotation(
  annotations: readonly GaAnnotationResource[],
  title: string,
  day: string,
): GaAnnotationResource | undefined {
  return annotations.find(
    (annotation) => annotation.title === title && annotation.day === day,
  );
}

type ReadBackResult =
  | { ok: true; snapshot: GaFixSnapshot; resourceName: string | null }
  | { ok: false; reason: string };

// Yazılan şeyin canlı listede ya da değerde görünüp görünmediğini denetler.
// Google yazmayı kabul edip saklamadıysa ('yalan') uyuşmazlık döner.
export function verifyReadBack(
  params: GaFixParams,
  write: GaFixWrite,
  after: GaFixCurrent,
): ReadBackResult {
  if (params.kind === "KEY_EVENT_CREATE") {
    if (
      write.op !== "createKeyEvent" ||
      after.kind !== "KEY_EVENT_CREATE" ||
      write.eventName !== params.eventName
    ) {
      return { ok: false, reason: "kind_mismatch" };
    }
    const found = findKeyEvent(after.keyEvents, params.eventName);
    if (!found) return { ok: false, reason: "not_in_list" };
    return {
      ok: true,
      snapshot: keyEventSnapshot(found),
      resourceName: found.name,
    };
  }
  if (params.kind === "RETENTION_14M") {
    if (write.op !== "updateRetention" || after.kind !== "RETENTION_14M") {
      return { ok: false, reason: "kind_mismatch" };
    }
    const value = after.retention.eventDataRetention;
    if (value !== write.value) return { ok: false, reason: "value_not_applied" };
    return {
      ok: true,
      snapshot: retentionSnapshot(value),
      resourceName: null,
    };
  }
  if (params.kind === "ENHANCED_MEASUREMENT") {
    if (write.op !== "updateEnhanced" || after.kind !== "ENHANCED_MEASUREMENT") {
      return { ok: false, reason: "kind_mismatch" };
    }
    const missing: string[] = [];
    for (const key of ENHANCED_BOOLEAN_KEYS) {
      if (write.patch[key] === true && after.settings[key] !== true) {
        missing.push(key);
      }
    }
    if (
      typeof write.patch.searchQueryParameter === "string" &&
      !after.settings.searchQueryParameter
    ) {
      missing.push("searchQueryParameter");
    }
    if (missing.length > 0) {
      return { ok: false, reason: `not_applied:${missing.join(",")}` };
    }
    return {
      ok: true,
      snapshot: enhancedSnapshot(write.streamId, after.settings),
      resourceName: null,
    };
  }
  if (params.kind === "CHANNEL_GROUP_AI") {
    if (write.op !== "createChannelGroup" || after.kind !== "CHANNEL_GROUP_AI") {
      return { ok: false, reason: "kind_mismatch" };
    }
    const found = findAiChannelGroup(after.groups);
    if (!found) return { ok: false, reason: "not_in_list" };
    return {
      ok: true,
      snapshot: channelGroupSnapshot(found),
      resourceName: found.name,
    };
  }
  if (write.op !== "createAnnotation" || after.kind !== "ANNOTATION_CREATE") {
    return { ok: false, reason: "kind_mismatch" };
  }
  const found = findAnnotation(after.annotations, params.title, params.day);
  if (!found) return { ok: false, reason: "not_in_list" };
  return {
    ok: true,
    snapshot: annotationSnapshot(found),
    resourceName: found.name,
  };
}

function patchApplied(
  patch: GaEnhancedMeasurementPatch,
  settings: GaEnhancedMeasurementResource,
): boolean {
  for (const key of Object.keys(patch) as (keyof GaEnhancedMeasurementPatch)[]) {
    if (patch[key] !== settings[key]) return false;
  }
  return true;
}

// Geri almanın gerçekten uygulandığını canlı durumdan doğrular.
export function verifyUndo(undo: GaFixUndoOp, current: GaFixCurrent): boolean {
  switch (undo.op) {
    case "deleteKeyEvent":
      return (
        current.kind === "KEY_EVENT_CREATE" &&
        !current.keyEvents.some((event) => event.name === undo.resourceName)
      );
    case "restoreRetention":
      return (
        current.kind === "RETENTION_14M" &&
        current.retention.eventDataRetention === undo.value
      );
    case "restoreEnhanced":
      return (
        current.kind === "ENHANCED_MEASUREMENT" &&
        patchApplied(undo.patch, current.settings)
      );
    case "deleteChannelGroup":
      return (
        current.kind === "CHANNEL_GROUP_AI" &&
        !current.groups.some((group) => group.name === undo.resourceName)
      );
    case "deleteAnnotation":
      return (
        current.kind === "ANNOTATION_CREATE" &&
        !current.annotations.some(
          (annotation) => annotation.name === undo.resourceName,
        )
      );
  }
}
