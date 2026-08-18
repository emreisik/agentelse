import type { CapabilityKey } from "@prisma/client";

// Pure stage metadata for the 12-stage Setup Mode (spec section 5). The
// orchestrator owns all side effects; this module only describes the plan.

// The parallel research fan-out of DEEP_DISCOVERY (spec section 6).
// Website Research = WEB_RESEARCH; Customer Research = CUSTOMER_INTELLIGENCE.
export const DEEP_DISCOVERY_CAPABILITIES: CapabilityKey[] = [
  "BRAND_DISCOVERY",
  "WEB_RESEARCH",
  "PRODUCT_RESEARCH",
  "MARKET_RESEARCH",
  "CUSTOMER_INTELLIGENCE",
  "COMPETITOR_RESEARCH",
  "SEO_RESEARCH",
  "SOCIAL_RESEARCH",
  "MEDIA_RESEARCH",
  "CULTURAL_RESEARCH",
  "CREATOR_RESEARCH",
  "PARTNERSHIP_RESEARCH",
  "ADVERTISING_RESEARCH",
  "REVIEW_RESEARCH",
  "TECHNOLOGY_RESEARCH",
];

// Discovery completes when >=80% of research tasks are terminal and at least
// one actually completed (spec: controlled progression, not all-or-nothing).
export const DISCOVERY_COMPLETION_RATIO = 0.8;

export function discoveryResearchRequest(
  capability: CapabilityKey,
  brandName: string,
  domain?: string,
): string {
  const target = domain ? `${brandName} (${domain})` : brandName;
  return `Deep discovery ${capability.toLowerCase().replace(/_/g, " ")} for ${target}`;
}
