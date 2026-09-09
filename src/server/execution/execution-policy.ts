import type {
  BrowserProfilePurpose,
  CapabilityKey,
  RiskLevel,
} from "@prisma/client";

// Deterministic policy layer (spec section 18: "AI must not make every
// decision freely"). AgencyDirector/CommandService consult this instead of
// letting a model decide whether something needs a human in the loop.

const APPROVAL_REQUIRED_CAPABILITIES: ReadonlySet<CapabilityKey> =
  new Set<CapabilityKey>([
    // INSTAGRAM_PUBLISH deliberately absent: publishing only ever happens
    // for a Creative that already passed its own CREATIVE_APPROVAL gate
    // (see approval-decisions.ts's auto-publish branch) — requiring a
    // SECOND approval here just re-asked the same question a human already
    // answered, and was silently never being answered (13 approved
    // creatives sat unpublished for 11+ days). Still HIGH_RISK (below) and
    // still VERIFICATION_REQUIRED — only the pre-execution human gate is
    // gone, not the risk classification or post-execution check.
    "TIKTOK_PUBLISH",
    "LINKEDIN_PUBLISH",
    "X_PUBLISH",
    "META_CAMPAIGN_CREATE",
    "META_CAMPAIGN_UPDATE",
    "META_ADSET_CREATE",
    "META_ADSET_UPDATE",
    "META_AD_CREATE",
    "META_AD_UPDATE",
    "GOOGLE_ADS_CAMPAIGN_CREATE",
    "EMAIL_SEND",
    "SOCIAL_ACCOUNT_SETUP",
    "WEBSITE_UPDATE",
    "PR_OUTREACH",
  ]);

const VERIFICATION_REQUIRED_CAPABILITIES: ReadonlySet<CapabilityKey> =
  new Set<CapabilityKey>([
    "INSTAGRAM_PUBLISH",
    "TIKTOK_PUBLISH",
    "LINKEDIN_PUBLISH",
    "X_PUBLISH",
    "META_CAMPAIGN_CREATE",
    "META_CAMPAIGN_UPDATE",
    "META_ADSET_CREATE",
    "META_ADSET_UPDATE",
    "META_AD_CREATE",
    "META_AD_UPDATE",
    "GOOGLE_ADS_CAMPAIGN_CREATE",
    "SOCIAL_ACCOUNT_SETUP",
    "WEBSITE_UPDATE",
  ]);

// Static capability -> browser purpose mapping. SOCIAL_ACCOUNT_SETUP is
// intentionally absent — the target platform only exists in the request
// payload at runtime, so callers resolve it dynamically instead.
const BROWSER_PURPOSE_BY_CAPABILITY: Partial<
  Record<CapabilityKey, BrowserProfilePurpose>
> = {
  WEB_RESEARCH: "PUBLIC_RESEARCH",
  WEB_BROWSING: "PUBLIC_RESEARCH",
  DATA_EXTRACTION: "PUBLIC_RESEARCH",
  SCREENSHOT_CAPTURE: "PUBLIC_RESEARCH",
  COMPETITOR_RESEARCH: "PUBLIC_RESEARCH",
  COMPETITOR_MONITORING: "PUBLIC_RESEARCH",
  COMPETITOR_CHANGE_DETECTION: "PUBLIC_RESEARCH",
  SOCIAL_RESEARCH: "PUBLIC_RESEARCH",
  SOCIAL_PROFILE_AUDIT: "PUBLIC_RESEARCH",
  INSTAGRAM_PUBLISH: "INSTAGRAM",
  // TIKTOK_PUBLISH/LINKEDIN_PUBLISH/X_PUBLISH deliberately NOT mapped here
  // (unlike INSTAGRAM_PUBLISH, which still needs a placeholder BrowserProfile
  // because capability-router.ts's resolveBrowserProfile() runs unconditionally
  // at ExecutionService.dispatch() time, BEFORE provider selection — see
  // execution-service.ts). TikTok/LinkedIn/X now route exclusively through
  // TikTokApiProvider/LinkedInApiProvider/XApiProvider, which resolve their
  // own IntegrationCredential directly and never touch BrowserProfile; the
  // integrations page also no longer offers any way to create a BrowserProfile
  // for these three purposes (see CATEGORIES in integrations/page.tsx). Leaving
  // them mapped here would make resolveBrowserProfile() throw
  // BROWSER_PROFILE_MISMATCH for every project the moment a submitted
  // TIKTOK_PUBLISH/LINKEDIN_PUBLISH/X_PUBLISH task gets approved, since no such
  // BrowserProfile row could ever exist.
  META_ADS_ANALYSIS: "META_ADS",
  META_CAMPAIGN_CREATE: "META_ADS",
  META_CAMPAIGN_UPDATE: "META_ADS",
  META_ADSET_CREATE: "META_ADS",
  META_ADSET_UPDATE: "META_ADS",
  META_AD_CREATE: "META_ADS",
  META_AD_UPDATE: "META_ADS",
  GOOGLE_ADS_ANALYSIS: "GOOGLE_ADS",
  GOOGLE_ADS_CAMPAIGN_CREATE: "GOOGLE_ADS",
  ANALYTICS_ANALYSIS: "GA4",
  CRM_ANALYSIS: "CRM",
  EMAIL_DRAFT: "EMAIL",
  EMAIL_SEND: "EMAIL",
  VERIFY_EXTERNAL_ACTION: "PUBLIC_RESEARCH",
};

const HIGH_RISK_CAPABILITIES: ReadonlySet<CapabilityKey> =
  new Set<CapabilityKey>([
    "INSTAGRAM_PUBLISH",
    "TIKTOK_PUBLISH",
    "LINKEDIN_PUBLISH",
    "X_PUBLISH",
    "META_CAMPAIGN_CREATE",
    "META_CAMPAIGN_UPDATE",
    "META_ADSET_CREATE",
    "META_ADSET_UPDATE",
    "META_AD_CREATE",
    "META_AD_UPDATE",
    "GOOGLE_ADS_CAMPAIGN_CREATE",
    "EMAIL_SEND",
    "SOCIAL_ACCOUNT_SETUP",
    "WEBSITE_UPDATE",
    "PR_OUTREACH",
  ]);

// These tasks have their own rich chat card (creative-loading/ready/failed —
// see IdeaChatRepository, execution-service.ts). This is the single source
// of truth that keeps the task-transition layer's (task.repository.ts)
// generic "started/completed" cards from dropping these into the chat a
// SECOND time.
const CREATIVE_CAPABILITIES: ReadonlySet<CapabilityKey> =
  new Set<CapabilityKey>(["CREATE_SOCIAL_CREATIVE", "CREATE_AD_CREATIVE"]);

export const ExecutionPolicy = {
  requiresApproval(capability: CapabilityKey): boolean {
    return APPROVAL_REQUIRED_CAPABILITIES.has(capability);
  },

  requiresVerification(capability: CapabilityKey): boolean {
    return VERIFICATION_REQUIRED_CAPABILITIES.has(capability);
  },

  isCreative(capability: CapabilityKey): boolean {
    return CREATIVE_CAPABILITIES.has(capability);
  },

  // These tasks (like creatives) also have their own rich chat card
  // ("publish-result" — see IdeaChatRepository.resolvePublishResultCard,
  // execution-service.ts) — the same exclusion pattern keeps them from
  // dropping into the chat a SECOND time via task.repository.ts's generic
  // task-result card (see publishApprovalType() in task-planner.ts — same
  // suffix test).
  isPublish(capability: CapabilityKey): boolean {
    return capability.endsWith("_PUBLISH");
  },

  defaultRiskLevel(capability: CapabilityKey): RiskLevel {
    return HIGH_RISK_CAPABILITIES.has(capability) ? "HIGH" : "LOW";
  },

  staticBrowserPurpose(
    capability: CapabilityKey,
  ): BrowserProfilePurpose | undefined {
    return BROWSER_PURPOSE_BY_CAPABILITY[capability];
  },

  requiresBrowserProfile(capability: CapabilityKey): boolean {
    return (
      capability in BROWSER_PURPOSE_BY_CAPABILITY ||
      capability === "SOCIAL_ACCOUNT_SETUP"
    );
  },
};
