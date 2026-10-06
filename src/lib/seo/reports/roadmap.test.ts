import { describe, expect, it } from "vitest";

import {
  ROADMAP_ACTION_LIMIT,
  ROADMAP_DEBT_LIMIT,
  buildRoadmap,
  type RoadmapInput,
} from "./roadmap";
import type { SeoReportOpportunity } from "./types";

function opportunity(index: number): SeoReportOpportunity {
  return {
    id: `f${index}`,
    title: `Opportunity ${index}`,
    action: "Rewrite title",
    impactPerMonth: 100 - index,
    reachPerMonth: null,
    confidence: "Solid",
    effort: "Low",
    status: "OPEN",
    priority: 100 - index,
  };
}

function input(partial: Partial<RoadmapInput> = {}): RoadmapInput {
  return { opportunities: [], alerts: [], audit: [], quickWins: [], ...partial };
}

describe("buildRoadmap actions", () => {
  it("puts CRITICAL alerts first as 'Fix first'", () => {
    const { actions } = buildRoadmap(
      input({
        opportunities: [opportunity(1)],
        alerts: [
          { kind: "A", title: "Warn thing", severity: "WARN" },
          { kind: "B", title: "Site blocked", severity: "CRITICAL" },
        ],
      }),
    );
    expect(actions.map((a) => a.title)).toEqual(["Site blocked", "Opportunity 1"]);
    expect(actions[0]).toMatchObject({
      action: "Fix first",
      source: "health",
      findingId: null,
      severity: "CRITICAL",
    });
  });

  it("keeps opportunities in the given order with their finding ids", () => {
    const { actions } = buildRoadmap(
      input({ opportunities: [opportunity(3), opportunity(1), opportunity(2)] }),
    );
    expect(actions.map((a) => a.findingId)).toEqual(["f3", "f1", "f2"]);
    expect(actions[0]).toMatchObject({
      source: "opportunity",
      action: "Rewrite title",
      impactPerMonth: 97,
      effort: "Low",
    });
  });

  it("uses quick wins only without opportunities", () => {
    const quickWins = [{ query: "red shoes", impressions: 900, position: 8.2 }];
    const without = buildRoadmap(input({ quickWins }));
    expect(without.actions).toHaveLength(1);
    expect(without.actions[0]).toMatchObject({
      title: "Improve the page that ranks for “red shoes”",
      action: "Title & content",
      source: "quick_win",
      findingId: null,
    });
    const withOpportunity = buildRoadmap(
      input({ quickWins, opportunities: [opportunity(1)] }),
    );
    expect(withOpportunity.actions.map((a) => a.source)).toEqual(["opportunity"]);
  });

  it("caps the actions at ten", () => {
    const { actions } = buildRoadmap(
      input({
        opportunities: Array.from({ length: 14 }, (_, i) => opportunity(i)),
        alerts: [{ kind: "A", title: "Down", severity: "CRITICAL" }],
      }),
    );
    expect(ROADMAP_ACTION_LIMIT).toBe(10);
    expect(actions).toHaveLength(10);
    expect(actions[0]?.title).toBe("Down");
    const wins = buildRoadmap(
      input({
        quickWins: Array.from({ length: 14 }, (_, i) => ({
          query: `q${i}`,
          impressions: 100,
          position: 9,
        })),
      }),
    );
    expect(wins.actions).toHaveLength(10);
  });

  it("does not repeat a CRITICAL alert with the same title", () => {
    const { actions } = buildRoadmap(
      input({
        alerts: [
          { kind: "A", title: "Same", severity: "CRITICAL" },
          { kind: "B", title: "Same", severity: "CRITICAL" },
        ],
      }),
    );
    expect(actions).toHaveLength(1);
  });
});

describe("buildRoadmap tech debt", () => {
  it("lists WARN, then INFO alerts, then audit groups", () => {
    const { techDebt } = buildRoadmap(
      input({
        alerts: [
          { kind: "A", title: "Info one", severity: "INFO" },
          { kind: "B", title: "Warn one", severity: "WARN" },
          { kind: "C", title: "Critical one", severity: "CRITICAL" },
          { kind: "D", title: "Warn two", severity: "WARN" },
        ],
        audit: [
          { title: "Missing alt text", severity: "INFO", count: 40 },
          { title: "Broken links", severity: "WARN", count: 3 },
          { title: "Slow pages", severity: "WARN", count: 12 },
          { title: "Blocked by robots", severity: "CRITICAL", count: 1 },
        ],
      }),
    );
    expect(techDebt.map((item) => item.title)).toEqual([
      "Warn one",
      "Warn two",
      "Info one",
      "Blocked by robots",
      "Slow pages",
      "Broken links",
      "Missing alt text",
    ]);
    expect(techDebt.find((i) => i.title === "Slow pages")).toMatchObject({
      source: "audit",
      count: 12,
      severity: "WARN",
      findingId: null,
    });
    expect(techDebt[0]).toMatchObject({ source: "health", severity: "WARN", count: null });
  });

  it("dedupes by title and caps at ten", () => {
    const { techDebt } = buildRoadmap(
      input({
        alerts: [{ kind: "A", title: "Slow pages", severity: "WARN" }],
        audit: [
          { title: "Slow pages", severity: "WARN", count: 12 },
          ...Array.from({ length: 14 }, (_, i) => ({
            title: `Group ${i}`,
            severity: "INFO" as const,
            count: i,
          })),
        ],
      }),
    );
    expect(ROADMAP_DEBT_LIMIT).toBe(10);
    expect(techDebt).toHaveLength(10);
    expect(techDebt.filter((i) => i.title === "Slow pages")).toHaveLength(1);
    expect(techDebt[0]?.source).toBe("health");
  });
});
