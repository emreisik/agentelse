import { describe, expect, it } from "vitest";

import { ExecutionPolicy } from "@/server/execution/execution-policy";

describe("ExecutionPolicy.requiresApproval", () => {
  it("requires approval for publish/account-setup/campaign-write capabilities", () => {
    expect(ExecutionPolicy.requiresApproval("TIKTOK_PUBLISH")).toBe(true);
    expect(ExecutionPolicy.requiresApproval("SOCIAL_ACCOUNT_SETUP")).toBe(true);
    expect(ExecutionPolicy.requiresApproval("META_CAMPAIGN_CREATE")).toBe(true);
    expect(ExecutionPolicy.requiresApproval("EMAIL_SEND")).toBe(true);
  });

  // A Creative already passed its own CREATIVE_APPROVAL gate before
  // publishing is ever attempted (see approval-decisions.ts) — a second
  // approval here would just re-ask the same question. Still HIGH_RISK and
  // VERIFICATION_REQUIRED (below), only the pre-execution human gate is
  // gone.
  it("does not require approval for INSTAGRAM_PUBLISH — the Creative approval already gated it", () => {
    expect(ExecutionPolicy.requiresApproval("INSTAGRAM_PUBLISH")).toBe(false);
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
    expect(ExecutionPolicy.staticBrowserPurpose("GOOGLE_ADS_ANALYSIS")).toBe(
      "GOOGLE_ADS",
    );
  });

  // TikTok/LinkedIn/X now route exclusively through their own
  // IntegrationCredential-based API providers (tiktok/linkedin/x-api-provider.ts),
  // which never touch BrowserProfile — unlike INSTAGRAM_PUBLISH, which still
  // needs one because capability-router.ts's resolveBrowserProfile() runs
  // unconditionally before provider selection (see execution-policy.ts's
  // comment on BROWSER_PURPOSE_BY_CAPABILITY). Mapping these here would make
  // every approved TIKTOK_PUBLISH/LINKEDIN_PUBLISH/X_PUBLISH task fail with
  // BROWSER_PROFILE_MISMATCH, since the integrations page no longer offers
  // any way to create such a BrowserProfile row.
  it("has no static browser-purpose mapping for TikTok/LinkedIn/X publish — they're OAuth/API-only now", () => {
    expect(
      ExecutionPolicy.staticBrowserPurpose("TIKTOK_PUBLISH"),
    ).toBeUndefined();
    expect(
      ExecutionPolicy.staticBrowserPurpose("LINKEDIN_PUBLISH"),
    ).toBeUndefined();
    expect(ExecutionPolicy.staticBrowserPurpose("X_PUBLISH")).toBeUndefined();
    expect(ExecutionPolicy.requiresBrowserProfile("TIKTOK_PUBLISH")).toBe(
      false,
    );
    expect(ExecutionPolicy.requiresBrowserProfile("LINKEDIN_PUBLISH")).toBe(
      false,
    );
    expect(ExecutionPolicy.requiresBrowserProfile("X_PUBLISH")).toBe(false);
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

// GA-F7: GA yapılandırma yazması her zaman onay ister, ama doğrulama/tarayıcı hattına girmez
describe("ExecutionPolicy ANALYTICS_EDIT", () => {
  it("requires approval and is high risk", () => {
    expect(ExecutionPolicy.requiresApproval("ANALYTICS_EDIT")).toBe(true);
    expect(ExecutionPolicy.defaultRiskLevel("ANALYTICS_EDIT")).toBe("HIGH");
  });

  it("is not verification-gated and maps to no browser purpose", () => {
    expect(ExecutionPolicy.requiresVerification("ANALYTICS_EDIT")).toBe(false);
    expect(ExecutionPolicy.staticBrowserPurpose("ANALYTICS_EDIT")).toBeUndefined();
    expect(ExecutionPolicy.requiresBrowserProfile("ANALYTICS_EDIT")).toBe(false);
  });
});
