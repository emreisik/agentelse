import type { CapabilityKey } from "@prisma/client";

// Shared deterministic mock research payloads. Research-capability results
// carry a structured `findings` array (and `signals` for SIGNAL_SCAN) in the
// exact shape ResultMaterializer consumes, derived ONLY from the request
// input — never hardcoded brand content — so setup/loop tests exercise real
// data flow (spec: "Do not use hardcoded Biduniq results").

export type MockFinding = {
  statement: string;
  classification:
    | "VERIFIED_FACT"
    | "LIKELY_FACT"
    | "ASSUMPTION"
    | "RECOMMENDATION"
    | "UNKNOWN";
  category: string;
  confidence: number;
  sourceUrl?: string;
};

export type MockSignal = {
  title: string;
  summary: string;
  category: string;
  source: string;
  reliability: number;
};

const RESEARCH_CATEGORY_BY_CAPABILITY: Partial<Record<CapabilityKey, string>> =
  {
    BRAND_DISCOVERY: "brand",
    WEB_RESEARCH: "website",
    PRODUCT_RESEARCH: "product",
    MARKET_RESEARCH: "market",
    TREND_RESEARCH: "market",
    CUSTOMER_INTELLIGENCE: "customer",
    COMPETITOR_RESEARCH: "competitor",
    COMPETITOR_MONITORING: "competitor",
    SEO_RESEARCH: "seo",
    SEO_ANALYSIS: "seo",
    SOCIAL_RESEARCH: "social",
    SOCIAL_PROFILE_AUDIT: "social",
    MEDIA_RESEARCH: "media",
    CULTURAL_RESEARCH: "culture",
    CREATOR_RESEARCH: "creator",
    PARTNERSHIP_RESEARCH: "partnership",
    ADVERTISING_RESEARCH: "advertising",
    REVIEW_RESEARCH: "customer",
    TECHNOLOGY_RESEARCH: "technology",
  };

export function isResearchCapability(capability: CapabilityKey): boolean {
  return capability in RESEARCH_CATEGORY_BY_CAPABILITY;
}

function extractBrandHints(payload: unknown): {
  name: string;
  domain: string;
} {
  const input = (payload ?? {}) as Record<string, unknown>;
  const brandContext = (input.brandContext ?? {}) as Record<string, unknown>;
  const request = String(input.request ?? "");
  const name =
    String(
      brandContext.brandName ??
        brandContext.name ??
        (brandContext.dossier as Record<string, unknown> | undefined)
          ?.summary ??
        "",
    ).slice(0, 60) ||
    request.slice(0, 60) ||
    "target brand";
  const domainMatch = request.match(/([a-z0-9-]+\.[a-z]{2,})/i);
  const domain = domainMatch?.[1] ?? "unknown.example";
  return { name, domain };
}

export function buildMockResearchFindings(
  capability: CapabilityKey,
  payload: unknown,
): MockFinding[] {
  const category = RESEARCH_CATEGORY_BY_CAPABILITY[capability] ?? "general";
  const { name, domain } = extractBrandHints(payload);

  return [
    {
      statement: `${name}: ${category} research located primary source at ${domain}`,
      classification: "VERIFIED_FACT",
      category,
      confidence: 0.9,
      sourceUrl: `https://${domain}`,
    },
    {
      statement: `${name}: notable ${category} pattern inferred from public materials`,
      classification: "LIKELY_FACT",
      category,
      confidence: 0.7,
      sourceUrl: `https://${domain}`,
    },
    {
      statement: `${name}: ${category} position assumed pending direct confirmation`,
      classification: "ASSUMPTION",
      category,
      confidence: 0.5,
    },
    {
      statement: `${name}: recommended follow-up in ${category} area`,
      classification: "RECOMMENDATION",
      category,
      confidence: 0.6,
    },
  ];
}

export function buildMockScanSignals(payload: unknown): MockSignal[] {
  const input = (payload ?? {}) as Record<string, unknown>;
  const category = String(input.signalCategory ?? "MARKET");
  const { name } = extractBrandHints(payload);
  return [
    {
      title: `Mock ${category} signal observed for ${name}`,
      summary: `Scan of ${category.toLowerCase()} sources surfaced one item relevant to ${name}`,
      category,
      source: `mock-scan:${category.toLowerCase()}`,
      reliability: 0.6,
    },
  ];
}
