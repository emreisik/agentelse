import { describe, expect, it } from "vitest";

import { classifyError } from "@/server/observability/error-classifier";
import { AgentelseError } from "@/server/security/errors";

import {
  NoPlanError,
  QuotaExceededError,
  asBudgetStop,
  isAllowanceStop,
  isQuotaError,
} from "./quota-errors";

const quota = () =>
  new QuotaExceededError({
    unit: "AI_MICROS",
    needed: 502_000,
    available: 403_000,
    resetsAt: new Date("2026-11-01T00:00:00.000Z"),
  });

// The refusal of the system's own work that ran into its share of the plan.
const heldBack = () =>
  new QuotaExceededError({
    unit: "IMAGE",
    needed: 1,
    available: 3,
    resetsAt: null,
    heldBack: true,
  });

describe("quota errors", () => {
  it("carry a stable code and structured detail", () => {
    const error = quota();
    expect(error.code).toBe("QUOTA_EXCEEDED");
    expect(error.retryable).toBe(false);
    expect(error.meta).toMatchObject({
      unit: "AI_MICROS",
      needed: 502_000,
      available: 403_000,
      resetsAt: "2026-11-01T00:00:00.000Z",
    });
    expect(new NoPlanError("NO_SUBSCRIPTION").code).toBe("NO_PLAN");
  });

  it("say when the allowance was a free trial's, and only then (it does not renew)", () => {
    expect(quota().meta).not.toHaveProperty("trial");
    const error = new QuotaExceededError({
      unit: "IMAGE",
      needed: 1,
      available: 0,
      resetsAt: new Date("2026-11-01T00:00:00.000Z"),
      trial: true,
    });
    expect(error.meta).toMatchObject({ trial: true });
    // The engine's budget stop keeps the flag for the surfaces that explain it.
    expect(asBudgetStop(error).meta).toMatchObject({
      limit: "planAllowance",
      trial: true,
    });
  });

  it("say when the system's own work ran into its share, and only then", () => {
    expect(quota().meta).not.toHaveProperty("heldBack");
    const error = heldBack();
    expect(error.code).toBe("QUOTA_EXCEEDED");
    expect(error.meta).toMatchObject({ heldBack: true, available: 3 });
    // The message does not claim the allowance ran out.
    expect(error.message).not.toMatch(/used up/i);
    // The engine's budget stop keeps the flag for its consumers.
    expect(asBudgetStop(error).meta).toMatchObject({
      limit: "planAllowance",
      heldBack: true,
    });
  });

  it("are recognised by code, not class identity", () => {
    expect(isQuotaError(quota())).toBe(true);
    expect(isQuotaError(new NoPlanError("UNIT_NOT_SOLD"))).toBe(true);
    expect(isQuotaError(new AgentelseError("QUOTA_EXCEEDED", "x"))).toBe(true);
    expect(isQuotaError(new AgentelseError("BUDGET_EXCEEDED", "x"))).toBe(false);
    expect(isQuotaError(new Error("x"))).toBe(false);
    expect(isQuotaError(null)).toBe(false);
  });

  // error-classifier matches free text. A tenant running out of allowance must
  // never read as a provider-level billing/auth/network failure, or the
  // provider circuit breaker would close it for everybody.
  it("never read as a provider failure to the error classifier", () => {
    for (const error of [
      quota(),
      heldBack(),
      new NoPlanError("NO_SUBSCRIPTION"),
      new NoPlanError("UNIT_NOT_SOLD"),
    ]) {
      const classification = classifyError(error.message);
      expect(classification.category).toBe("UNKNOWN");
      expect(classification.degradesProvider).toBe(false);
    }
  });
});

// A plan-allowance stop looks like a daily-cap stop to every engine consumer (the
// same BUDGET_EXCEEDED code), but it does not reopen tomorrow: best-effort paths
// that "carry on anyway" must be able to tell the two apart.
describe("isAllowanceStop", () => {
  it("is true for the plan-allowance and no-plan stops engine callers receive", () => {
    expect(isAllowanceStop(asBudgetStop(quota()))).toBe(true);
    expect(isAllowanceStop(asBudgetStop(new NoPlanError("NO_SUBSCRIPTION")))).toBe(
      true,
    );
    expect(isAllowanceStop(asBudgetStop(new NoPlanError("UNIT_NOT_SOLD")))).toBe(
      true,
    );
  });

  it("is false for the project's daily caps and the per-task ceiling", () => {
    for (const limit of ["reasoningCalls", "dailyBudgetUsd", "taskCeiling"]) {
      expect(
        isAllowanceStop(
          new AgentelseError("BUDGET_EXCEEDED", "x", { meta: { limit } }),
        ),
      ).toBe(false);
    }
    expect(isAllowanceStop(new AgentelseError("BUDGET_EXCEEDED", "x"))).toBe(
      false,
    );
  });

  it("is false for anything that is not a budget stop", () => {
    expect(isAllowanceStop(quota())).toBe(false);
    expect(isAllowanceStop(new Error("x"))).toBe(false);
    expect(isAllowanceStop(null)).toBe(false);
    expect(isAllowanceStop(undefined)).toBe(false);
    expect(
      isAllowanceStop(
        new AgentelseError("PERMISSION_DENIED", "x", {
          meta: { limit: "planAllowance" },
        }),
      ),
    ).toBe(false);
  });
});
