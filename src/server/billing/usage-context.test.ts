import { CapabilityKey } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  assertTaskRoom,
  getUsageScope,
  initiatorOfActor,
  isBackground,
  moduleOf,
  runAsBackground,
  runWithUsageScope,
} from "./usage-context";
import { UsageMeter } from "./usage-meter";

describe("runWithUsageScope", () => {
  it("has no scope outside a run", () => {
    expect(getUsageScope()).toBeUndefined();
  });

  it("gives each outer run its own operation id and lets nested runs inherit it", () => {
    runWithUsageScope({ workspaceId: "w1", projectId: "p1" }, () => {
      const outer = getUsageScope();
      expect(outer?.operationId).toBeTruthy();
      runWithUsageScope(
        { workspaceId: "w1", projectId: "p1", purpose: "seo.research" },
        () => {
          const inner = getUsageScope();
          expect(inner?.operationId).toBe(outer?.operationId);
          expect(inner?.purpose).toBe("seo.research");
        },
      );
      expect(getUsageScope()?.purpose).toBeUndefined();
    });
  });

  it("lets an explicit operation id win, and keeps parent fields the child leaves out", () => {
    runWithUsageScope(
      { workspaceId: "w1", userId: "u1", source: "action" },
      () => {
        runWithUsageScope(
          { workspaceId: "w1", operationId: "exec:job1" },
          () => {
            expect(getUsageScope()).toMatchObject({
              workspaceId: "w1",
              userId: "u1",
              source: "action",
              operationId: "exec:job1",
            });
          },
        );
      },
    );
  });
});

describe("moduleOf", () => {
  it("groups purposes and capabilities into product modules", () => {
    expect(moduleOf("seo.article")).toBe("SEO");
    expect(moduleOf("gsc.period.query")).toBe("SEO");
    expect(moduleOf("idea.seo")).toBe("SEO");
    expect(moduleOf("ga.findings.explain")).toBe("ANALYTICS");
    expect(moduleOf("analytics.reportSummary")).toBe("ANALYTICS");
    expect(moduleOf("meta-ads.campaign-brief")).toBe("ADS");
    expect(moduleOf("ads.plan")).toBe("ADS");
    expect(moduleOf("chat.turn")).toBe("CHAT");
    expect(moduleOf("idea.social")).toBe("SOCIAL");
    expect(moduleOf("plan.weeklyDraft")).toBe("SOCIAL");
    expect(moduleOf("creative.regenerate")).toBe("SOCIAL");
    expect(moduleOf("week-planner")).toBe("SOCIAL");
    expect(moduleOf(undefined)).toBe("OTHER");
    expect(moduleOf("council.evaluate")).toBe("OTHER");
    expect(moduleOf("setup.competitorFind")).toBe("OTHER");
  });

  it("classifies the capabilities the review found falling into OTHER", () => {
    expect(moduleOf("GENERATE_IDEAS")).toBe("SOCIAL");
    expect(moduleOf("SOCIAL_RESEARCH")).toBe("SOCIAL");
    expect(moduleOf("SOCIAL_ACCOUNT_SETUP")).toBe("SOCIAL");
    expect(moduleOf("CREATE_SOCIAL_CREATIVE")).toBe("SOCIAL");
    expect(moduleOf("GOOGLE_ADS_ANALYSIS")).toBe("ADS");
    expect(moduleOf("ADVERTISING_RESEARCH")).toBe("ADS");
    expect(moduleOf("META_CAMPAIGN_CREATE")).toBe("ADS");
    expect(moduleOf("MEASUREMENT_CHECK")).toBe("ANALYTICS");
    expect(moduleOf("SEO_RESEARCH")).toBe("SEO");
  });

  it("knows every capability in the schema (a new one must be added to the table)", () => {
    const valid = new Set(["SOCIAL", "ADS", "ANALYTICS", "SEO", "CHAT", "OTHER"]);
    for (const capability of Object.values(CapabilityKey)) {
      expect(valid.has(moduleOf(capability))).toBe(true);
    }
  });
});

describe("assertTaskRoom (the per-task cost ceiling)", () => {
  const spend = (meter: UsageMeter, micros: number) =>
    meter.add({
      callId: `c${micros}-${Math.random()}`,
      kind: "TEXT",
      costMicros: BigInt(micros),
      success: true,
    });

  it("does nothing outside any scope or without a ceiling", () => {
    expect(() => assertTaskRoom()).not.toThrow();
    const meter = new UsageMeter({ workspaceId: "w1", operationId: "op" });
    spend(meter, 9_999_999);
    runWithUsageScope({ workspaceId: "w1", meter }, () => {
      expect(() => assertTaskRoom()).not.toThrow();
    });
  });

  it("lets the call that crosses the ceiling happen and refuses the NEXT one", () => {
    const meter = new UsageMeter({
      workspaceId: "w1",
      operationId: "op",
      ceilingMicros: BigInt(1_000),
    });
    runWithUsageScope({ workspaceId: "w1", meter }, () => {
      spend(meter, 1_000);
      expect(() => assertTaskRoom()).not.toThrow(); // at the ceiling: still fine
      spend(meter, 1); // this one crossed it
      expect(() => assertTaskRoom()).toThrowError(
        expect.objectContaining({
          code: "BUDGET_EXCEEDED",
          meta: { limit: "taskCeiling" },
        }),
      );
    });
  });

  it("applies to calls nested inside the job's scope too", () => {
    const meter = new UsageMeter({
      workspaceId: "w1",
      operationId: "op",
      ceilingMicros: BigInt(10),
    });
    spend(meter, 11);
    runWithUsageScope({ workspaceId: "w1", meter }, () => {
      runWithUsageScope({ workspaceId: "w1", purpose: "art-director" }, () => {
        expect(() => assertTaskRoom()).toThrow();
      });
    });
  });
});

describe("background marker", () => {
  it("is off by default and on only inside runAsBackground, through awaits and timers", async () => {
    expect(isBackground()).toBe(false);
    await runAsBackground(async () => {
      expect(isBackground()).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(isBackground()).toBe(true);
      // A usage scope opened inside keeps the marker.
      runWithUsageScope({ workspaceId: "w1" }, () => {
        expect(isBackground()).toBe(true);
      });
    });
    expect(isBackground()).toBe(false);
  });

  it("returns what the function returns", () => {
    expect(runAsBackground(() => 42)).toBe(42);
  });
});

describe("initiatorOfActor", () => {
  it("is the user only for a task the user created", () => {
    expect(initiatorOfActor("USER")).toBe("user");
    expect(initiatorOfActor("SYSTEM")).toBe("system");
    expect(initiatorOfActor("AI")).toBe("system");
    expect(initiatorOfActor("anything else")).toBe("system");
  });
});
