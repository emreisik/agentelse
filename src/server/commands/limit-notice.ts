import "server-only";

import { isAgentelseError } from "@/server/security/errors";
import type { IdeaEventCardData } from "@/types/idea-event-card";

// Maps a failed reasoning call to the chat's limit-notice card, covering
// every "the assistant couldn't reply" cause that has a user-facing story:
// daily caps/budget (fixable in autonomy settings), a missing provider key,
// provider rate limiting, and provider timeouts. Anything else returns null
// and keeps the legacy fallback behavior in chat-service.

export type LimitNoticeCard = Extract<
  IdeaEventCardData,
  { kind: "limit-notice" }
>;

// AutonomyPolicyRepository.checkAndIncrement puts the cap's field name into
// AgentelseError.meta.limit — translated here into the card's reason.
const CAP_FIELD_TO_REASON: Record<string, LimitNoticeCard["reason"]> = {
  dailyBudgetUsd: "daily-budget",
  maxReasoningCallsPerDay: "daily-reasoning",
  maxTasksPerDay: "daily-tasks",
  maxOpenOpportunities: "open-opportunities",
  maxActiveIdeas: "active-ideas",
};

export function limitNoticeFromError(error: unknown): LimitNoticeCard | null {
  if (!isAgentelseError(error)) return null;

  if (error.code === "BUDGET_EXCEEDED") {
    const meta = (error.meta ?? {}) as {
      limit?: string;
      cap?: unknown;
      used?: unknown;
      unit?: unknown;
      resetsAt?: unknown;
      heldBack?: unknown;
    };
    // Plan allowance seen through an engine call (billing/quota-errors.ts
    // asBudgetStop): the client's plan, not the project's daily counters.
    if (meta.limit === "planAllowance") {
      return {
        kind: "limit-notice",
        reason: meta.heldBack === true ? "held-back" : "allowance-used",
        ...(meta.unit === "IMAGE" || meta.unit === "AI_MICROS"
          ? { unit: meta.unit }
          : {}),
        ...(typeof meta.resetsAt === "string" ? { resetsAt: meta.resetsAt } : {}),
      };
    }
    if (meta.limit === "noPlan") {
      return { kind: "limit-notice", reason: "no-plan" };
    }
    return {
      kind: "limit-notice",
      // A BUDGET_EXCEEDED without a recognizable meta.limit still gets the
      // generic daily-reasoning story — chat's own calls are metered on
      // that counter, so it's the safest default.
      reason: CAP_FIELD_TO_REASON[meta.limit ?? ""] ?? "daily-reasoning",
      cap: typeof meta.cap === "number" ? meta.cap : undefined,
      used: typeof meta.used === "number" ? meta.used : undefined,
    };
  }
  if (error.code === "QUOTA_EXCEEDED") {
    const meta = (error.meta ?? {}) as {
      unit?: unknown;
      resetsAt?: unknown;
      heldBack?: unknown;
    };
    return {
      kind: "limit-notice",
      reason: meta.heldBack === true ? "held-back" : "allowance-used",
      ...(meta.unit === "IMAGE" || meta.unit === "AI_MICROS"
        ? { unit: meta.unit }
        : {}),
      ...(typeof meta.resetsAt === "string" ? { resetsAt: meta.resetsAt } : {}),
    };
  }
  if (error.code === "NO_PLAN") {
    return { kind: "limit-notice", reason: "no-plan" };
  }
  if (error.code === "PROVIDER_UNAVAILABLE") {
    return { kind: "limit-notice", reason: "provider-unconfigured" };
  }
  if (error.code === "PROVIDER_RATE_LIMITED") {
    return { kind: "limit-notice", reason: "provider-rate-limited" };
  }
  if (error.code === "TIMEOUT") {
    return { kind: "limit-notice", reason: "provider-timeout" };
  }
  return null;
}

// Plain-text twin of the card, stored as Command.replyText — the LLM's
// history context (buildContext) and any surface that shows text instead of
// the card read this.
export function limitNoticeReplyText(card: LimitNoticeCard): string {
  switch (card.reason) {
    case "daily-budget":
      return "Today's AI budget for this project is used up, so I can't reply right now. It resets at midnight (UTC); you can also raise it in autonomy settings.";
    case "daily-reasoning":
      return "This project's daily AI call limit is used up, so I can't reply right now. It resets at midnight (UTC); you can also raise it in autonomy settings.";
    case "daily-tasks":
      return "Today's new-task limit is full, so this request can't be queued right now. It resets at midnight (UTC); you can also raise it in autonomy settings.";
    case "open-opportunities":
      return "The open-opportunities cap is full. Close some opportunities or raise the cap in autonomy settings.";
    case "active-ideas":
      return "The active-ideas cap is full. Archive some ideas or raise the cap in autonomy settings.";
    case "provider-unconfigured":
      return "No AI provider is configured on the server, so I can't generate replies. This needs a deployment-side fix (an API key).";
    case "provider-rate-limited":
      return "The AI provider is temporarily rate-limiting requests. Please try again in a minute.";
    case "provider-timeout":
      return "The AI provider took too long to respond. Please send the message again.";
    case "allowance-used":
      return allowanceUsedText(card);
    case "held-back":
      return heldBackText(card);
    case "no-plan":
      return "This workspace has no active plan, so I can't start new work right now. Your existing content stays available.";
  }
}

// "image credits" / "AI allowance" and, when known, the renewal date. Never a
// token or dollar figure: the client sees what they can do, not what it costs.
function allowanceUsedText(card: LimitNoticeCard): string {
  const what =
    card.unit === "IMAGE"
      ? "image credits"
      : card.unit === "AI_MICROS"
        ? "AI allowance"
        : "plan allowance";
  const when = renewalSuffix(card.resetsAt);
  return `This period's ${what} ${card.unit === "IMAGE" ? "are" : "is"} used up${when}. Work in progress is paused and continues by itself when the allowance renews or more is added.`;
}

// Automatic work reached its own share; what the user starts is not touched. A
// percentage, never a token or dollar figure.
function heldBackText(card: LimitNoticeCard): string {
  const share = card.sharePct
    ? `${card.sharePct}% of your plan`
    : "a share of your plan";
  return `Waiting: automatic work is limited to ${share}, so this has to wait. Your own requests are not affected, and it continues by itself when the allowance renews or more is added.`;
}

function renewalSuffix(resetsAt: string | undefined): string {
  if (!resetsAt) return "";
  const date = new Date(resetsAt);
  if (Number.isNaN(date.getTime())) return "";
  const label = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return `; it renews on ${label}`;
}
