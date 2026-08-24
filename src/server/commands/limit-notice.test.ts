import { describe, expect, it } from "vitest";

import {
  limitNoticeFromError,
  limitNoticeReplyText,
} from "@/server/commands/limit-notice";
import { AgentelseError } from "@/server/security/errors";

describe("limitNoticeFromError", () => {
  it("maps a budget cap hit with its meta into the daily-budget card", () => {
    const error = new AgentelseError("BUDGET_EXCEEDED", "budget", {
      meta: { limit: "dailyBudgetUsd", cap: 5, used: 5.12 },
    });
    expect(limitNoticeFromError(error)).toEqual({
      kind: "limit-notice",
      reason: "daily-budget",
      cap: 5,
      used: 5.12,
    });
  });

  it("maps every counter cap field to its own reason", () => {
    const cases: Array<[string, string]> = [
      ["maxReasoningCallsPerDay", "daily-reasoning"],
      ["maxTasksPerDay", "daily-tasks"],
      ["maxOpenOpportunities", "open-opportunities"],
      ["maxActiveIdeas", "active-ideas"],
    ];
    for (const [limit, reason] of cases) {
      const error = new AgentelseError("BUDGET_EXCEEDED", "cap", {
        meta: { limit, cap: 10, used: 10 },
      });
      expect(limitNoticeFromError(error)?.reason).toBe(reason);
    }
  });

  it("falls back to daily-reasoning when BUDGET_EXCEEDED has no usable meta", () => {
    const error = new AgentelseError("BUDGET_EXCEEDED", "legacy throw");
    expect(limitNoticeFromError(error)).toEqual({
      kind: "limit-notice",
      reason: "daily-reasoning",
      cap: undefined,
      used: undefined,
    });
  });

  it("maps provider error codes to their notice reasons", () => {
    expect(
      limitNoticeFromError(new AgentelseError("PROVIDER_UNAVAILABLE", "x"))
        ?.reason,
    ).toBe("provider-unconfigured");
    expect(
      limitNoticeFromError(new AgentelseError("PROVIDER_RATE_LIMITED", "x"))
        ?.reason,
    ).toBe("provider-rate-limited");
    expect(
      limitNoticeFromError(new AgentelseError("TIMEOUT", "x"))?.reason,
    ).toBe("provider-timeout");
  });

  it("returns null for errors that keep the legacy fallback path", () => {
    expect(
      limitNoticeFromError(new AgentelseError("INVALID_PROVIDER_RESULT", "x")),
    ).toBeNull();
    expect(limitNoticeFromError(new Error("plain"))).toBeNull();
    expect(limitNoticeFromError("string")).toBeNull();
  });

  it("produces a reply text for every reason", () => {
    const reasons = [
      "daily-budget",
      "daily-reasoning",
      "daily-tasks",
      "open-opportunities",
      "active-ideas",
      "provider-unconfigured",
      "provider-rate-limited",
      "provider-timeout",
    ] as const;
    for (const reason of reasons) {
      expect(
        limitNoticeReplyText({ kind: "limit-notice", reason }).length,
      ).toBeGreaterThan(20);
    }
  });
});
