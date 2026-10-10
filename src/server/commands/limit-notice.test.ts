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
      "held-back",
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

    it("a free trial's allowance does not renew: the card says so and sends the person to a plan", () => {
      const card = limitNoticeFromError(
        quota({
          unit: "AI_MICROS",
          needed: 1,
          available: 0,
          resetsAt: "2026-11-01T00:00:00.000Z",
          trial: true,
        }),
      );
      expect(card).toEqual({
        kind: "limit-notice",
        reason: "allowance-used",
        unit: "AI_MICROS",
        resetsAt: "2026-11-01T00:00:00.000Z",
        trial: true,
      });

      const text = limitNoticeReplyText(card!);
      expect(text).toContain("free trial");
      expect(text).toContain("Choose a plan in Plan & usage");
      // It does not promise a renewal that will never come.
      expect(text).not.toMatch(/renew/i);
      expect(text).not.toMatch(/\$|token|micro/i);

      // The same through the engine's budget stop (asBudgetStop keeps the flag).
      expect(
        limitNoticeFromError(
          new AgentelseError("BUDGET_EXCEEDED", "used up", {
            meta: {
              limit: "planAllowance",
              unit: "IMAGE",
              resetsAt: "2026-11-01T00:00:00.000Z",
              trial: true,
            },
          }),
        ),
      ).toMatchObject({ reason: "allowance-used", trial: true });
    });

    it("a paid plan's refusal still says when it renews", () => {
      const text = limitNoticeReplyText({
        kind: "limit-notice",
        reason: "allowance-used",
        unit: "IMAGE",
        resetsAt: "2026-11-01T00:00:00.000Z",
      });
      expect(text).toContain("renews on Nov 1");
      expect(text).toContain("You can add more in Plan & usage");
      expect(text).not.toContain("free trial");
    });

    it("keeps working when the error carries no usable meta", () => {
      expect(limitNoticeFromError(quota({ unit: "VIDEO", resetsAt: 5 }))).toEqual(
        { kind: "limit-notice", reason: "allowance-used" },
      );
    });

    // Automatic work that reached its own share of the plan (Faz 3C): the allowance
    // is NOT used up, and the card must not say it is.
    it("maps a held-back refusal to its own card, not to 'used up'", () => {
      expect(
        limitNoticeFromError(
          quota({ unit: "IMAGE", heldBack: true, resetsAt: null }),
        ),
      ).toEqual({ kind: "limit-notice", reason: "held-back", unit: "IMAGE" });
      expect(
        limitNoticeFromError(
          new AgentelseError("BUDGET_EXCEEDED", "share", {
            meta: { limit: "planAllowance", unit: "AI_MICROS", heldBack: true },
          }),
        ),
      ).toEqual({
        kind: "limit-notice",
        reason: "held-back",
        unit: "AI_MICROS",
      });
    });

    it("words the held-back reply with a percentage, for the user's own requests it says nothing is held", () => {
      const text = limitNoticeReplyText({
        kind: "limit-notice",
        reason: "held-back",
        sharePct: 45,
      });
      expect(text).toContain("limited to 45% of your plan");
      expect(text).toContain("Your own requests are not affected");
      expect(text).not.toMatch(/used up|\$|token|micro/i);
      // Without a number it still reads whole.
      expect(
        limitNoticeReplyText({ kind: "limit-notice", reason: "held-back" }),
      ).toContain("limited to a share of your plan");
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
