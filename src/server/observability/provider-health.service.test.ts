import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/server/execution/provider-registry", () => ({
  ProviderRegistry: { registered: () => [] },
}));

const { decayStatus, failureDegrades } = await import(
  "./provider-health.service"
);

describe("decayStatus", () => {
  it("lets a locked AUTH_REQUIRED provider be retried once the window is empty and it is configured", () => {
    expect(
      decayStatus("AUTH_REQUIRED", { jobsInWindow: 0, configured: true }),
    ).toBe("AVAILABLE");
  });

  it("keeps AUTH_REQUIRED while there is recent evidence or the provider is unconfigured", () => {
    expect(
      decayStatus("AUTH_REQUIRED", { jobsInWindow: 2, configured: true }),
    ).toBe("AUTH_REQUIRED");
    expect(
      decayStatus("AUTH_REQUIRED", { jobsInWindow: 0, configured: false }),
    ).toBe("AUTH_REQUIRED");
  });

  it("never decays a deliberately DISABLED provider", () => {
    expect(
      decayStatus("DISABLED", { jobsInWindow: 0, configured: true }),
    ).toBe("DISABLED");
  });

  it("keeps decaying the transient states exactly as before", () => {
    for (const status of ["UNAVAILABLE", "DEGRADED", "RATE_LIMITED"] as const) {
      expect(decayStatus(status)).toBe("AVAILABLE");
    }
    expect(decayStatus(undefined)).toBe("AVAILABLE");
  });

  it("without context, never unlocks AUTH_REQUIRED (safe default)", () => {
    expect(decayStatus("AUTH_REQUIRED")).toBe("AUTH_REQUIRED");
  });
});

// A client running out of its plan allowance is that client's state, never the
// provider's: it must not close the provider for everybody, whatever its message
// happens to say.
describe("failureDegrades: plan allowance", () => {
  it.each(["QUOTA_EXCEEDED", "NO_PLAN", "BILLING_UNAVAILABLE"])(
    "never degrades the provider for %s, even if the message reads like a billing failure",
    (errorCode) => {
      expect(
        failureDegrades({
          errorCode,
          errorMessage: "billing: insufficient quota exceeded",
        }),
      ).toBe(false);
    },
  );

  it("still degrades it for a genuine provider billing failure", () => {
    expect(
      failureDegrades({
        errorCode: null,
        errorMessage: "OpenAI 429: insufficient_quota",
      }),
    ).toBe(true);
  });
});
