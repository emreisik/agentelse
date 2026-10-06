import { describe, expect, it } from "vitest";

import { findingPriority } from "./priority";

// Bu dosyanın kanıtladığı: öncelik = önem × güven × (0.25 + kırpılmış etki
// payı), 4 ondalığa yuvarlanır.

describe("findingPriority", () => {
  it("multiplies the weights", () => {
    expect(
      findingPriority({
        severity: "INFO",
        confidence: "SIGNIFICANT",
        impactShare: 0,
      }),
    ).toBe(0.25);
    expect(
      findingPriority({
        severity: "WARN",
        confidence: "SIGNIFICANT",
        impactShare: 0.5,
      }),
    ).toBe(1.5);
    expect(
      findingPriority({
        severity: "CRITICAL",
        confidence: "DIRECTIONAL",
        impactShare: 1,
      }),
    ).toBe(1.875);
    expect(
      findingPriority({
        severity: "WARN",
        confidence: "DIRECTIONAL",
        impactShare: 0.123456,
      }),
    ).toBe(0.3735);
  });

  it("clamps the impact share and treats NaN as 0", () => {
    const base = { severity: "WARN", confidence: "SIGNIFICANT" } as const;
    expect(findingPriority({ ...base, impactShare: 5 })).toBe(2.5);
    expect(findingPriority({ ...base, impactShare: -1 })).toBe(0.5);
    expect(findingPriority({ ...base, impactShare: Number.NaN })).toBe(0.5);
  });

  it("orders significant above directional at equal severity", () => {
    const significant = findingPriority({
      severity: "WARN",
      confidence: "SIGNIFICANT",
      impactShare: 0.1,
    });
    const directional = findingPriority({
      severity: "WARN",
      confidence: "DIRECTIONAL",
      impactShare: 0.1,
    });
    expect(significant).toBeGreaterThan(directional);
  });
});
