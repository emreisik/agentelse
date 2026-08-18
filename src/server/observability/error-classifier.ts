import "server-only";

// Error classification: every error message in the system (provider
// adapters, ReasoningService, outbox worker) is recorded as free text.
// To make an auto-recovery decision, we first need to know WHAT this text
// means — "out of credit" and "network timeout" don't get the same
// intervention.
//
// Classification deliberately relies on text matching: provider SDKs model
// error types differently from each other, and they all eventually collapse
// into a single `errorMessage` string.

export type ErrorCategory =
  | "BILLING" // out of credit/quota — requires payment
  | "AUTH" // invalid/missing key — requires configuration
  | "RATE_LIMIT" // transient, wait and retry
  | "TIMEOUT" // transient, retry
  | "NETWORK" // transient, retry
  | "PROVIDER_UNAVAILABLE" // no provider for this capability — configuration
  | "CONFIGURATION" // missing agent/profile/model setting
  | "INVALID_RESULT" // provider didn't return the expected schema
  | "REFUSED" // model refused the request
  | "UNKNOWN";

export type RecoveryStrategy =
  | "RETRY" // auto re-queue
  | "RETRY_AFTER_COOLDOWN" // retry once the provider has cooled down
  | "NEEDS_CONFIG" // meaningless without human configuration
  | "NEEDS_HUMAN"; // requires a human decision

export type ErrorClassification = {
  category: ErrorCategory;
  strategy: RecoveryStrategy;
  // Should this degrade provider health? Quota/key errors disable the
  // provider; a schema error is just a single job's problem.
  degradesProvider: boolean;
  summary: string;
};

const RULES: Array<{
  category: ErrorCategory;
  patterns: RegExp[];
  strategy: RecoveryStrategy;
  degradesProvider: boolean;
  summary: string;
}> = [
  {
    category: "BILLING",
    patterns: [
      /credit balance is too low/i,
      /insufficient[_ ]quota/i,
      /quota exceeded/i,
      /billing/i,
      /payment required/i,
    ],
    strategy: "NEEDS_CONFIG",
    degradesProvider: true,
    summary:
      "Insufficient provider balance/quota — credit must be added to the account.",
  },
  {
    category: "AUTH",
    patterns: [
      /invalid[_ ]api[_ ]key/i,
      /unauthorized/i,
      /authentication[_ ]error/i,
      /permission denied/i,
      /\b401\b/,
      /\b403\b/,
      /is not configured/i,
    ],
    strategy: "NEEDS_CONFIG",
    degradesProvider: true,
    summary: "Authentication failed — the API key is missing or invalid.",
  },
  {
    category: "RATE_LIMIT",
    patterns: [
      /rate[_ ]limit/i,
      /too many requests/i,
      /\b429\b/,
      /overloaded/i,
    ],
    strategy: "RETRY_AFTER_COOLDOWN",
    degradesProvider: true,
    summary:
      "Rate limit hit — will be retried once the provider has cooled down.",
  },
  {
    category: "TIMEOUT",
    patterns: [/timeout/i, /timed out/i, /\baborted\b/i, /ETIMEDOUT/],
    strategy: "RETRY",
    degradesProvider: false,
    summary: "The operation timed out — it can be retried.",
  },
  {
    category: "NETWORK",
    patterns: [
      /ECONNREFUSED/,
      /ECONNRESET/,
      /ENOTFOUND/,
      /socket hang up/i,
      /fetch failed/i,
      /network/i,
      /\b50[234]\b/,
    ],
    strategy: "RETRY",
    degradesProvider: true,
    summary: "Network/provider unreachable — it can be retried.",
  },
  {
    category: "PROVIDER_UNAVAILABLE",
    patterns: [/no execution provider available/i, /PROVIDER_UNAVAILABLE/],
    strategy: "NEEDS_CONFIG",
    degradesProvider: false,
    summary:
      "No provider is configured for this capability — an integration is required.",
  },
  {
    category: "CONFIGURATION",
    patterns: [
      /unknown agent id/i,
      /no browser profile/i,
      /unknown model/i,
      /model not found/i,
    ],
    strategy: "NEEDS_CONFIG",
    degradesProvider: false,
    summary:
      "Missing/incorrect configuration — agent, profile, or model not found.",
  },
  {
    category: "INVALID_RESULT",
    patterns: [
      /did not return the confirmed schema/i,
      /non-JSON output/i,
      /returned no text/i,
      /INVALID_PROVIDER_RESULT/,
    ],
    strategy: "RETRY",
    degradesProvider: false,
    summary:
      "The provider did not respond in the expected format — it can be retried.",
  },
  {
    category: "REFUSED",
    patterns: [/declined the request/i, /\brefusal\b/i, /safety/i],
    strategy: "NEEDS_HUMAN",
    degradesProvider: false,
    summary:
      "The model refused the request — the brief must be reviewed by a human.",
  },
];

const UNKNOWN: ErrorClassification = {
  category: "UNKNOWN",
  strategy: "NEEDS_HUMAN",
  degradesProvider: false,
  summary: "Unclassifiable error — requires human review.",
};

export function classifyError(
  message: string | null | undefined,
): ErrorClassification {
  if (!message) return UNKNOWN;
  for (const rule of RULES) {
    if (rule.patterns.some((pattern) => pattern.test(message))) {
      return {
        category: rule.category,
        strategy: rule.strategy,
        degradesProvider: rule.degradesProvider,
        summary: rule.summary,
      };
    }
  }
  return UNKNOWN;
}

// Auto-recovery only makes sense for transient errors: retrying a
// configuration or balance issue just produces the same error.
export function isAutoRecoverable(
  classification: ErrorClassification,
): boolean {
  return (
    classification.strategy === "RETRY" ||
    classification.strategy === "RETRY_AFTER_COOLDOWN"
  );
}
