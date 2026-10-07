import { describe, expect, it } from "vitest";

import {
  OPEN_SPLIT_STATUSES,
  SPLIT_CHANGE_KINDS,
  SPLIT_STATUSES,
  isSplitChangeKind,
  isSplitStatus,
  parseSplitChange,
  parseSplitEvaluation,
  parseSplitVerification,
} from "./types";

// Bu dosyanın kanıtladığı: tür ve durum listeleri; hoşgörülü okuyucular yanlış
// biçimli alanları tek tek atar, metinleri sınırlar ve hiç fırlatmaz; sürümü
// 1 olmayan ya da sonucu eksik değerlendirme null döner.

const EVALUATION = {
  v: 1,
  method: "DID",
  metric: "ctr_adj",
  anchorDay: "2026-08-05",
  preWeeks: ["2026-06-08", 7, "2026-06-15"],
  postWeeks: ["2026-08-17"],
  testPages: 180,
  controlPages: 180,
  usedTest: 170,
  usedControl: 171,
  excluded: 4,
  effect: 0.12,
  low: 0.02,
  high: 0.22,
  placebo: {
    effect: 0.01,
    low: -0.02,
    high: 0.04,
    passed: true,
    padding: 0.01,
  },
  treated: {
    before: {
      weeks: 8,
      clicks: 10,
      impressions: 100,
      ctr: 0.1,
      position: 4,
      ctrAdj: 1,
    },
    after: {
      weeks: 4,
      clicks: 12,
      impressions: 100,
      ctr: 0.12,
      position: 4,
      ctrAdj: 1.2,
    },
  },
  control: null,
  updates: [
    { name: "Core", kind: "CORE", startedAt: "2026-08-01T00:00:00.000Z" },
    { bad: true },
  ],
  truncated: false,
  reason: null,
  outcome: "WORKED",
  confidence: "SIGNIFICANT",
  evaluatedAt: "2026-09-10T12:00:00.000Z",
};

describe("split types", () => {
  it("lists kinds and statuses and recognises them", () => {
    expect(SPLIT_CHANGE_KINDS).toHaveLength(6);
    expect(SPLIT_STATUSES).toHaveLength(8);
    expect(OPEN_SPLIT_STATUSES).toEqual(["DRAFT", "APPLIED", "EVALUATING"]);
    expect(isSplitChangeKind("TITLE_META")).toBe(true);
    expect(isSplitChangeKind("nope")).toBe(false);
    expect(isSplitStatus("WORKED")).toBe(true);
    expect(isSplitStatus(3)).toBe(false);
  });

  it("reads a change leniently and caps the text", () => {
    expect(parseSplitChange(null)).toEqual({
      titlePattern: null,
      metaPattern: null,
      schemaType: null,
      note: null,
    });
    const change = parseSplitChange({
      titlePattern: "{title} | {site}",
      metaPattern: 5,
      schemaType: "  FAQPage ",
      note: "x".repeat(900),
    });
    expect(change.titlePattern).toBe("{title} | {site}");
    expect(change.metaPattern).toBeNull();
    expect(change.schemaType).toBe("FAQPage");
    expect(change.note).toHaveLength(400);
  });

  it("reads a verification and drops bad checks and unknown values", () => {
    const verification = parseSplitVerification({
      attempts: 2.4,
      lastCheckedAt: "2026-09-01T00:00:00.000Z",
      checks: [
        { key: "a", label: "A", ok: true, observed: "3 of 5 pages" },
        { key: "b", label: "B" },
        "junk",
      ],
      method: "CMS",
      reason: "SOMETHING_ELSE",
    });
    expect(verification.attempts).toBe(2);
    expect(verification.checks).toHaveLength(1);
    expect(verification.method).toBe("CMS");
    expect(verification.reason).toBeNull();
    expect(parseSplitVerification("x")).toEqual({
      v: 1,
      attempts: 0,
      lastCheckedAt: null,
      checks: [],
      method: null,
      reason: null,
    });
  });

  it("reads an evaluation and drops bad fields one by one", () => {
    const parsed = parseSplitEvaluation(EVALUATION);
    expect(parsed).not.toBeNull();
    expect(parsed?.preWeeks).toEqual(["2026-06-08", "2026-06-15"]);
    expect(parsed?.updates).toHaveLength(1);
    expect(parsed?.placebo?.passed).toBe(true);
    expect(parsed?.treated?.after.clicks).toBe(12);
    expect(parsed?.control).toBeNull();
    expect(parsed?.confidence).toBe("SIGNIFICANT");
  });

  it("returns null for a wrong version or a missing outcome", () => {
    expect(parseSplitEvaluation({ ...EVALUATION, v: 2 })).toBeNull();
    expect(
      parseSplitEvaluation({ ...EVALUATION, outcome: "MAYBE" }),
    ).toBeNull();
    expect(
      parseSplitEvaluation({ ...EVALUATION, evaluatedAt: undefined }),
    ).toBeNull();
    expect(parseSplitEvaluation(null)).toBeNull();
  });

  it("keeps the pre-trend reason", () => {
    const parsed = parseSplitEvaluation({
      ...EVALUATION,
      reason: "PRE_TREND",
      outcome: "INCONCLUSIVE",
      confidence: "x",
    });
    expect(parsed?.reason).toBe("PRE_TREND");
    expect(parsed?.confidence).toBe("DIRECTIONAL");
  });
});
