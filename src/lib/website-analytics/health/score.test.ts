import { describe, expect, it } from "vitest";

import {
  checkCredit,
  GA_SCORE_CRITICAL_CAP,
  measurementLabel,
  measurementScore,
  measurementTone,
  summarizeMeasurement,
} from "./score";
import {
  GA_CHECK_KEYS,
  type GaCheckKey,
  type GaCheckResult,
  type GaCheckSeverity,
  type GaCheckStatus,
} from "./types";

// Puan: kredi tablosu, UNKNOWN'ın paydadan çıkması, 8'den az bilinen kontrolde
// puan yok, CRITICAL hatada 40 tavanı ve ton sınırları.

type R = Pick<GaCheckResult, "key" | "status" | "severity">;

function all(
  status: GaCheckStatus,
  overrides: Partial<Record<GaCheckKey, [GaCheckStatus, GaCheckSeverity]>> = {},
): R[] {
  return GA_CHECK_KEYS.map((key) => {
    const [s, severity] = overrides[key] ?? [status, "WARN" as GaCheckSeverity];
    return { key, status: s, severity };
  });
}

describe("measurement score", () => {
  it("credits checks", () => {
    expect(checkCredit("PASS", "CRITICAL")).toBe(1);
    expect(checkCredit("WARN", "INFO")).toBe(0.75);
    expect(checkCredit("WARN", "WARN")).toBe(0.4);
    expect(checkCredit("WARN", "CRITICAL")).toBe(0.2);
    expect(checkCredit("FAIL", "INFO")).toBe(0);
    expect(checkCredit("UNKNOWN", "WARN")).toBeNull();
  });

  it("all PASS → 100 and ok", () => {
    const results = all("PASS");
    expect(measurementScore(results)).toBe(100);
    expect(measurementTone(100, results)).toBe("ok");
  });

  it("an MH1 CRITICAL failure caps the score at 40 and turns it red", () => {
    const results = all("PASS", { MH1: ["FAIL", "CRITICAL"] });
    const score = measurementScore(results);
    expect(score).not.toBeNull();
    expect(score!).toBeLessThanOrEqual(GA_SCORE_CRITICAL_CAP);
    expect(measurementTone(score, results)).toBe("error");
  });

  it("scores a critical failure even with few known checks", () => {
    const results: R[] = [
      { key: "MH1", status: "FAIL", severity: "CRITICAL" },
      { key: "MH2", status: "UNKNOWN", severity: "INFO" },
    ];
    expect(measurementScore(results)).toBe(0);
  });

  it("renormalises over known checks only", () => {
    // Yalnız data_flow ve configuration bilinir; diğerleri UNKNOWN.
    const results: R[] = GA_CHECK_KEYS.map((key) => ({
      key,
      status: "UNKNOWN",
      severity: "INFO",
    }));
    const set = (
      key: GaCheckKey,
      status: GaCheckStatus,
      severity: GaCheckSeverity,
    ) => {
      const index = results.findIndex((result) => result.key === key);
      results[index] = { key, status, severity };
    };
    for (const key of [
      "MH1",
      "MH1_RT",
      "MH2",
      "MH6",
      "MH22",
      "MH24",
    ] as const) {
      set(key, "PASS", "INFO");
    }
    for (const key of ["MH5", "MH13", "MH14"] as const)
      set(key, "PASS", "INFO");
    expect(measurementScore(results)).toBe(100);
    // configuration: MH5 (3) WARN .4, MH13 (1) PASS, MH14 (1) PASS → (1.2+2)/5 = .64
    set("MH5", "WARN", "WARN");
    // (30×1 + 20×.64) / 50 = .856
    expect(measurementScore(results)).toBe(86);
  });

  it("returns null with fewer than eight known checks", () => {
    const results: R[] = GA_CHECK_KEYS.map((key, index) => ({
      key,
      status: index < 7 ? "PASS" : "UNKNOWN",
      severity: "WARN",
    }));
    expect(measurementScore(results)).toBeNull();
    expect(measurementTone(null, results)).toBe("unknown");
    expect(measurementLabel(null)).toBe("Checking…");
    results[7] = { ...results[7]!, status: "PASS" };
    expect(measurementScore(results)).toBe(100);
  });

  it("gives an INFO warning 0.75 credit", () => {
    const results = all("PASS", { MH2: ["WARN", "INFO"] });
    // data_flow: MH1 3, MH1_RT 1, MH2 .5, MH6 2, MH22 1, MH24 3 = 10.5; MH2 → .375
    const dataFlow = (10.5 - 0.5 + 0.375) / 10.5;
    expect(measurementScore(results)).toBe(
      Math.round((100 * (30 * dataFlow + 70)) / 100),
    );
  });

  it("tone boundaries 49/50/79/80", () => {
    const passing = all("PASS");
    expect(measurementTone(49, passing)).toBe("error");
    expect(measurementTone(50, passing)).toBe("warning");
    expect(measurementTone(79, passing)).toBe("warning");
    expect(measurementTone(80, passing)).toBe("ok");
    expect(measurementTone(95, all("PASS", { MH7: ["WARN", "WARN"] }))).toBe(
      "warning",
    );
    expect(measurementTone(95, all("PASS", { MH8: ["WARN", "INFO"] }))).toBe(
      "ok",
    );
    expect(measurementLabel(72)).toBe("72/100");
  });

  it("summarises issues and critical failures", () => {
    const results = all("PASS", {
      MH1: ["FAIL", "CRITICAL"],
      MH7: ["WARN", "WARN"],
      MH8: ["WARN", "INFO"],
      MH3: ["UNKNOWN", "WARN"],
    });
    const at = new Date("2026-10-06T10:00:00Z");
    expect(
      summarizeMeasurement({ score: 40, results, evaluatedAt: at }),
    ).toEqual({
      score: 40,
      tone: "error",
      label: "40/100",
      issues: 2,
      critical: 1,
      evaluatedAt: "2026-10-06T10:00:00.000Z",
    });
    expect(
      summarizeMeasurement({ score: null, results: [], evaluatedAt: null }),
    ).toEqual({
      score: null,
      tone: "unknown",
      label: "Checking…",
      issues: 0,
      critical: 0,
      evaluatedAt: null,
    });
  });
});
