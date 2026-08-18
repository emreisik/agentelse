import type {
  BrowserProfilePurpose,
  CapabilityKey,
  RiskLevel,
} from "@prisma/client";

// Deterministic policy layer (spec section 18: "AI her kararı serbestçe
// vermemelidir"). AgencyDirector/CommandService consult this instead of
// letting a model decide whether something needs a human in the loop.

const APPROVAL_REQUIRED_CAPABILITIES: ReadonlySet<CapabilityKey> =
  new Set<CapabilityKey>([
    "INSTAGRAM_PUBLISH",
    "TIKTOK_PUBLISH",
    "LINKEDIN_PUBLISH",
    "X_PUBLISH",
    "META_CAMPAIGN_CREATE",
    "META_CAMPAIGN_UPDATE",
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
  TIKTOK_PUBLISH: "TIKTOK",
  LINKEDIN_PUBLISH: "LINKEDIN",
  X_PUBLISH: "X",
  META_ADS_ANALYSIS: "META_ADS",
  META_CAMPAIGN_CREATE: "META_ADS",
  META_CAMPAIGN_UPDATE: "META_ADS",
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
    "GOOGLE_ADS_CAMPAIGN_CREATE",
    "EMAIL_SEND",
    "SOCIAL_ACCOUNT_SETUP",
    "WEBSITE_UPDATE",
    "PR_OUTREACH",
  ]);

// Bu görevler kendi zengin sohbet kartına sahip (creative-loading/ready/
// failed — bkz. IdeaChatRepository, execution-service.ts). Görev geçiş
// katmanının (task.repository.ts) genel "başladı/tamamlandı" kartlarıyla
// bunları İKİNCİ kez sohbete düşürmemesi için tek kaynak burası.
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

  // Bu görevler de (kreatifler gibi) kendi zengin sohbet kartına sahip
  // ("publish-result" — bkz. IdeaChatRepository.resolvePublishResultCard,
  // execution-service.ts) — task.repository.ts'in genel task-result
  // kartıyla İKİNCİ kez sohbete düşmesin diye aynı dışlama deseni
  // (bkz. publishApprovalType() in task-planner.ts — aynı suffix testi).
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
