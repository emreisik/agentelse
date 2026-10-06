import { describe, expect, it } from "vitest";

import { tokenExpiry } from "@/lib/ads/token-expiry";

const NOW = new Date("2026-10-06T12:00:00Z");
const inDays = (days: number) =>
  new Date(NOW.getTime() + days * 24 * 3600_000).toISOString();

describe("tokenExpiry (F0b)", () => {
  it("counts whole days left", () => {
    expect(tokenExpiry(inDays(12.5), NOW)).toEqual({
      text: "Access expires in 12 days.",
      urgent: false,
    });
  });

  it("is urgent under a week, today and once expired", () => {
    expect(tokenExpiry(inDays(3), NOW)?.urgent).toBe(true);
    expect(tokenExpiry(inDays(0.2), NOW)?.text).toBe(
      "Access expires today. Reconnect now.",
    );
    expect(tokenExpiry(inDays(-1), NOW)).toEqual({
      text: "Access expired. Reconnect to keep managing ads.",
      urgent: true,
    });
  });

  it("says nothing without a stored expiry", () => {
    expect(tokenExpiry(undefined, NOW)).toBeNull();
    expect(tokenExpiry("not a date", NOW)).toBeNull();
  });
});
