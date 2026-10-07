import type { GaCheckKey } from "@/lib/website-analytics/health/types";
import type { GaFixKind, GaFixParams } from "./types";

// GA-F7 düzeltme kataloğu: her tür için başlık, etki cümlesi ve onay kartı
// satırları. Hiçbir metinde mülk adı ya da Google'dan gelen sayı bulunmaz:
// bu metinler Task yüküne ve sohbet kartına yazılır ve bağlantı kesilince
// zincirleme silinmez (docs/website-fixes.md).

export type GaFixCatalogEntry = {
  kind: GaFixKind;
  api: "v1beta" | "v1alpha";
  undoable: boolean;
  undoWarning: string | null;
  title(params: GaFixParams): string;
  effect(params: GaFixParams): string;
  approvalRows(params: GaFixParams): { label: string; value: string }[];
};

export const GA_FIX_TITLE_MAX = 80;
export const GA_FIX_PROPERTY_TEXT = "Your Google Analytics property";
export const GA_FIX_EXPIRY_TEXT = "In 7 days if nobody decides";
const ANNOTATION_PREFIX_RE = /^agentelse:\s*/i;

// Ölçüm sağlığı kontrolünden hangi düzeltmenin önerileceği (MH9/MH10 asla).
export const GA_FIX_FOR_CHECK: Partial<Record<GaCheckKey, GaFixKind>> = {
  MH5: "KEY_EVENT_CREATE",
  MH14: "RETENTION_14M",
  MH17: "ENHANCED_MEASUREMENT",
};

function clip(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length <= max ? value : `${chars.slice(0, max - 1).join("")}…`;
}

function rowsFor(entry: {
  undoable: boolean;
  effect: string;
}): { label: string; value: string }[] {
  return [
    { label: "What happens", value: entry.effect },
    { label: "Where", value: GA_FIX_PROPERTY_TEXT },
    {
      label: "Undo",
      value: entry.undoable ? "You can undo it later" : "Cannot be undone",
    },
    { label: "Expires", value: GA_FIX_EXPIRY_TEXT },
  ];
}

function define(
  kind: GaFixKind,
  api: "v1beta" | "v1alpha",
  undoWarning: string | null,
  title: (params: GaFixParams) => string,
  effect: (params: GaFixParams) => string,
): GaFixCatalogEntry {
  const undoable = true;
  return {
    kind,
    api,
    undoable,
    undoWarning,
    title: (params) => clip(title(params), GA_FIX_TITLE_MAX),
    effect,
    approvalRows: (params) => rowsFor({ undoable, effect: effect(params) }),
  };
}

export const GA_FIX_CATALOG: Record<GaFixKind, GaFixCatalogEntry> = {
  KEY_EVENT_CREATE: define(
    "KEY_EVENT_CREATE",
    "v1beta",
    null,
    (params) =>
      params.kind === "KEY_EVENT_CREATE"
        ? `Mark ${params.eventName} as a key event in Google Analytics`
        : "Mark an event as a key event in Google Analytics",
    (params) =>
      params.kind === "KEY_EVENT_CREATE"
        ? `Google Analytics will count ${params.eventName} as a key event. You can remove it again.`
        : "Google Analytics will count this event as a key event. You can remove it again.",
  ),
  RETENTION_14M: define(
    "RETENTION_14M",
    "v1beta",
    "Going back shortens how long Google Analytics keeps event-level data for Explore reports. Older data can be dropped.",
    () => "Keep Google Analytics event data for 14 months",
    () =>
      "Event-level data in Explore reports is kept for 14 months instead of 2. Standard reports are not affected.",
  ),
  ENHANCED_MEASUREMENT: define(
    "ENHANCED_MEASUREMENT",
    "v1alpha",
    null,
    () => "Turn on enhanced measurement in Google Analytics",
    () =>
      "Turns on the enhanced-measurement items that are currently off (scrolls, outbound clicks, site search, file downloads). Items that are already on, and form interactions, are not changed.",
  ),
  CHANNEL_GROUP_AI: define(
    "CHANNEL_GROUP_AI",
    "v1alpha",
    null,
    () => 'Add an "AI assistants" channel group to Google Analytics',
    () =>
      "Adds a custom channel group that puts visits from AI assistants (ChatGPT, Perplexity, Gemini, Claude, Copilot and others) in their own channel. Your default channels are not changed.",
  ),
  ANNOTATION_CREATE: define(
    "ANNOTATION_CREATE",
    "v1alpha",
    null,
    (params) =>
      params.kind === "ANNOTATION_CREATE"
        ? `Add a note to Google Analytics: ${params.title.replace(ANNOTATION_PREFIX_RE, "")}`
        : "Add a note to Google Analytics",
    () => "Adds a dated note to your Google Analytics reports.",
  ),
};

export function gaFixIsAlpha(kind: GaFixKind): boolean {
  return GA_FIX_CATALOG[kind].api === "v1alpha";
}
