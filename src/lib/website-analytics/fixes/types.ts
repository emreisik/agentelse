import type {
  GaAnnotationCreate,
  GaAnnotationResource,
  GaChannelGroupCreate,
  GaChannelGroupResource,
  GaEnhancedMeasurementPatch,
  GaEnhancedMeasurementResource,
  GaKeyEventResource,
  GaRetentionResource,
} from "./resources";

// GA-F7 düzeltme eylemlerinin ortak tipleri (docs/website-fixes.md). Saf ve
// izomorfik: sunucu modülü, prisma ya da env içe aktarılmaz.

export const GA_FIX_KINDS = [
  "KEY_EVENT_CREATE",
  "RETENTION_14M",
  "ENHANCED_MEASUREMENT",
  "CHANNEL_GROUP_AI",
  "ANNOTATION_CREATE",
] as const;
export type GaFixKind = (typeof GA_FIX_KINDS)[number];

export const GA_FIX_STATUSES = [
  "PROPOSED",
  "APPROVED",
  "APPLYING",
  "APPLIED",
  "VERIFIED",
  "FAILED",
  "UNDOING",
  "UNDONE",
  "REJECTED",
  "EXPIRED",
] as const;
export type GaFixStatus = (typeof GA_FIX_STATUSES)[number];

export type GaFixSource = "GUIDE" | "PANEL" | "AUTO" | "API";

export type GaFixParams =
  | { kind: "KEY_EVENT_CREATE"; eventName: string }
  | { kind: "RETENTION_14M" }
  | { kind: "ENHANCED_MEASUREMENT" }
  | { kind: "CHANNEL_GROUP_AI" }
  | { kind: "ANNOTATION_CREATE"; title: string; day: string };

// Yazmadan önce ve sonra okunan durumun küçük özeti; yalnız GaConfigChange
// satırında durur, bağlantı silinince birlikte silinir.
export type GaFixSnapshot =
  | {
      kind: "KEY_EVENT_CREATE";
      exists: boolean;
      resourceName: string | null;
      deletable: boolean | null;
    }
  | { kind: "RETENTION_14M"; eventDataRetention: string | null }
  | {
      kind: "ENHANCED_MEASUREMENT";
      streamId: string;
      streamEnabled: boolean;
      scrollsEnabled: boolean;
      outboundClicksEnabled: boolean;
      siteSearchEnabled: boolean;
      fileDownloadsEnabled: boolean;
      searchQueryParameter: string | null;
    }
  | { kind: "CHANNEL_GROUP_AI"; exists: boolean; resourceName: string | null }
  | { kind: "ANNOTATION_CREATE"; exists: boolean; resourceName: string | null };

export const GA_FIX_ERROR_CODES = [
  "not_enabled",
  "no_edit_access",
  "scope_missing",
  "reconnect",
  "no_property_access",
  "property_changed",
  "no_stream",
  "limit_reached",
  "readback_mismatch",
  "google_unavailable",
  "google_changed",
  "rate_limited",
  "rejected_by_google",
  "cannot_undo",
  "approval_missing",
  "unknown",
] as const;
export type GaFixErrorCode = (typeof GA_FIX_ERROR_CODES)[number];

export type GaFixError = {
  code: GaFixErrorCode;
  message: string;
  retryable?: boolean;
  undo?: boolean;
};

export type GaFixRefusal =
  | "not_enabled"
  | "alpha_off"
  | "no_link"
  | "no_edit_access"
  | "invalid"
  | "limit_reached"
  | "already_satisfied"
  | "no_stream"
  | "not_allowed_here";

// Planlama ve doğrulama sözleşmesi (plan.ts / readback.ts): canlı okuma,
// yazma ve geri alma işlemleri.
export type GaFixCurrent =
  | { kind: "KEY_EVENT_CREATE"; keyEvents: GaKeyEventResource[]; limit: number }
  | { kind: "RETENTION_14M"; retention: GaRetentionResource }
  | {
      kind: "ENHANCED_MEASUREMENT";
      streamId: string;
      settings: GaEnhancedMeasurementResource;
    }
  | { kind: "CHANNEL_GROUP_AI"; groups: GaChannelGroupResource[] }
  | { kind: "ANNOTATION_CREATE"; annotations: GaAnnotationResource[] };

export type GaFixWrite =
  | { op: "createKeyEvent"; eventName: string }
  | { op: "updateRetention"; value: "FOURTEEN_MONTHS" }
  | {
      op: "updateEnhanced";
      streamId: string;
      patch: GaEnhancedMeasurementPatch;
    }
  | { op: "createChannelGroup"; body: GaChannelGroupCreate }
  | { op: "createAnnotation"; input: GaAnnotationCreate };

export type GaFixPlan =
  | { kind: "noop"; snapshot: GaFixSnapshot }
  | { kind: "write"; before: GaFixSnapshot; write: GaFixWrite }
  | { kind: "refuse"; code: "limit_reached" };

export type GaFixUndoOp =
  | { op: "deleteKeyEvent"; resourceName: string }
  | { op: "restoreRetention"; value: string }
  | {
      op: "restoreEnhanced";
      streamId: string;
      patch: GaEnhancedMeasurementPatch;
    }
  | { op: "deleteChannelGroup"; resourceName: string }
  | { op: "deleteAnnotation"; resourceName: string };
