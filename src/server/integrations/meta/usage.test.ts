import { describe, expect, it } from "vitest";

import { blockedUntilAfter, laneDecision, usageFromHeaders } from "./usage";

const NOW = new Date("2026-10-06T12:00:00Z");
const headers = (values: Record<string, unknown>) => ({
  get: (name: string) =>
    name in values ? JSON.stringify(values[name]) : null,
});

describe("usageFromHeaders (docs/meta-ads-plan.md §3.1)", () => {
  it("takes the highest of account, business-use-case and insights usage", () => {
    const usage = usageFromHeaders(
      headers({
        "x-ad-account-usage": {
          acc_id_util_pct: 12,
          reset_time_duration: 0,
          ads_api_access_tier: "development_access",
        },
        "x-business-use-case-usage": {
          "123": [
            {
              type: "ads_management",
              call_count: 40,
              total_cputime: 81,
              total_time: 10,
              estimated_time_to_regain_access: 0,
            },
          ],
        },
        "x-fb-ads-insights-throttle": { app_id_util_pct: 3, acc_id_util_pct: 5 },
      }),
      NOW,
    );
    expect(usage).toMatchObject({ pct: 81, tier: "development_access" });
  });

  it("turns Meta's minutes-to-regain into seconds", () => {
    const usage = usageFromHeaders(
      headers({
        "x-business-use-case-usage": {
          "1": [{ call_count: 100, estimated_time_to_regain_access: 5 }],
        },
      }),
      NOW,
    );
    expect(usage?.regainSeconds).toBe(300);
  });

  it("returns nothing without usage headers", () => {
    expect(usageFromHeaders(headers({}), NOW)).toBeNull();
  });
});

describe("laneDecision", () => {
  const usage = (pct: number) => ({ pct, at: NOW.toISOString() });

  it("background waits at 75%, user work at 90%, safety only for Meta's block", () => {
    expect(
      laneDecision({ lane: "P2_BACKGROUND", usage: usage(80), blockedUntil: null, now: NOW }).allow,
    ).toBe(false);
    expect(
      laneDecision({ lane: "P1_USER", usage: usage(80), blockedUntil: null, now: NOW }).allow,
    ).toBe(true);
    expect(
      laneDecision({ lane: "P1_USER", usage: usage(95), blockedUntil: null, now: NOW }).allow,
    ).toBe(false);
    expect(
      laneDecision({ lane: "P0_SAFETY", usage: usage(99), blockedUntil: null, now: NOW }).allow,
    ).toBe(true);
  });

  it("nobody passes Meta's own block, not even a safety pause", () => {
    const blockedUntil = new Date(NOW.getTime() + 60_000);
    expect(
      laneDecision({ lane: "P0_SAFETY", usage: null, blockedUntil, now: NOW }),
    ).toMatchObject({ allow: false, retryAt: blockedUntil });
  });

  it("ignores a usage reading older than 5 minutes", () => {
    const stale = { pct: 99, at: new Date(NOW.getTime() - 6 * 60_000).toISOString() };
    expect(
      laneDecision({ lane: "P2_BACKGROUND", usage: stale, blockedUntil: null, now: NOW }).allow,
    ).toBe(true);
  });
});

describe("blockedUntilAfter", () => {
  const seconds = (date: Date) => (date.getTime() - NOW.getTime()) / 1000;

  it("uses Meta's own estimate when there is one", () => {
    expect(
      seconds(
        blockedUntilAfter({
          code: 17,
          usage: { pct: 100, at: NOW.toISOString(), regainSeconds: 900 },
          now: NOW,
        }),
      ),
    ).toBe(900);
  });

  it("falls back to the tier's block: 300 s in development, 60 s in standard", () => {
    expect(seconds(blockedUntilAfter({ code: 17, usage: null, now: NOW }))).toBe(300);
    expect(
      seconds(
        blockedUntilAfter({
          code: 17,
          usage: { pct: 100, at: NOW.toISOString(), tier: "standard_access" },
          now: NOW,
        }),
      ),
    ).toBe(60);
  });

  it("an hour for the abuse limit and the budget-change limit", () => {
    expect(seconds(blockedUntilAfter({ code: 613, usage: null, now: NOW }))).toBe(3600);
    expect(
      seconds(blockedUntilAfter({ code: 613, subcode: 1487632, usage: null, now: NOW })),
    ).toBe(3600);
  });
});
