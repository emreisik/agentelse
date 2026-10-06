import { describe, expect, it } from "vitest";

import {
  deliveryLabel,
  driftSeverity,
  isDelivering,
  mirrorFieldsFrom,
  shortHash,
  stableStringify,
  trackedChanges,
  trackedHash,
} from "./mirror";

describe("mirrorFieldsFrom", () => {
  it("normalizes an ad set", () => {
    const fields = mirrorFieldsFrom(
      {
        id: "120",
        name: "Leads TR [agx:abc123]",
        campaign_id: "100",
        configured_status: "ACTIVE",
        effective_status: "ACTIVE",
        optimization_goal: "LEAD_GENERATION",
        daily_budget: "5000",
        lifetime_budget: "0",
        budget_remaining: "0",
        end_time: "2026-10-20T00:00:00+0300",
        learning_stage_info: { status: "LEARNING", conversions: 12, last_sig_edit_ts: 1_790_000_000 },
        targeting: { targeting_automation: { advantage_audience: 1 }, geo_locations: { countries: ["TR"] } },
        promoted_object: { page_id: "9", custom_event_type: "LEAD" },
        issues_info: [],
      },
      "ADSET",
    );
    expect(fields).toMatchObject({
      level: "ADSET",
      parentExternalId: "100",
      campaignExternalId: "100",
      dailyBudgetMinor: 5000,
      lifetimeBudgetMinor: null,
      budgetRemainingMinor: 0,
      learningStatus: "LEARNING",
      learningConversions: 12,
      advantageState: "ON",
      customEventType: "LEAD",
      issues: null,
    });
    expect(fields.endTime?.toISOString()).toBe("2026-10-19T21:00:00.000Z");
    expect(fields.targetingHash).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("hashing", () => {
  it("ignores key order", () => {
    expect(stableStringify({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(
      stableStringify({ a: [2, { c: 2, d: 1 }], b: 1 }),
    );
    expect(shortHash("a")).not.toBe(shortHash("b"));
  });

  it("changes only with tracked fields", () => {
    const base = {
      configuredStatus: "ACTIVE",
      dailyBudgetMinor: 1000,
      lifetimeBudgetMinor: null,
      endTime: null,
      spendCapMinor: null,
      bidStrategy: null,
      targetingHash: "x",
      creativeExternalId: null,
    };
    expect(trackedHash(base)).toBe(trackedHash({ ...base }));
    expect(trackedHash(base)).not.toBe(trackedHash({ ...base, dailyBudgetMinor: 2000 }));
  });
});

describe("drift", () => {
  const before = {
    configuredStatus: "PAUSED",
    dailyBudgetMinor: 1000,
    lifetimeBudgetMinor: null,
    endTime: new Date("2026-10-20T00:00:00Z"),
    spendCapMinor: 50_000,
    bidStrategy: null,
    targetingHash: "x",
    creativeExternalId: null,
  };

  it("lists what changed", () => {
    expect(trackedChanges(before, { ...before, dailyBudgetMinor: 3000 })).toEqual([
      { field: "dailyBudgetMinor", from: 1000, to: 3000 },
    ]);
  });

  it("warns when the change goes beyond the plan", () => {
    expect(driftSeverity(trackedChanges(before, { ...before, dailyBudgetMinor: 3000 }))).toBe("WARN");
    expect(driftSeverity(trackedChanges(before, { ...before, endTime: null }))).toBe("WARN");
    expect(driftSeverity(trackedChanges(before, { ...before, spendCapMinor: null }))).toBe("WARN");
    expect(driftSeverity(trackedChanges(before, { ...before, configuredStatus: "ACTIVE" }))).toBe("WARN");
    expect(driftSeverity(trackedChanges(before, { ...before, dailyBudgetMinor: 500 }))).toBe("INFO");
    expect(driftSeverity(trackedChanges(before, { ...before, targetingHash: "y" }))).toBe("INFO");
  });
});

describe("deliveryLabel", () => {
  const now = new Date("2026-10-06T10:00:00Z");
  const base = { configuredStatus: "ACTIVE", effectiveStatus: "ACTIVE", endTime: null };

  it("tells the states apart", () => {
    expect(deliveryLabel(base, now)).toBe("Active");
    expect(deliveryLabel({ ...base, endTime: new Date("2026-10-01T00:00:00Z") }, now)).toBe("Completed");
    expect(deliveryLabel({ ...base, configuredStatus: "PAUSED", effectiveStatus: "PAUSED" }, now)).toBe("Paused by you");
    expect(deliveryLabel({ ...base, effectiveStatus: "WITH_ISSUES" }, now)).toBe("Stopped by Meta");
    expect(deliveryLabel({ ...base, effectiveStatus: "ARCHIVED" }, now)).toBe("Archived");
    expect(deliveryLabel({ ...base, effectiveStatus: "DISAPPROVED" }, now)).toBe("Rejected");
    expect(deliveryLabel({ ...base, startTime: new Date("2026-10-08T00:00:00Z") }, now)).toBe("Scheduled");
  });

  it("counts only unfinished active objects as delivering", () => {
    expect(isDelivering(base, now)).toBe(true);
    expect(isDelivering({ ...base, endTime: new Date("2026-10-05T00:00:00Z") }, now)).toBe(false);
  });
});
