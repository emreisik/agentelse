import type { CapabilityKey } from "@prisma/client";

// Which slice of the full Brand Brain bundle a capability is allowed to see.
// Spec section 36: "Don't hand over the entire project database" — every
// capability gets exactly the fields it needs, nothing more. Unlisted
// capabilities fall back to CORE_FIELDS only.
export type ContextField =
  | "language"
  | "country"
  | "brandFacts"
  | "positioning"
  | "targetAudiences"
  | "visualGuidelines"
  | "approvedColors"
  | "approvedFonts"
  | "logoAssetId"
  | "darkLogoAssetId"
  | "products"
  | "services"
  | "toneOfVoice"
  // Structured BrandVisualIdentity data — see brand-style-context.ts. Kept
  // separate from the legacy visualGuidelines/approvedColors/approvedFonts
  // fields above (still read as-is for brands with no BrandVisualIdentity
  // row) rather than replacing them.
  | "visualIdentity"
  | "approvedClaims"
  | "negativeBrief"
  | "recentApprovedCreatives"
  | "competitors"
  | "strategySummary"
  | "brandConstitution"
  | "brandLearnings";

// Every capability now also sees the ACTIVE Brand Constitution summary and
// the most recent learnings — the Agency OS feedback loop into execution.
const CORE_FIELDS: readonly ContextField[] = [
  "language",
  "country",
  "positioning",
  "toneOfVoice",
  "brandConstitution",
  "brandLearnings",
];

const CAPABILITY_CONTEXT_FIELDS: Partial<
  Record<CapabilityKey, readonly ContextField[]>
> = {
  CREATE_SOCIAL_CREATIVE: [
    "positioning",
    "toneOfVoice",
    "visualGuidelines",
    "approvedColors",
    "approvedFonts",
    "logoAssetId",
    "darkLogoAssetId",
    "visualIdentity",
    "products",
    "approvedClaims",
    "negativeBrief",
    "recentApprovedCreatives",
  ],
  CREATE_AD_CREATIVE: [
    "positioning",
    "toneOfVoice",
    "visualGuidelines",
    "approvedColors",
    "approvedFonts",
    "logoAssetId",
    "darkLogoAssetId",
    "visualIdentity",
    "products",
    "approvedClaims",
    "negativeBrief",
    "targetAudiences",
  ],
  CREATE_COPY: [
    "positioning",
    "toneOfVoice",
    "products",
    "approvedClaims",
    "negativeBrief",
  ],
  CREATE_CAPTION: [
    "positioning",
    "toneOfVoice",
    "negativeBrief",
    "recentApprovedCreatives",
  ],
  CREATE_CAMPAIGN_BRIEF: [
    "positioning",
    "targetAudiences",
    "products",
    "strategySummary",
  ],
  CREATE_CONTENT_PLAN: [
    "positioning",
    "toneOfVoice",
    "products",
    "strategySummary",
  ],
  BRAND_DISCOVERY: [
    "brandFacts",
    "positioning",
    "targetAudiences",
    "products",
    "services",
  ],
  COMPETITOR_RESEARCH: ["positioning", "competitors"],
  COMPETITOR_MONITORING: ["competitors"],
  // Lets the OpenClaw agent's prompt (buildTaskPrompt in
  // openclaw-provider.ts) mention known competitors by name/domain instead
  // of scanning blind — see signal-universe.ts's runDueScans.
  SIGNAL_SCAN: ["competitors"],
  SOCIAL_ACCOUNT_SETUP: ["positioning", "toneOfVoice", "visualGuidelines"],
  CLAIM_VALIDATION: ["approvedClaims", "negativeBrief"],
  BRAND_SAFETY: ["negativeBrief", "approvedClaims"],
};

export const ContextPolicy = {
  fieldsFor(capability: CapabilityKey): readonly ContextField[] {
    // CORE_FIELDS (including language/country) is added to every capability
    // — if a capability-specific list exists, it's merged with that,
    // otherwise CORE_FIELDS is used on its own.
    return [
      ...new Set([
        ...CORE_FIELDS,
        ...(CAPABILITY_CONTEXT_FIELDS[capability] ?? []),
      ]),
    ];
  },
};
