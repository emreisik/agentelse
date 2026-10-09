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
      "allowance-used",
      "no-plan",
    ] as const;
    for (const reason of reasons) {
      expect(
        limitNoticeReplyText({ kind: "limit-notice", reason }).length,
      ).toBeGreaterThan(20);
    }
  });

  // Plan allowance (Faz 3): the client is told what they can do next, in
  // credits and a date, never in tokens or dollars.
  describe("plan allowance", () => {
    const quota = (meta: Record<string, unknown>) =>
      new AgentelseError("QUOTA_EXCEEDED", "used up", { meta });

    it("maps QUOTA_EXCEEDED to the allowance card with the unit and renewal", () => {
      expect(
        limitNoticeFromError(
          quota({
            unit: "IMAGE",
            needed: 1,
            available: 0,
            resetsAt: "2026-11-01T00:00:00.000Z",
          }),
        ),
      ).toEqual({
        kind: "limit-notice",
        reason: "allowance-used",
        unit: "IMAGE",
        resetsAt: "2026-11-01T00:00:00.000Z",
      });
    });

    it("keeps working when the error carries no usable meta", () => {
      expect(limitNoticeFromError(quota({ unit: "VIDEO", resetsAt: 5 }))).toEqual(
        { kind: "limit-notice", reason: "allowance-used" },
      );
    });

    it("maps NO_PLAN to its own card", () => {
      expect(
        limitNoticeFromError(new AgentelseError("NO_PLAN", "no plan")),
      ).toEqual({ kind: "limit-notice", reason: "no-plan" });
    });

    it("words the reply per unit and shows the renewal date, never a number", () => {
      const images = limitNoticeReplyText({
        kind: "limit-notice",
        reason: "allowance-used",
        unit: "IMAGE",
        resetsAt: "2026-11-01T00:00:00.000Z",
      });
      expect(images).toContain("image credits are used up");
      expect(images).toContain("renews on Nov 1");
      const ai = limitNoticeReplyText({
        kind: "limit-notice",
        reason: "allowance-used",
        unit: "AI_MICROS",
      });
      expect(ai).toContain("AI allowance is used up");
      expect(ai).not.toContain("renews on");
      expect(ai).not.toMatch(/\$|token|micro/i);
    });
  });
});
