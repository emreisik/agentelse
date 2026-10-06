import type { CapabilityKey, CouncilType, DepartmentKey } from "@prisma/client";

// Static department registry (spec section 13). Pure module — the single
// source of truth for which department owns which capability, which council
// reviews its ideas. Every CapabilityKey must be owned by exactly ONE
// department (enforced by unit test), so DepartmentRouter.ownerOf() is total
// and unambiguous.

export type DepartmentDefinition = {
  key: DepartmentKey;
  label: string;
  ownedCapabilities: CapabilityKey[];
  councilAffinity: CouncilType;
};

export const DEPARTMENTS: Record<DepartmentKey, DepartmentDefinition> = {
  BRAND_STRATEGY: {
    key: "BRAND_STRATEGY",
    label: "Brand Strategy",
    ownedCapabilities: ["BRAND_DISCOVERY", "CLAIM_VALIDATION", "BRAND_SAFETY"],
    councilAffinity: "STRATEGY",
  },
  MARKET_INTELLIGENCE: {
    key: "MARKET_INTELLIGENCE",
    label: "Market Intelligence",
    ownedCapabilities: [
      "MARKET_RESEARCH",
      "TREND_RESEARCH",
      "WEB_RESEARCH",
      "PRODUCT_RESEARCH",
      "TECHNOLOGY_RESEARCH",
      "SIGNAL_SCAN",
    ],
    councilAffinity: "STRATEGY",
  },
  CUSTOMER_INTELLIGENCE: {
    key: "CUSTOMER_INTELLIGENCE",
    label: "Customer Intelligence",
    ownedCapabilities: ["CUSTOMER_INTELLIGENCE", "REVIEW_RESEARCH"],
    councilAffinity: "STRATEGY",
  },
  COMPETITOR_INTELLIGENCE: {
    key: "COMPETITOR_INTELLIGENCE",
    label: "Competitor Intelligence",
    ownedCapabilities: [
      "COMPETITOR_RESEARCH",
      "COMPETITOR_MONITORING",
      "COMPETITOR_CHANGE_DETECTION",
      "ADVERTISING_RESEARCH",
    ],
    councilAffinity: "STRATEGY",
  },
  CREATIVE: {
    key: "CREATIVE",
    label: "Creative",
    ownedCapabilities: ["CREATE_SOCIAL_CREATIVE", "CREATE_AD_CREATIVE"],
    councilAffinity: "CREATIVE",
  },
  ART_DIRECTION: {
    key: "ART_DIRECTION",
    label: "Art Direction",
    ownedCapabilities: ["SCREENSHOT_CAPTURE"],
    councilAffinity: "CREATIVE",
  },
  COPY_CONTENT: {
    key: "COPY_CONTENT",
    label: "Copy & Content",
    ownedCapabilities: [
      "CREATE_COPY",
      "CREATE_CAPTION",
      "CREATE_CAMPAIGN_BRIEF",
      "CREATE_CONTENT_PLAN",
      "EMAIL_DRAFT",
    ],
    councilAffinity: "CREATIVE",
  },
  SOCIAL_MEDIA: {
    key: "SOCIAL_MEDIA",
    label: "Social Media",
    ownedCapabilities: [
      "SOCIAL_RESEARCH",
      "SOCIAL_ACCOUNT_SETUP",
      "SOCIAL_PROFILE_AUDIT",
      "INSTAGRAM_PUBLISH",
      "TIKTOK_PUBLISH",
      "LINKEDIN_PUBLISH",
      "X_PUBLISH",
      "FACEBOOK_PUBLISH",
    ],
    councilAffinity: "MEDIA",
  },
  SEO: {
    key: "SEO",
    label: "SEO",
    ownedCapabilities: ["SEO_RESEARCH", "SEO_ANALYSIS", "ASO_ANALYSIS"],
    councilAffinity: "GROWTH",
  },
  PERFORMANCE_MARKETING: {
    key: "PERFORMANCE_MARKETING",
    label: "Performance Marketing",
    ownedCapabilities: [
      "META_ADS_ANALYSIS",
      "META_CAMPAIGN_CREATE",
      "META_CAMPAIGN_UPDATE",
      "META_ADSET_CREATE",
      "META_ADSET_UPDATE",
      "META_AD_CREATE",
      "META_AD_UPDATE",
      "META_SAFETY_ACTION",
      "META_LAUNCH",
      "GOOGLE_ADS_ANALYSIS",
      "GOOGLE_ADS_CAMPAIGN_CREATE",
    ],
    councilAffinity: "GROWTH",
  },
  DATA_ANALYTICS: {
    key: "DATA_ANALYTICS",
    label: "Data & Analytics",
    ownedCapabilities: [
      "ANALYTICS_ANALYSIS",
      "REPORTING",
      "DATA_EXTRACTION",
      "MEASUREMENT_CHECK",
      "VERIFY_EXTERNAL_ACTION",
    ],
    councilAffinity: "GROWTH",
  },
  GROWTH: {
    key: "GROWTH",
    label: "Growth",
    ownedCapabilities: ["WEB_BROWSING"],
    councilAffinity: "GROWTH",
  },
  PR_MEDIA: {
    key: "PR_MEDIA",
    label: "PR & Media",
    ownedCapabilities: ["MEDIA_RESEARCH", "CULTURAL_RESEARCH", "PR_OUTREACH"],
    councilAffinity: "MEDIA",
  },
  INFLUENCER_CREATOR: {
    key: "INFLUENCER_CREATOR",
    label: "Influencer & Creator",
    ownedCapabilities: ["CREATOR_RESEARCH"],
    councilAffinity: "MEDIA",
  },
  PARTNERSHIPS: {
    key: "PARTNERSHIPS",
    label: "Partnerships",
    ownedCapabilities: ["PARTNERSHIP_RESEARCH"],
    councilAffinity: "STRATEGY",
  },
  CRM_LIFECYCLE: {
    key: "CRM_LIFECYCLE",
    label: "CRM & Lifecycle",
    ownedCapabilities: ["CRM_ANALYSIS", "EMAIL_SEND"],
    councilAffinity: "GROWTH",
  },
  WEB_PRODUCT: {
    key: "WEB_PRODUCT",
    label: "Web & Product",
    ownedCapabilities: ["WEBSITE_UPDATE"],
    councilAffinity: "GROWTH",
  },
  EVENTS: {
    key: "EVENTS",
    label: "Events",
    ownedCapabilities: [],
    councilAffinity: "MEDIA",
  },
  OFFLINE_MEDIA: {
    key: "OFFLINE_MEDIA",
    label: "Offline Media",
    ownedCapabilities: [],
    councilAffinity: "MEDIA",
  },
};

export const ALL_DEPARTMENT_KEYS = Object.keys(DEPARTMENTS) as DepartmentKey[];

const OWNER_BY_CAPABILITY: Partial<Record<CapabilityKey, DepartmentKey>> = {};
for (const def of Object.values(DEPARTMENTS)) {
  for (const capability of def.ownedCapabilities) {
    OWNER_BY_CAPABILITY[capability] = def.key;
  }
}

export function ownerOfCapability(
  capability: CapabilityKey,
): DepartmentKey | undefined {
  return OWNER_BY_CAPABILITY[capability];
}
