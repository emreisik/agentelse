import { describe, expect, it } from "vitest";

import { tokenHealthFrom, tokenWarningDays } from "@/lib/ads/token-health";

const NOW = new Date("2026-10-06T12:00:00Z");
const inDays = (days: number) => Math.floor(NOW.getTime() / 1000 + days * 86_400);

describe("tokenHealthFrom (F1)", () => {
  it("reports expiry, data-access expiry, missing scopes and the granted ad accounts", () => {
    const health = tokenHealthFrom({
      inspection: {
        isValid: true,
        expiresAt: inDays(20),
        dataAccessExpiresAt: inDays(80),
        granularScopes: [{ scope: "ads_management", target_ids: ["111", "222"] }],
      },
      granted: ["ads_read", "business_management"],
      required: ["ads_management", "ads_read", "business_management"],
      now: NOW,
    });
    expect(health).toMatchObject({
      isValid: true,
      missingScopes: ["ads_management"],
      adAccountTargets: ["act_111", "act_222"],
    });
    expect(health.expiresAt).toBe(new Date(inDays(20) * 1000).toISOString());
  });
});

describe("tokenWarningDays", () => {
  const health = (days: number) => ({
    isValid: true,
    expiresAt: new Date(NOW.getTime() + days * 86_400_000).toISOString(),
  });

  it("warns at 14, 7 and 1 days left", () => {
    expect(tokenWarningDays(health(30), NOW)).toBeNull();
    expect(tokenWarningDays(health(10), NOW)).toBe(14);
    expect(tokenWarningDays(health(5), NOW)).toBe(7);
    expect(tokenWarningDays(health(0.5), NOW)).toBe(1);
  });

  it("is due at once for an invalid or expired token", () => {
    expect(tokenWarningDays({ isValid: false }, NOW)).toBe(0);
    expect(tokenWarningDays(health(-1), NOW)).toBe(0);
  });
});
