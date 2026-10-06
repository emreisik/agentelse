import { describe, expect, it } from "vitest";

import type { ScorePartKey } from "./alert-kinds";
import {
  SCORE_WEIGHTS,
  computeSearchHealthScore,
  parseStoredScore,
} from "./score";

const ALL: Record<ScorePartKey, boolean> = {
  indexing: true,
  technical: true,
  sitemap_robots: true,
  cwv: true,
  data: true,
};

describe("computeSearchHealthScore", () => {
  it("gives full marks without issues", () => {
    const score = computeSearchHealthScore({
      drafts: [],
      available: ALL,
      coveragePoint: null,
      technicalCleanShare: null,
    });
    expect(score.value).toBe(100);
    expect(score.cappedByCritical).toBe(false);
    expect(Object.values(SCORE_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("renormalises without Search Console and CWV", () => {
    const score = computeSearchHealthScore({
      drafts: [{ kind: "SEO_HTTPS", severity: "WARN" }],
      available: { ...ALL, indexing: false, data: false, cwv: false },
      coveragePoint: null,
      technicalCleanShare: null,
    });
    // technical 25 - 10 = 15, sitemap_robots 15 → 30 / 40
    expect(score.value).toBe(75);
    expect(score.parts.find((part) => part.key === "indexing")).toMatchObject({
      available: false,
      score: null,
    });
  });

  it("subtracts per severity and floors at zero", () => {
    const warn = computeSearchHealthScore({
      drafts: [{ kind: "SEO_SITEMAP_MISSING", severity: "WARN" }],
      available: ALL,
      coveragePoint: null,
      technicalCleanShare: null,
    });
    expect(warn.value).toBe(94);
    const info = computeSearchHealthScore({
      drafts: [{ kind: "SEO_AI_CRAWLERS_BLOCKED", severity: "INFO" }],
      available: ALL,
      coveragePoint: null,
      technicalCleanShare: null,
    });
    expect(info.value).toBe(99);
    const floored = computeSearchHealthScore({
      drafts: [
        { kind: "SEO_SITEMAP_MISSING", severity: "WARN" },
        { kind: "SEO_SITEMAP_HYGIENE", severity: "WARN" },
        { kind: "SEO_ROBOTS_ASSETS", severity: "WARN" },
      ],
      available: ALL,
      coveragePoint: null,
      technicalCleanShare: null,
    });
    expect(
      floored.parts.find((part) => part.key === "sitemap_robots")?.score,
    ).toBe(0);
    expect(floored.value).toBe(85);
  });

  it("caps at 40 with any CRITICAL", () => {
    const score = computeSearchHealthScore({
      drafts: [{ kind: "GSC_INDEX_LOST", severity: "CRITICAL" }],
      available: ALL,
      coveragePoint: null,
      technicalCleanShare: null,
    });
    expect(score.value).toBe(40);
    expect(score.cappedByCritical).toBe(true);
  });

  it("is null when nothing is available", () => {
    const score = computeSearchHealthScore({
      drafts: [{ kind: "SEO_HTTPS", severity: "WARN" }],
      available: {
        indexing: false,
        technical: false,
        sitemap_robots: false,
        cwv: false,
        data: false,
      },
      coveragePoint: 0.5,
      technicalCleanShare: 0.5,
    });
    expect(score.value).toBeNull();
  });

  it("scales indexing by coverage and technical by the clean share", () => {
    const score = computeSearchHealthScore({
      drafts: [],
      available: ALL,
      coveragePoint: 0.8,
      technicalCleanShare: 0.6,
    });
    // 28 + 15 + 15 + 15 + 10 = 83
    expect(score.value).toBe(83);
    expect(score.parts.find((part) => part.key === "indexing")?.score).toBe(28);
    expect(score.parts.find((part) => part.key === "technical")?.score).toBe(
      15,
    );
  });

  it("round-trips through the stored JSON", () => {
    const score = computeSearchHealthScore({
      drafts: [],
      available: ALL,
      coveragePoint: 0.8,
      technicalCleanShare: null,
    });
    expect(parseStoredScore(JSON.parse(JSON.stringify(score)))).toEqual(score);
    expect(parseStoredScore(null)).toBeNull();
    expect(parseStoredScore({ value: "x", parts: [] })).toBeNull();
  });
});
