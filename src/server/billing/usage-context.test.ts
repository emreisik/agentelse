import { CapabilityKey } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  getUsageScope,
  moduleOf,
  runWithUsageScope,
} from "./usage-context";

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
