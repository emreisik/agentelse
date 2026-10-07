import { describe, expect, it, vi } from "vitest";

import fixture from "./__fixtures__/funnel-response.json";

// parseQuota paylaşılan düzenlemeyle (S-QUOTA) dışa aktarılır; bu birim testi
// o düzenlemeye bağlı olmasın diye modül sınırında sahte kullanılır. Gerçek
// parseQuota kendi testinde (response.test.ts) sınanır.
vi.mock("@/lib/website-analytics/response", () => ({
  parseQuota: (raw: Record<string, { consumed?: number; remaining?: number }>) =>
    raw?.tokensPerDay
      ? {
          tokensPerDay: {
            consumed: raw.tokensPerDay.consumed ?? 0,
            remaining: raw.tokensPerDay.remaining ?? 0,
          },
        }
      : null,
}));

const { parseFunnelResponse, readStoredFunnelResult, readStoredFunnelSteps } =
  await import("./parse");

// Bu dosyanın kanıtladığı: kayıtlı fixture (v1alpha funnelTable şekli; başlıklar
// funnelStepName / activeUsers / funnelStepCompletionRate /
// funnelStepAbandonments / funnelStepAbandonmentRate Google'ın v1alpha
// belgesinde doğrulandı; adım adının "1. Ad" biçiminde ve oranların 0..1 kesir
// olarak döndüğü kayıtlı örneğe dayanır, gerçek mülkte elle doğrulanmalı)
// sıralı adımlara ve oranlara çözülür; eksik metrik null olur; bozuk girdi
// null döner ve asla fırlatmaz.

const names = ["Visit", "Started a form", "Lead"];

describe("parseFunnelResponse", () => {
  it("parses the recorded fixture into ordered steps with rates", () => {
    const parsed = parseFunnelResponse(fixture, names, "2026-10-06");
    expect(parsed?.result.through).toBe("2026-10-06");
    expect(parsed?.result.steps).toEqual([
      {
        name: "Visit",
        users: 1200,
        completionRate: 0.25,
        abandonments: 900,
        abandonmentRate: 0.75,
      },
      {
        name: "Started a form",
        users: 300,
        completionRate: 0.4,
        abandonments: 180,
        abandonmentRate: 0.6,
      },
      {
        name: "Lead",
        users: 120,
        completionRate: 0,
        abandonments: 0,
        abandonmentRate: 0,
      },
    ]);
  });

  it("parses the property quota", () => {
    const parsed = parseFunnelResponse(fixture, names, "2026-10-06");
    expect(parsed?.quota?.tokensPerDay).toEqual({
      consumed: 12,
      remaining: 199988,
    });
  });

  it("uses the definition's names, not Google's", () => {
    const parsed = parseFunnelResponse(fixture, ["A", "B", "C"], "2026-10-06");
    expect(parsed?.result.steps.map((step) => step.name)).toEqual([
      "A",
      "B",
      "C",
    ]);
    // Ad eşleşmezse sıradaki satır alınır.
    expect(parsed?.result.steps.map((step) => step.users)).toEqual([
      1200, 300, 120,
    ]);
  });

  it("finds columns by header name in any order", () => {
    const shuffled = {
      funnelTable: {
        dimensionHeaders: [{ name: "funnelStepName" }],
        metricHeaders: [
          { name: "funnelStepAbandonments" },
          { name: "activeUsers" },
        ],
        rows: [
          {
            dimensionValues: [{ value: "2. B" }],
            metricValues: [{ value: "5" }, { value: "50" }],
          },
          {
            dimensionValues: [{ value: "1. A" }],
            metricValues: [{ value: "20" }, { value: "100" }],
          },
        ],
      },
    };
    const parsed = parseFunnelResponse(shuffled, ["A", "B"], "2026-10-06");
    expect(parsed?.result.steps).toMatchObject([
      { name: "A", users: 100, abandonments: 20, completionRate: null },
      { name: "B", users: 50, abandonments: 5, abandonmentRate: null },
    ]);
  });

  it("returns null rates for missing metrics and zero users for missing rows", () => {
    const sparse = {
      funnelTable: {
        metricHeaders: [{ name: "activeUsers" }],
        rows: [{ metricValues: [{ value: "40" }] }],
      },
    };
    const parsed = parseFunnelResponse(sparse, ["A", "B"], "2026-10-06");
    expect(parsed?.result.steps).toEqual([
      {
        name: "A",
        users: 40,
        completionRate: null,
        abandonments: null,
        abandonmentRate: null,
      },
      {
        name: "B",
        users: 0,
        completionRate: null,
        abandonments: null,
        abandonmentRate: null,
      },
    ]);
    expect(parsed?.quota).toBeNull();
  });

  it("returns null for garbage and never throws", () => {
    for (const input of [
      null,
      undefined,
      "x",
      42,
      [],
      {},
      { funnelTable: "no" },
      { funnelTable: { rows: [] } },
      { funnelTable: { metricHeaders: [{ name: "other" }] } },
    ]) {
      expect(() => parseFunnelResponse(input, names, "d")).not.toThrow();
      expect(parseFunnelResponse(input, names, "d")).toBeNull();
    }
    expect(
      parseFunnelResponse(
        { funnelTable: { metricHeaders: [{ name: "activeUsers" }], rows: [null, 3] } },
        names,
        "d",
      )?.result.steps[0]?.users,
    ).toBe(0);
  });
});

describe("stored readers", () => {
  it("round-trips a stored result and rejects broken JSON", () => {
    const stored = { through: "2026-10-06", steps: [{ name: "A", users: 5 }] };
    expect(readStoredFunnelResult(stored)).toEqual({
      through: "2026-10-06",
      steps: [
        {
          name: "A",
          users: 5,
          completionRate: null,
          abandonments: null,
          abandonmentRate: null,
        },
      ],
    });
    for (const bad of [null, "x", { through: 1 }, { through: "d", steps: [1] }]) {
      expect(readStoredFunnelResult(bad)).toBeNull();
    }
  });

  it("reads stored steps tolerantly", () => {
    expect(
      readStoredFunnelSteps([{ name: "A", kind: "event", value: "a" }]),
    ).toHaveLength(1);
    expect(readStoredFunnelSteps([{ name: "A", kind: "x", value: "a" }])).toBeNull();
    expect(readStoredFunnelSteps("no")).toBeNull();
  });
});
