import { describe, expect, it } from "vitest";

import {
  GA_DEFERRED_RULES,
  GA_RULES,
  gaRule,
  isEvaluable,
  isGaRuleKey,
} from "./registry";
import {
  GA_ADS_RULE_KEYS,
  GA_RULE_KEYS,
  type GaFindingEvidence,
  type GaRuleKey,
} from "./types";

// Bu dosyanın kanıtladığı: her kural anahtarının tanımı var, başlıklarda
// rakam yok, evaluable ve recurrence tabloları sözleşmeyle aynı.

function an4(direction: "below" | "above"): GaFindingEvidence {
  return {
    v: 1,
    rule: "AN4",
    window: { from: "2026-09-07", to: "2026-10-04" },
    channel: "Paid Search",
    measure: "keyEventRate",
    direction,
    sessions: 1000,
    hits: 5,
    rate: 0.005,
    restSessions: 9000,
    restHits: 180,
    restRate: 0.02,
    ratio: 0.25,
    p: 0.001,
    bhAccepted: true,
    excludedDays: [],
    holidays: [],
  };
}

function an12(direction: "below" | "above"): GaFindingEvidence {
  return {
    v: 1,
    rule: "AN12",
    window: { from: "2026-09-07", to: "2026-10-04" },
    campaign: "autumn",
    source: "newsletter",
    medium: "email",
    agentelse: false,
    direction,
    sessions: 500,
    keyEvents: 1,
    rate: 0.002,
    restSessions: 9000,
    restKeyEvents: 180,
    restRate: 0.02,
    ratio: 0.1,
    p: 0.01,
    bhAccepted: true,
    excludedDays: [],
    holidays: [],
  };
}

describe("GA_RULES", () => {
  it("defines every rule key once, in order", () => {
    expect(GA_RULES.map((rule) => rule.key)).toEqual([...GA_RULE_KEYS]);
    for (const key of GA_RULE_KEYS) {
      expect(gaRule(key).key).toBe(key);
      expect(gaRule(key).version).toBe(1);
    }
  });

  it("titles are generic: no digits", () => {
    for (const rule of GA_RULES) {
      expect(rule.title).not.toMatch(/\d/);
      expect(rule.title.length).toBeGreaterThan(0);
    }
  });

  it("has 15 rule keys with AN13 and AN14 between AN12 and AN15", () => {
    expect(GA_RULE_KEYS).toHaveLength(15);
    expect(GA_RULE_KEYS.slice(11)).toEqual(["AN12", "AN13", "AN14", "AN15"]);
    expect([...GA_ADS_RULE_KEYS]).toEqual(["AN13", "AN14"]);
  });

  it("AN13 and AN14 rows follow the contract", () => {
    expect(gaRule("AN13")).toMatchObject({
      title: "Ad clicks and website visits don't line up",
      cadence: "weekly",
      list: "opportunities",
      recurrence: "condition",
      ttlDays: 28,
      version: 1,
      signal: null,
      report: "campaign",
    });
    expect(gaRule("AN14")).toMatchObject({
      title: "Google Ads results changed",
      cadence: "weekly",
      list: "changed",
      recurrence: "condition",
      ttlDays: 28,
      version: 1,
      signal: null,
      report: null,
    });
  });

  it("recurrence: AN1, AN2, AN7, AN11, AN15 are event rules", () => {
    const events = GA_RULES.filter((rule) => rule.recurrence === "event").map(
      (rule) => rule.key,
    );
    expect(events).toEqual(["AN1", "AN2", "AN7", "AN11", "AN15"]);
  });

  it("cadence, list, ttl, signal and report follow the table", () => {
    const table: Record<
      GaRuleKey,
      [string, string, number, string | null, string | null]
    > = {
      AN1: ["daily", "changed", 7, null, null],
      AN2: ["weekly", "changed", 14, "BY_CHANNEL", null],
      AN3: ["weekly", "opportunities", 28, "PERFORMANCE", "landing"],
      AN4: ["weekly", "opportunities", 28, null, "channel"],
      AN5: ["weekly", "opportunities", 28, null, "device"],
      AN6: ["weekly", "changed", 28, null, null],
      AN7: ["weekly", "changed", 28, "SEO", "sourceMedium"],
      AN8: ["weekly", "opportunities", 28, null, null],
      AN9: ["weekly", "opportunities", 14, null, null],
      AN10: ["monthly", "opportunities", 35, null, null],
      AN11: ["weekly", "opportunities", 14, null, null],
      AN12: ["weekly", "opportunities", 28, null, "campaign"],
      AN13: ["weekly", "opportunities", 28, null, "campaign"],
      AN14: ["weekly", "changed", 28, null, null],
      AN15: ["daily", "opportunities", 31, null, null],
    };
    for (const rule of GA_RULES) {
      expect([
        rule.cadence,
        rule.list,
        rule.ttlDays,
        rule.signal,
        rule.report,
      ]).toEqual(table[rule.key]);
    }
  });

  it("evaluable matrix", () => {
    const any = an4("above");
    const always: GaRuleKey[] = ["AN3", "AN5", "AN9", "AN11"];
    const never: GaRuleKey[] = [
      "AN1",
      "AN2",
      "AN6",
      "AN7",
      "AN8",
      "AN10",
      "AN15",
    ];
    for (const key of always) expect(isEvaluable(key, any)).toBe(true);
    for (const key of never) expect(isEvaluable(key, any)).toBe(false);
    expect(isEvaluable("AN4", an4("below"))).toBe(true);
    expect(isEvaluable("AN4", an4("above"))).toBe(false);
    expect(isEvaluable("AN12", an12("below"))).toBe(true);
    expect(isEvaluable("AN12", an12("above"))).toBe(false);
    // AN13 ve AN14 hiçbir kanıtta üzerinde çalışılabilir değil.
    expect(isEvaluable("AN13", an12("below"))).toBe(false);
    expect(isEvaluable("AN14", an12("below"))).toBe(false);
  });
});

describe("GA_DEFERRED_RULES and keys", () => {
  it("lists only AN16 and the AOV part of AN11", () => {
    expect(GA_DEFERRED_RULES.map((rule) => [rule.key, rule.note])).toEqual([
      ["AN16", "modifier: holidays and seasonality"],
      ["AN11-AOV", "recorded in AN11 evidence, not evaluated yet"],
    ]);
    expect(GA_DEFERRED_RULES[1]!.title).toBe("Basket value change");
    const keys: string[] = GA_DEFERRED_RULES.map((rule) => rule.key);
    expect(keys).not.toContain("AN13");
    expect(keys).not.toContain("AN14");
  });

  it("isGaRuleKey accepts only finding rule keys", () => {
    expect(isGaRuleKey("AN1")).toBe(true);
    expect(isGaRuleKey("AN15")).toBe(true);
    expect(isGaRuleKey("AN13")).toBe(true);
    expect(isGaRuleKey("AN14")).toBe(true);
    expect(isGaRuleKey("AN16")).toBe(false);
    expect(isGaRuleKey("MH1")).toBe(false);
    expect(isGaRuleKey(1)).toBe(false);
  });
});
