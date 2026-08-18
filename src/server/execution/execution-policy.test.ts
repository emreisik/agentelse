import { describe, expect, it } from "vitest";

import { ExecutionPolicy } from "@/server/execution/execution-policy";

describe("ExecutionPolicy.requiresApproval", () => {
  it("requires approval for publish/account-setup/campaign-write capabilities", () => {
    expect(ExecutionPolicy.requiresApproval("INSTAGRAM_PUBLISH")).toBe(true);
    expect(ExecutionPolicy.requiresApproval("TIKTOK_PUBLISH")).toBe(true);
    expect(ExecutionPolicy.requiresApproval("SOCIAL_ACCOUNT_SETUP")).toBe(true);
    expect(ExecutionPolicy.requiresApproval("META_CAMPAIGN_CREATE")).toBe(true);
    expect(ExecutionPolicy.requiresApproval("EMAIL_SEND")).toBe(true);
  });

  it("does not require approval for read-only or content-generation capabilities", () => {
    expect(ExecutionPolicy.requiresApproval("CREATE_SOCIAL_CREATIVE")).toBe(
      false,
    );
    expect(ExecutionPolicy.requiresApproval("WEB_RESEARCH")).toBe(false);
    expect(ExecutionPolicy.requiresApproval("COMPETITOR_RESEARCH")).toBe(false);
    expect(ExecutionPolicy.requiresApproval("ANALYTICS_ANALYSIS")).toBe(false);
  });
});

describe("ExecutionPolicy.requiresVerification", () => {
  it("requires independent verification for external write actions", () => {
    expect(ExecutionPolicy.requiresVerification("INSTAGRAM_PUBLISH")).toBe(
      true,
    );
    expect(ExecutionPolicy.requiresVerification("SOCIAL_ACCOUNT_SETUP")).toBe(
      true,
    );
  });

  it("does not require verification for internal content generation", () => {
    expect(ExecutionPolicy.requiresVerification("CREATE_SOCIAL_CREATIVE")).toBe(
      false,
    );
    expect(ExecutionPolicy.requiresVerification("CREATE_COPY")).toBe(false);
  });
});

describe("ExecutionPolicy.defaultRiskLevel", () => {
  it("marks approval-gated capabilities HIGH risk", () => {
    expect(ExecutionPolicy.defaultRiskLevel("INSTAGRAM_PUBLISH")).toBe("HIGH");
  });

  it("marks read-only research LOW risk", () => {
    expect(ExecutionPolicy.defaultRiskLevel("WEB_RESEARCH")).toBe("LOW");
  });
});

describe("ExecutionPolicy.staticBrowserPurpose", () => {
  it("maps platform-publish capabilities to the matching browser purpose", () => {
    expect(ExecutionPolicy.staticBrowserPurpose("INSTAGRAM_PUBLISH")).toBe(
      "INSTAGRAM",
    );
    expect(ExecutionPolicy.staticBrowserPurpose("TIKTOK_PUBLISH")).toBe(
      "TIKTOK",
    );
    expect(ExecutionPolicy.staticBrowserPurpose("GOOGLE_ADS_ANALYSIS")).toBe(
      "GOOGLE_ADS",
    );
  });

  it("has no static mapping for SOCIAL_ACCOUNT_SETUP — the platform is only known at runtime", () => {
    expect(
      ExecutionPolicy.staticBrowserPurpose("SOCIAL_ACCOUNT_SETUP"),
    ).toBeUndefined();
  });

  it("has no browser purpose for pure content-generation capabilities", () => {
    expect(
      ExecutionPolicy.staticBrowserPurpose("CREATE_SOCIAL_CREATIVE"),
    ).toBeUndefined();
  });
});

describe("ExecutionPolicy.requiresBrowserProfile", () => {
  it("is true for capabilities with a static browser purpose and for SOCIAL_ACCOUNT_SETUP", () => {
    expect(ExecutionPolicy.requiresBrowserProfile("INSTAGRAM_PUBLISH")).toBe(
      true,
    );
    expect(ExecutionPolicy.requiresBrowserProfile("SOCIAL_ACCOUNT_SETUP")).toBe(
      true,
    );
  });

  it("is false for pure content-generation capabilities", () => {
    expect(
      ExecutionPolicy.requiresBrowserProfile("CREATE_SOCIAL_CREATIVE"),
    ).toBe(false);
    expect(ExecutionPolicy.requiresBrowserProfile("CREATE_COPY")).toBe(false);
  });
});
