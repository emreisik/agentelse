import { describe, expect, it } from "vitest";

import {
  accountHealthIssues,
  accountWriteGate,
  hasFundingSource,
  healthStatusOf,
} from "./account-health";

const ok = {
  accountStatus: 1,
  disableReason: 0,
  hasFunding: true,
  spendCapMinor: null,
  amountSpentMinor: 1000,
};

describe("accountHealthIssues", () => {
  it("is quiet for a healthy account", () => {
    expect(accountHealthIssues(ok)).toEqual([]);
    expect(healthStatusOf([])).toEqual({ status: "OK", reason: null });
  });

  it("blocks a disabled or unpaid account", () => {
    const disabled = accountHealthIssues({ ...ok, accountStatus: 2 });
    expect(disabled[0]).toMatchObject({ kind: "ACCOUNT_BLOCKED", severity: "CRITICAL" });
    expect(healthStatusOf(disabled).status).toBe("BLOCKED");
    expect(accountHealthIssues({ ...ok, accountStatus: 3 })[0]?.kind).toBe("PAYMENT_ISSUE");
    expect(accountHealthIssues({ ...ok, accountStatus: 9 })[0]?.severity).toBe("WARN");
  });

  it("warns near the spending limit and stops at it", () => {
    expect(
      accountHealthIssues({ ...ok, spendCapMinor: 10_000, amountSpentMinor: 9_100 })[0]?.kind,
    ).toBe("SPEND_CAP_NEAR");
    const reached = accountHealthIssues({ ...ok, spendCapMinor: 10_000, amountSpentMinor: 10_000 });
    expect(reached[0]?.kind).toBe("SPEND_CAP_REACHED");
    expect(healthStatusOf(reached).status).toBe("WARN");
  });

  it("does not guess when funding could not be read", () => {
    expect(accountHealthIssues({ ...ok, hasFunding: null })).toEqual([]);
    expect(accountHealthIssues({ ...ok, hasFunding: false })[0]?.severity).toBe("WARN");
  });
});

describe("accountWriteGate", () => {
  it("stops increases on payment states and everything on closed ones", () => {
    expect(accountWriteGate(1)).toBe("OPEN");
    expect(accountWriteGate(3)).toBe("NO_INCREASE");
    expect(accountWriteGate(2)).toBe("CLOSED");
    expect(accountWriteGate(null)).toBe("OPEN");
  });

  it("recognizes a funding source", () => {
    expect(hasFundingSource({ id: "1", type: 1 })).toBe(true);
    expect(hasFundingSource({})).toBe(false);
    expect(hasFundingSource(undefined)).toBe(false);
  });
});
