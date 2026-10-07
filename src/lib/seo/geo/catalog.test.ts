import { describe, expect, it } from "vitest";

import { GEO_CHECKS, GEO_STATUS_LABEL } from "./catalog";
import {
  GEO_ACKNOWLEDGEABLE,
  GEO_CHECK_IDS,
  isAcknowledgeable,
  isGeoCheckId,
  parseGeoResult,
} from "./types";

// Bu dosyanın kanıtladığı (SC-F8): her kontrol GEO1-GEO11 için sabit metin ve
// ağırlık taşır, GEO3 puansızdır, ağırlıklar plandaki gibidir, yalnız GEO2 ve
// GEO9 kabul edilebilir ve saklı sonuç şekli doğrulanır.

describe("GEO catalog", () => {
  it("covers GEO1 to GEO11 with fixed English text", () => {
    expect(GEO_CHECK_IDS).toHaveLength(11);
    for (const id of GEO_CHECK_IDS) {
      const def = GEO_CHECKS[id];
      expect(def.title.length).toBeGreaterThan(3);
      expect(def.why.length).toBeGreaterThan(20);
      expect(def.how.length).toBeGreaterThan(10);
    }
  });

  it("uses the planned weights and leaves GEO3 unscored", () => {
    const weights = Object.fromEntries(
      GEO_CHECK_IDS.map((id) => [id, GEO_CHECKS[id].weight]),
    );
    expect(weights).toMatchObject({
      GEO1: 5,
      GEO2: 20,
      GEO4: 10,
      GEO5: 12,
      GEO6: 10,
      GEO7: 8,
      GEO8: 12,
      GEO9: 10,
      GEO10: 8,
      GEO11: 5,
    });
    expect(GEO_CHECKS.GEO3.scored).toBe(false);
    expect(
      GEO_CHECK_IDS.filter((id) => !GEO_CHECKS[id].scored),
    ).toEqual(["GEO3"]);
  });

  it("labels every status, ACK as You decided", () => {
    expect(GEO_STATUS_LABEL.ACK).toBe("You decided");
    expect(Object.keys(GEO_STATUS_LABEL).sort()).toEqual(
      ["ACK", "INFO", "NA", "PASS", "WARN"],
    );
  });

  it("accepts only GEO2 and GEO9 for acknowledgement", () => {
    expect(GEO_ACKNOWLEDGEABLE).toEqual(["GEO2", "GEO9"]);
    expect(isAcknowledgeable("GEO2")).toBe(true);
    expect(isAcknowledgeable("GEO9")).toBe(true);
    expect(isAcknowledgeable("GEO3")).toBe(false);
    expect(isAcknowledgeable(undefined)).toBe(false);
    expect(isGeoCheckId("GEO11")).toBe(true);
    expect(isGeoCheckId("GEO12")).toBe(false);
  });

  it("never promises citations in its texts", () => {
    for (const id of GEO_CHECK_IDS) {
      const text = `${GEO_CHECKS[id].why} ${GEO_CHECKS[id].how}`.toLowerCase();
      expect(text).not.toContain("guarantee");
      expect(text).not.toContain("will be cited");
    }
  });
});

describe("parseGeoResult", () => {
  const valid = {
    v: 1,
    score: 70,
    checks: [{ id: "GEO1", status: "INFO", facts: { state: "missing" } }],
    crawlers: [
      { token: "GPTBot", owner: "OpenAI", purpose: "training", allowed: true },
    ],
    llms: { state: "missing", bytes: 0, hasTitle: false, links: 0, sections: 0 },
    org: null,
    pages: {
      audited: 0,
      indexable: 0,
      withFaqSchema: 0,
      withQuestionHeadings: 0,
      longWithoutHeadings: 0,
      snippetBlocked: 0,
      renderRisk: 0,
    },
    auditedAt: "2026-10-07T00:00:00.000Z",
  };

  it("parses a stored result", () => {
    expect(parseGeoResult(valid)?.score).toBe(70);
  });

  it("rejects a wrong version or shape", () => {
    expect(parseGeoResult({ ...valid, v: 0 })).toBeNull();
    expect(parseGeoResult(null)).toBeNull();
    expect(parseGeoResult({ ...valid, checks: "x" })).toBeNull();
    expect(
      parseGeoResult({ ...valid, checks: [{ id: "GEO99", status: "PASS" }] }),
    ).toBeNull();
    expect(
      parseGeoResult({ ...valid, llms: { ...valid.llms, state: "weird" } }),
    ).toBeNull();
  });
});
