import { describe, expect, it } from "vitest";

import {
  ApprovalPolicy,
  isAutoExecutable,
  maxLevel,
} from "@/server/execution/approval-policy";
import { ExecutionPolicy } from "@/server/execution/execution-policy";

const CAPABILITIES = [
  "BRAND_DISCOVERY",
  "WEB_RESEARCH",
  "MARKET_RESEARCH",
  "COMPETITOR_RESEARCH",
  "SEO_RESEARCH",
  "SIGNAL_SCAN",
  "MEASUREMENT_CHECK",
  "CREATE_COPY",
  "CREATE_SOCIAL_CREATIVE",
  "INSTAGRAM_PUBLISH",
  "TIKTOK_PUBLISH",
  "LINKEDIN_PUBLISH",
  "X_PUBLISH",
  "EMAIL_SEND",
  "SOCIAL_ACCOUNT_SETUP",
  "WEBSITE_UPDATE",
  "PR_OUTREACH",
  "META_CAMPAIGN_CREATE",
  "META_CAMPAIGN_UPDATE",
  "GOOGLE_ADS_CAMPAIGN_CREATE",
] as const;

describe("ApprovalPolicy — legacy parity (the L3 floor never weakens)", () => {
  it("every capability the legacy policy gates on approval resolves to L3 or higher", () => {
    for (const capability of CAPABILITIES) {
      if (!ExecutionPolicy.requiresApproval(capability)) continue;
      const level = ApprovalPolicy.resolveLevel(capability, {
        createdByType: "SYSTEM",
      });
      expect(
        ["LEVEL_3_CLIENT", "LEVEL_4_CRITICAL"],
        `${capability} must stay human-gated`,
      ).toContain(level);
      expect(isAutoExecutable(level)).toBe(false);
    }
  });

  it("publishes resolve to LEVEL_3_CLIENT", () => {
    expect(
      ApprovalPolicy.resolveLevel("WEBSITE_UPDATE", {
        createdByType: "SYSTEM",
      }),
    ).toBe("LEVEL_3_CLIENT");
    expect(
      ApprovalPolicy.resolveLevel("PR_OUTREACH", { createdByType: "SYSTEM" }),
    ).toBe("LEVEL_3_CLIENT");
  });

  // INSTAGRAM_PUBLISH is deliberately absent from the legacy L3 floor (see
  // execution-policy.ts) — a Creative already passed its own
  // CREATIVE_APPROVAL before publishing is ever attempted. It stays
  // HIGH_RISK though, which is enough on its own to auto-resolve to
  // LEVEL_2_AGENCY_DIRECTOR (still auto-executable, no human blocks it).
  it("INSTAGRAM_PUBLISH resolves to LEVEL_2 (HIGH risk, no approval floor) and auto-executes", () => {
    const level = ApprovalPolicy.resolveLevel("INSTAGRAM_PUBLISH", {
      createdByType: "SYSTEM",
      riskLevel: "HIGH",
    });
    expect(level).toBe("LEVEL_2_AGENCY_DIRECTOR");
    expect(isAutoExecutable(level)).toBe(true);
  });

  it("ad-budget writes resolve to LEVEL_4_CRITICAL", () => {
    expect(
      ApprovalPolicy.resolveLevel("META_CAMPAIGN_CREATE", {
        createdByType: "USER",
      }),
    ).toBe("LEVEL_4_CRITICAL");
    expect(
      ApprovalPolicy.resolveLevel("GOOGLE_ADS_CAMPAIGN_CREATE", {
        createdByType: "SYSTEM",
      }),
    ).toBe("LEVEL_4_CRITICAL");
  });
});

describe("ApprovalPolicy — autonomous work levels", () => {
  it("SYSTEM-created research is LEVEL_1 (internal automatic, no human)", () => {
    const level = ApprovalPolicy.resolveLevel("COMPETITOR_RESEARCH", {
      createdByType: "SYSTEM",
    });
    expect(level).toBe("LEVEL_1_INTERNAL_AUTOMATIC");
    expect(isAutoExecutable(level)).toBe(true);
  });

  it("USER-created research is LEVEL_0", () => {
    expect(
      ApprovalPolicy.resolveLevel("WEB_RESEARCH", { createdByType: "USER" }),
    ).toBe("LEVEL_0_AUTO_OBSERVE");
  });

  it("HIGH risk non-publish work escalates to LEVEL_2 (director)", () => {
    const level = ApprovalPolicy.resolveLevel("CREATE_CAMPAIGN_BRIEF", {
      createdByType: "SYSTEM",
      riskLevel: "HIGH",
    });
    expect(level).toBe("LEVEL_2_AGENCY_DIRECTOR");
    expect(isAutoExecutable(level)).toBe(true);
  });

  it("CRITICAL risk escalates to LEVEL_4", () => {
    expect(
      ApprovalPolicy.resolveLevel("CREATE_COPY", {
        createdByType: "SYSTEM",
        riskLevel: "CRITICAL",
      }),
    ).toBe("LEVEL_4_CRITICAL");
  });
});

describe("ApprovalPolicy — project overrides", () => {
  it("an override can raise a level", () => {
    expect(
      ApprovalPolicy.resolveLevel("CREATE_COPY", {
        createdByType: "SYSTEM",
        approvalOverrides: { CREATE_COPY: "LEVEL_3_CLIENT" },
      }),
    ).toBe("LEVEL_3_CLIENT");
  });

  it("an override can NEVER lower a level", () => {
    expect(
      ApprovalPolicy.resolveLevel("WEBSITE_UPDATE", {
        createdByType: "SYSTEM",
        approvalOverrides: { WEBSITE_UPDATE: "LEVEL_0_AUTO_OBSERVE" },
      }),
    ).toBe("LEVEL_3_CLIENT");
  });

  it("maxLevel picks the stricter of two levels", () => {
    expect(maxLevel("LEVEL_1_INTERNAL_AUTOMATIC", "LEVEL_3_CLIENT")).toBe(
      "LEVEL_3_CLIENT",
    );
    expect(maxLevel("LEVEL_4_CRITICAL", "LEVEL_2_AGENCY_DIRECTOR")).toBe(
      "LEVEL_4_CRITICAL",
    );
  });
});

// F7 (docs/meta-ads-plan.md §1.2): "yalnız yükseltir" kuralının yazılı ve
// testle sabitlenmiş istisnası. Başka hiçbir bağlam seviyeyi düşürmez.
describe("ApprovalPolicy — Ads autopilot exception", () => {
  it("Guarded auto runs a system safety action that reduces risk without a human (L1)", () => {
    for (const adsAutonomy of ["GUARDED", "FULL"] as const) {
      const level = ApprovalPolicy.resolveLevel("META_SAFETY_ACTION", {
        createdByType: "SYSTEM",
        adsAutonomy,
        riskReducing: true,
      });
      expect(level).toBe("LEVEL_1_INTERNAL_AUTOMATIC");
      expect(isAutoExecutable(level)).toBe(true);
    }
  });

  it("without the project's consent or without risk reduction the system still needs L4", () => {
    const cases = [
      { adsAutonomy: "SUGGEST" as const, riskReducing: true },
      { adsAutonomy: "GUARDED" as const, riskReducing: false },
      { adsAutonomy: "GUARDED" as const },
      { riskReducing: true },
    ];
    for (const context of cases) {
      expect(
        ApprovalPolicy.resolveLevel("META_SAFETY_ACTION", {
          createdByType: "SYSTEM",
          ...context,
        }),
      ).toBe("LEVEL_4_CRITICAL");
    }
  });

  it("only Full auto lowers a budget write, and only as a bounded raise", () => {
    expect(
      ApprovalPolicy.resolveLevel("META_ADSET_UPDATE", {
        createdByType: "SYSTEM",
        adsAutonomy: "FULL",
        autoBudgetRaise: true,
      }),
    ).toBe("LEVEL_1_INTERNAL_AUTOMATIC");
    expect(
      ApprovalPolicy.resolveLevel("META_ADSET_UPDATE", {
        createdByType: "SYSTEM",
        adsAutonomy: "GUARDED",
        autoBudgetRaise: true,
      }),
    ).toBe("LEVEL_4_CRITICAL");
    // riskReducing never lowers a plain spend write: cuts go through the
    // safety action, whose provider refuses anything that raises spend.
    expect(
      ApprovalPolicy.resolveLevel("META_ADSET_UPDATE", {
        createdByType: "SYSTEM",
        adsAutonomy: "FULL",
        riskReducing: true,
      }),
    ).toBe("LEVEL_4_CRITICAL");
  });

  it("the exception never applies to other capabilities or to people", () => {
    for (const capability of [
      "META_CAMPAIGN_CREATE",
      "META_ADSET_CREATE",
      "META_LAUNCH",
      "META_AD_UPDATE",
      "INSTAGRAM_PUBLISH",
      "WEBSITE_UPDATE",
    ] as const) {
      const withAutopilot = ApprovalPolicy.resolveLevel(capability, {
        createdByType: "SYSTEM",
        adsAutonomy: "FULL",
        riskReducing: true,
        autoBudgetRaise: true,
      });
      expect(withAutopilot).toBe(
        ApprovalPolicy.resolveLevel(capability, { createdByType: "SYSTEM" }),
      );
    }
    for (const capability of [
      "META_CAMPAIGN_CREATE",
      "META_ADSET_CREATE",
      "META_LAUNCH",
      "META_AD_UPDATE",
    ] as const) {
      expect(
        isAutoExecutable(
          ApprovalPolicy.resolveLevel(capability, {
            createdByType: "SYSTEM",
            adsAutonomy: "FULL",
            riskReducing: true,
            autoBudgetRaise: true,
          }),
        ),
      ).toBe(false);
    }
    expect(
      ApprovalPolicy.resolveLevel("META_ADSET_UPDATE", {
        createdByType: "USER",
        adsAutonomy: "FULL",
        autoBudgetRaise: true,
      }),
    ).toBe("LEVEL_4_CRITICAL");
  });

  it("a project override still raises it back", () => {
    expect(
      ApprovalPolicy.resolveLevel("META_SAFETY_ACTION", {
        createdByType: "SYSTEM",
        adsAutonomy: "GUARDED",
        riskReducing: true,
        approvalOverrides: { META_SAFETY_ACTION: "LEVEL_4_CRITICAL" },
      }),
    ).toBe("LEVEL_4_CRITICAL");
  });
});
