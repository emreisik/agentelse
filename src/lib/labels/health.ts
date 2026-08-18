import {
  AlertTriangle,
  Ban,
  CircleSlash,
  Clock,
  CreditCard,
  KeyRound,
  Plug,
  ShieldAlert,
  Settings2,
  Timer,
  Wifi,
} from "lucide-react";

import type { EnumMeta } from "./types";

// English labels for error categories (src/server/observability/error-classifier.ts)
// and ProviderHealthStatus. Tones convey urgency: danger = needs
// intervention, waiting = may resolve on its own.
export const ERROR_CATEGORY: Record<string, EnumMeta> = {
  BILLING: { label: "Billing / Quota", tone: "danger", icon: CreditCard },
  AUTH: { label: "Authentication", tone: "danger", icon: KeyRound },
  RATE_LIMIT: { label: "Rate Limit", tone: "waiting", icon: Timer },
  TIMEOUT: { label: "Timeout", tone: "waiting", icon: Clock },
  NETWORK: { label: "Network", tone: "waiting", icon: Wifi },
  PROVIDER_UNAVAILABLE: {
    label: "Provider Unavailable",
    tone: "danger",
    icon: Plug,
  },
  CONFIGURATION: { label: "Configuration", tone: "danger", icon: Settings2 },
  INVALID_RESULT: {
    label: "Invalid Result",
    tone: "waiting",
    icon: CircleSlash,
  },
  REFUSED: { label: "Refused", tone: "special", icon: ShieldAlert },
  UNKNOWN: { label: "Unknown", tone: "neutral", icon: AlertTriangle },
};

export const RECOVERY_STRATEGY: Record<string, EnumMeta> = {
  RETRY: { label: "Retried automatically", tone: "positive" },
  RETRY_AFTER_COOLDOWN: {
    label: "Retried after cooldown",
    tone: "waiting",
  },
  NEEDS_CONFIG: { label: "Needs configuration", tone: "danger" },
  NEEDS_HUMAN: { label: "Needs human review", tone: "special" },
};

export const PROVIDER_HEALTH_STATUS: Record<string, EnumMeta> = {
  AVAILABLE: { label: "Healthy", tone: "positive" },
  DEGRADED: { label: "Degraded", tone: "waiting" },
  RATE_LIMITED: { label: "Rate Limited", tone: "waiting" },
  AUTH_REQUIRED: { label: "Authorization Required", tone: "danger" },
  UNAVAILABLE: { label: "Unavailable", tone: "danger", icon: Ban },
  DISABLED: { label: "Disabled", tone: "neutral" },
};
