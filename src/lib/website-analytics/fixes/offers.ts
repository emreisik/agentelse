import type {
  GaCheckEvidence,
  GaCheckKey,
  GaCheckStatus,
} from "@/lib/website-analytics/health/types";
import { GA_FIX_FOR_CHECK, gaFixIsAlpha } from "./catalog";
import { OPEN_FIX_STATUSES } from "./lifecycle";
import type { GaFixKind, GaFixStatus } from "./types";
import { isValidEventName } from "./validate";
import type { GaFixOffer } from "./view-types";

export type { GaFixOffer } from "./view-types";
export { GA_FIX_FOR_CHECK } from "./catalog";

// GA-F7 öneri hesabı: ölçüm sağlığı kontrollerinden ve mülk durumundan hangi
// 'Fix it for me' düğmelerinin gösterileceği. Saf; sıra kontrol sırasıdır,
// ardından bağımsız öneriler.

export const GA_FIX_BUTTON_LABEL = "Fix it for me (needs approval)" as const;
export const GA_KEY_EVENT_DEFAULTS: readonly string[] = [
  "generate_lead",
  "click_to_call",
  "whatsapp_click",
  "email_click",
  "purchase",
];
export const GA_KEY_EVENT_OPTIONS_MAX = 6;

type OfferCheck = {
  key: GaCheckKey;
  status: GaCheckStatus;
  evidence: GaCheckEvidence;
};

export type ComputeFixOffersInput = {
  enabled: boolean;
  alphaEnabled: boolean;
  editGranted: boolean;
  checks: OfferCheck[];
  link: {
    keyEventNames: string[] | null;
    dataRetention: string | null;
    streamId: string | null;
    serviceLevel: string | null;
  };
  changes: {
    id: string;
    kind: GaFixKind;
    status: GaFixStatus;
    dedupeKey: string;
    noop: boolean;
  }[];
};

const COPY: Record<
  GaFixKind,
  { title: string; description: string }
> = {
  KEY_EVENT_CREATE: {
    title: "Set up a key event",
    description:
      "Agentelse marks the action that matters most on your site as a key event in Google Analytics, after you approve it.",
  },
  RETENTION_14M: {
    title: "Keep event data for 14 months",
    description:
      "Agentelse switches event-level data retention to 14 months in Google Analytics, after you approve it.",
  },
  ENHANCED_MEASUREMENT: {
    title: "Turn on enhanced measurement",
    description:
      "Agentelse turns on the enhanced-measurement items that are currently off, after you approve it. Form interactions are not touched.",
  },
  CHANNEL_GROUP_AI: {
    title: "Track visits from AI assistants",
    description:
      "Agentelse adds an AI assistants channel group so these visits show up in their own channel, after you approve it.",
  },
  ANNOTATION_CREATE: {
    title: "Add a note to Google Analytics",
    description: "Adds a dated note to your reports, after you approve it.",
  },
};

function suggestionsOf(evidence: GaCheckEvidence): string[] {
  const value = evidence.suggestions;
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function keyEventOptions(
  evidence: GaCheckEvidence,
  existing: readonly string[],
): { value: string; label: string }[] {
  const taken = new Set(existing);
  const seen = new Set<string>();
  const options: { value: string; label: string }[] = [];
  for (const name of [...suggestionsOf(evidence), ...GA_KEY_EVENT_DEFAULTS]) {
    if (options.length >= GA_KEY_EVENT_OPTIONS_MAX) break;
    if (!isValidEventName(name)) continue;
    if (taken.has(name) || seen.has(name)) continue;
    seen.add(name);
    options.push({ value: name, label: name });
  }
  return options;
}

function wantsFix(kind: GaFixKind, check: OfferCheck, hasStream: boolean): boolean {
  const bad = check.status === "WARN" || check.status === "FAIL";
  if (!bad) return false;
  const reason = check.evidence.reason;
  if (kind === "KEY_EVENT_CREATE") {
    return reason === "no_key_events" || reason === "only_purchase";
  }
  if (kind === "RETENTION_14M") return reason === "two_months";
  if (kind === "ENHANCED_MEASUREMENT") {
    return reason === "enhanced_off" && hasStream;
  }
  return false;
}

export function computeFixOffers(input: ComputeFixOffersInput): GaFixOffer[] {
  if (!input.enabled) return [];
  const offers: GaFixOffer[] = [];
  const used = new Set<GaFixKind>();

  const stateFor = (
    kind: GaFixKind,
  ): { state: GaFixOffer["state"]; changeId: string | null } => {
    const open = input.changes.find(
      (change) =>
        change.kind === kind && OPEN_FIX_STATUSES.includes(change.status),
    );
    if (open) return { state: "pending", changeId: open.id };
    if (kind === "CHANNEL_GROUP_AI") {
      const done = input.changes.find(
        (change) =>
          change.kind === kind && change.status === "VERIFIED" && !change.noop,
      );
      if (done) return { state: "done", changeId: done.id };
    }
    return {
      state: input.editGranted ? "available" : "needs_access",
      changeId: null,
    };
  };

  const push = (
    kind: GaFixKind,
    checkKey: GaCheckKey | null,
    field: GaFixOffer["field"],
  ) => {
    if (used.has(kind)) return;
    if (gaFixIsAlpha(kind) && !input.alphaEnabled) return;
    used.add(kind);
    const { state, changeId } = stateFor(kind);
    offers.push({
      id: `offer:${kind}`,
      kind,
      checkKey,
      title: COPY[kind].title,
      description: COPY[kind].description,
      buttonLabel: GA_FIX_BUTTON_LABEL,
      field,
      state,
      changeId,
    });
  };

  const hasStream = Boolean(input.link.streamId);
  for (const check of input.checks) {
    const kind = GA_FIX_FOR_CHECK[check.key];
    if (!kind) continue;
    if (!wantsFix(kind, check, hasStream)) continue;
    if (kind === "KEY_EVENT_CREATE") {
      const options = keyEventOptions(
        check.evidence,
        input.link.keyEventNames ?? [],
      );
      if (options.length === 0) continue;
      push(kind, check.key, {
        name: "eventName",
        label: "Key event",
        options,
      });
    } else {
      push(kind, check.key, null);
    }
  }

  // Bağımsız öneri: kanal grubu bir kontrole bağlı değildir.
  push("CHANNEL_GROUP_AI", null, null);
  return offers;
}
