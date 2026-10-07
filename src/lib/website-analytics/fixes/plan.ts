import { buildAiChannelGroup } from "./channel-group";
import {
  ENHANCED_BOOLEAN_KEYS,
  annotationSnapshot,
  channelGroupSnapshot,
  enhancedSnapshot,
  findAiChannelGroup,
  findAnnotation,
  findKeyEvent,
  keyEventSnapshot,
  retentionSnapshot,
} from "./readback";
import type { GaEnhancedMeasurementPatch } from "./resources";
import type {
  GaFixCurrent,
  GaFixKind,
  GaFixParams,
  GaFixPlan,
  GaFixSnapshot,
  GaFixUndoOp,
} from "./types";

// GA-F7 planlama: canlı durumdan ne yazılacağı (ya da hiçbir şey) hesaplanır.
// Saf: hiçbir ağ ya da veritabanı çağrısı yok. Doğrulama işlevleri
// readback.ts'te durur; kolaylık için buradan da dışa verilir.

export type {
  GaFixCurrent,
  GaFixPlan,
  GaFixUndoOp,
  GaFixWrite,
} from "./types";
export {
  enhancedSnapshot,
  keyEventSnapshot,
  channelGroupSnapshot,
  annotationSnapshot,
  retentionSnapshot,
  verifyReadBack,
  verifyUndo,
} from "./readback";

const RETENTION_RANK: Record<string, number> = {
  TWO_MONTHS: 1,
  FOURTEEN_MONTHS: 2,
  TWENTY_SIX_MONTHS: 3,
  THIRTY_EIGHT_MONTHS: 4,
  FIFTY_MONTHS: 5,
};

// Bilinmeyen ya da boş değer 0 sayılır (en kısa).
export function retentionRank(value: string | null): number {
  return value ? (RETENTION_RANK[value] ?? 0) : 0;
}

export const GA_SEARCH_QUERY_PARAMETER_DEFAULT = "q,s,search,query,keyword";
const FOURTEEN_MONTHS_RANK = retentionRank("FOURTEEN_MONTHS");

// Başlık/gövde dışı alanlar: yaratılan kaynaklara Agentelse'in eklediği not.
export const GA_ANNOTATION_DESCRIPTION = "Added by Agentelse after approval";

function mismatch(params: GaFixParams, current: GaFixCurrent): never {
  throw new Error(`ga_fix_kind_mismatch:${params.kind}:${current.kind}`);
}

// Mevcut duruma göre yazma planı: zaten sağlanmışsa noop (yazma yok, geri
// alma yok); sınır doluysa ret; değilse tek bir yazma.
export function planFix(
  params: GaFixParams,
  current: GaFixCurrent,
): GaFixPlan {
  if (params.kind === "KEY_EVENT_CREATE") {
    if (current.kind !== "KEY_EVENT_CREATE") return mismatch(params, current);
    const found = findKeyEvent(current.keyEvents, params.eventName);
    if (found) return { kind: "noop", snapshot: keyEventSnapshot(found) };
    if (current.keyEvents.length >= current.limit) {
      return { kind: "refuse", code: "limit_reached" };
    }
    return {
      kind: "write",
      before: keyEventSnapshot(undefined),
      write: { op: "createKeyEvent", eventName: params.eventName },
    };
  }
  if (params.kind === "RETENTION_14M") {
    if (current.kind !== "RETENTION_14M") return mismatch(params, current);
    const value = current.retention.eventDataRetention;
    const snapshot = retentionSnapshot(value);
    if (retentionRank(value) >= FOURTEEN_MONTHS_RANK) {
      return { kind: "noop", snapshot };
    }
    return {
      kind: "write",
      before: snapshot,
      write: { op: "updateRetention", value: "FOURTEEN_MONTHS" },
    };
  }
  if (params.kind === "ENHANCED_MEASUREMENT") {
    if (current.kind !== "ENHANCED_MEASUREMENT") {
      return mismatch(params, current);
    }
    const { settings, streamId } = current;
    const snapshot = enhancedSnapshot(streamId, settings);
    const patch: GaEnhancedMeasurementPatch = {};
    for (const key of ENHANCED_BOOLEAN_KEYS) {
      if (!settings[key]) patch[key] = true;
    }
    if (Object.keys(patch).length === 0) return { kind: "noop", snapshot };
    // Site araması açılırken sorgu parametresi boşsa varsayılan eklenir.
    if (patch.siteSearchEnabled && !settings.searchQueryParameter) {
      patch.searchQueryParameter = GA_SEARCH_QUERY_PARAMETER_DEFAULT;
    }
    return {
      kind: "write",
      before: snapshot,
      write: { op: "updateEnhanced", streamId, patch },
    };
  }
  if (params.kind === "CHANNEL_GROUP_AI") {
    if (current.kind !== "CHANNEL_GROUP_AI") return mismatch(params, current);
    const found = findAiChannelGroup(current.groups);
    if (found) return { kind: "noop", snapshot: channelGroupSnapshot(found) };
    return {
      kind: "write",
      before: channelGroupSnapshot(undefined),
      write: { op: "createChannelGroup", body: buildAiChannelGroup() },
    };
  }
  if (current.kind !== "ANNOTATION_CREATE") return mismatch(params, current);
  const found = findAnnotation(current.annotations, params.title, params.day);
  if (found) return { kind: "noop", snapshot: annotationSnapshot(found) };
  return {
    kind: "write",
    before: annotationSnapshot(undefined),
    write: {
      op: "createAnnotation",
      input: {
        title: params.title,
        description: GA_ANNOTATION_DESCRIPTION,
        day: params.day,
        color: "BLUE",
      },
    },
  };
}

type EnhancedSnapshot = Extract<
  GaFixSnapshot,
  { kind: "ENHANCED_MEASUREMENT" }
>;

// Öncesi ve sonrası arasında farklı olan öğeler; geri almada öncesine döner.
// Sorgu parametresi öncesinde boşsa geri alınmaz: site araması kapanınca
// kalan varsayılan parametre zararsızdır ve boş değer Google'da geçersiz
// olabilir.
function enhancedDiff(
  before: EnhancedSnapshot,
  after: EnhancedSnapshot,
): GaEnhancedMeasurementPatch {
  const patch: GaEnhancedMeasurementPatch = {};
  for (const key of ENHANCED_BOOLEAN_KEYS) {
    if (before[key] !== after[key]) patch[key] = before[key];
  }
  if (
    before.searchQueryParameter &&
    before.searchQueryParameter !== after.searchQueryParameter
  ) {
    patch.searchQueryParameter = before.searchQueryParameter;
  }
  return patch;
}

export function planUndo(change: {
  kind: GaFixKind;
  noop: boolean;
  before: GaFixSnapshot | null;
  after: GaFixSnapshot | null;
  resourceName: string | null;
}):
  | { ok: true; undo: GaFixUndoOp }
  | { ok: false; reason: string } {
  if (change.noop) return { ok: false, reason: "nothing_to_undo" };
  const { before, after } = change;
  if (!before) return { ok: false, reason: "no_snapshot" };
  switch (change.kind) {
    case "KEY_EVENT_CREATE": {
      if (before.kind !== "KEY_EVENT_CREATE" || before.exists) {
        return { ok: false, reason: "not_created_by_us" };
      }
      const name =
        change.resourceName ??
        (after?.kind === "KEY_EVENT_CREATE" ? after.resourceName : null);
      if (!name) return { ok: false, reason: "no_resource" };
      if (after?.kind === "KEY_EVENT_CREATE" && after.deletable === false) {
        return { ok: false, reason: "not_deletable" };
      }
      return { ok: true, undo: { op: "deleteKeyEvent", resourceName: name } };
    }
    case "RETENTION_14M": {
      if (before.kind !== "RETENTION_14M" || !before.eventDataRetention) {
        return { ok: false, reason: "no_snapshot" };
      }
      return {
        ok: true,
        undo: { op: "restoreRetention", value: before.eventDataRetention },
      };
    }
    case "ENHANCED_MEASUREMENT": {
      if (
        before.kind !== "ENHANCED_MEASUREMENT" ||
        after?.kind !== "ENHANCED_MEASUREMENT"
      ) {
        return { ok: false, reason: "no_snapshot" };
      }
      const patch = enhancedDiff(before, after);
      if (Object.keys(patch).length === 0) {
        return { ok: false, reason: "nothing_to_undo" };
      }
      return {
        ok: true,
        undo: { op: "restoreEnhanced", streamId: before.streamId, patch },
      };
    }
    case "CHANNEL_GROUP_AI":
    case "ANNOTATION_CREATE": {
      if (before.kind !== change.kind || before.exists) {
        return { ok: false, reason: "not_created_by_us" };
      }
      const name =
        change.resourceName ??
        (after && after.kind === change.kind ? after.resourceName : null);
      if (!name) return { ok: false, reason: "no_resource" };
      return {
        ok: true,
        undo:
          change.kind === "CHANNEL_GROUP_AI"
            ? { op: "deleteChannelGroup", resourceName: name }
            : { op: "deleteAnnotation", resourceName: name },
      };
    }
  }
}

// Geri almadan önce: tek örnekli kaynaklarda (saklama, gelişmiş ölçüm) canlı
// durum hâlâ düzeltmenin bıraktığı gibi olmalı; arada elle değiştirildiyse
// üzerine yazılmaz. `before` verilirse yalnız düzeltmenin değiştirdiği
// öğeler denetlenir, verilmezse sonrası anlık görüntüsündeki tüm öğeler.
export function undoPrecondition(
  change: {
    kind: GaFixKind;
    after: GaFixSnapshot | null;
    before?: GaFixSnapshot | null;
  },
  current: GaFixCurrent,
): boolean {
  switch (change.kind) {
    case "RETENTION_14M":
      return (
        current.kind === "RETENTION_14M" &&
        change.after?.kind === "RETENTION_14M" &&
        current.retention.eventDataRetention === change.after.eventDataRetention
      );
    case "ENHANCED_MEASUREMENT": {
      const after = change.after;
      if (current.kind !== "ENHANCED_MEASUREMENT") return false;
      if (after?.kind !== "ENHANCED_MEASUREMENT") return false;
      const before =
        change.before?.kind === "ENHANCED_MEASUREMENT" ? change.before : null;
      for (const key of ENHANCED_BOOLEAN_KEYS) {
        if (before && before[key] === after[key]) continue;
        if (current.settings[key] !== after[key]) return false;
      }
      if (
        (!before || before.searchQueryParameter !== after.searchQueryParameter) &&
        after.searchQueryParameter &&
        current.settings.searchQueryParameter !== after.searchQueryParameter
      ) {
        return false;
      }
      return true;
    }
    default:
      // Yaratılan kaynaklar adıyla silinir; yoksa motor 'zaten yok' sayar.
      return true;
  }
}
