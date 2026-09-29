import "server-only";

import { prisma } from "@/lib/prisma";
import {
  parseColorSwatches,
  parseFontNames,
  type ColorSwatch,
} from "@/lib/color-swatches";
import { parseConstitutionPayload } from "@/server/agency/constitution/constitution-schema";

// BrandTwin (docs/brand-workspace-migration.md §7 Phase 3) is a typed READ
// COMPOSITION over the existing Brand Brain models — deliberately NOT a new
// table. BrandConstitution already is a versioned document containing
// nearly every field BrandTwin needs (identity/positioning/audiences/
// markets/products/approvedClaims/forbiddenClaims/assumptions/
// openQuestions — see constitution-synthesis.ts's ConstitutionOutputSchema)
// and already carries its own version history (@@unique([brandId,
// version])), so "versioned BrandTwin" falls out of BrandConstitution's
// versioning for free. Only two things didn't already exist anywhere:
// structured user preferences (now UserDecision) and creative memory with
// an evidence count (now BrandLearning.polarity/evidenceCount) — both
// additive, both migrated in
// prisma/migrations/20260924160000_add_user_decision_and_creative_memory/.
//
// NOTE: that migration has NOT been applied to the shared dev database yet
// (deliberately — this is a live, shared database, not disposable; see
// project memory). Until `prisma migrate deploy` runs, the
// prisma.userDecision calls below and BrandLearning's polarity/
// evidenceCount columns will 404/error against the real DB. This module is
// safe to import today; it becomes safe to CALL once the migration lands.

export type BrandTwinConfidence = "high" | "medium" | "low";

export type BrandTwinPreference = {
  id: string;
  type: string;
  scope: string;
  value: unknown;
  rawMessage: string | null;
  createdAt: string;
};

export type BrandTwinMemoryItem = { insight: string; evidenceCount: number };

export type BrandTwin = {
  brandId: string;
  projectId: string;
  name: string;
  version: number | null;
  confidence: BrandTwinConfidence;
  // Direct pass-through of the active constitution's own isMock flag — used
  // to show the "sample brand profile" badge in the UI. Distinct from
  // `confidence`, which also drops to "low" for a real brand with no
  // constitution yet; that case should NOT be labelled as demo data.
  isMock: boolean;

  identity: string | null;
  businessModel: string | null;
  positioning: string | null;
  valueProposition: string | null;
  audience: string[];
  markets: string[];
  products: string[];

  voice: { personality: string | null; toneOfVoice: string | null };
  visualDNA: {
    description: string | null;
    colors: ColorSwatch[];
    fonts: string[];
    logoAssetId: string | null;
  };

  approvedClaims: string[];
  // constitution's assumptions + openQuestions — things stated with less
  // certainty than approvedClaims/knownFacts, per the spec's "Needs
  // confirmation" framing (see brand-brain-panel.tsx's own language pass).
  unverifiedClaims: string[];
  // constitution's forbiddenClaims + negativeBrief merged — the spec's
  // "Never do this" framing.
  negativeRules: string[];

  currentFocus: {
    goalId: string;
    title: string;
    description: string | null;
  } | null;
  creativePreferences: BrandTwinPreference[];
  creativeMemory: {
    works: BrandTwinMemoryItem[];
    avoid: BrandTwinMemoryItem[];
  };

  sources: string[];
  updatedAt: string | null;
};

// Brand Core, the part of the twin that says who the brand IS (the versioned
// constitution plus dossier, visual identity and current focus), without the
// memory of what the client asked for and how past work landed. The chat agent
// gets memory separately, filtered to the message at hand (MemoryService.recall),
// so it is not handed the whole store on every turn.
export type BrandCore = Omit<BrandTwin, "creativePreferences" | "creativeMemory">;

export function brandCoreOf(twin: BrandTwin): BrandCore {
  const { creativePreferences, creativeMemory, ...core } = twin;
  void creativePreferences;
  void creativeMemory;
  return core;
}

// The one constitution version every reader agrees on. Idea generation, the
// council and the strategy read the ACTIVE version (ConstitutionService.
// getBrandContext); the twin used to read "the newest, whatever its status",
// so the chat and the pipeline could describe the same brand from different
// versions. Only when nothing is active yet (a setup that never finished
// activating one) does it fall back to the newest draft, so a brand that only
// has a draft still shows what is known instead of nothing.
async function currentConstitution(brandId: string) {
  const active = await prisma.brandConstitution.findFirst({
    where: { brandId, status: "ACTIVE" },
    orderBy: { version: "desc" },
  });
  if (active) return active;
  return prisma.brandConstitution.findFirst({
    where: { brandId },
    orderBy: { version: "desc" },
  });
}

export async function getBrandTwin(
  projectId: string,
  // memory: false skips the two memory queries and leaves creativePreferences /
  // creativeMemory empty, for callers that recall memory themselves.
  options: { memory?: boolean } = {},
): Promise<BrandTwin | null> {
  const withMemory = options.memory !== false;
  const brand = await prisma.brand.findFirst({
    where: { projectId, isDefault: true },
  });
  if (!brand) return null;

  const [
    constitution,
    dossier,
    visualIdentity,
    currentFocusGoal,
    preferences,
    learnings,
  ] = await Promise.all([
    currentConstitution(brand.id),
    prisma.brandDossier.findUnique({ where: { brandId: brand.id } }),
    prisma.brandVisualIdentity.findUnique({ where: { brandId: brand.id } }),
    prisma.projectGoal.findFirst({
      where: { projectId, status: "ACTIVE" },
      orderBy: { priority: "asc" },
    }),
    withMemory
      ? prisma.userDecision.findMany({
          where: { brandId: brand.id },
          orderBy: { createdAt: "desc" },
          take: 20,
        })
      : Promise.resolve([]),
    withMemory
      ? prisma.brandLearning.findMany({
          where: { brandId: brand.id },
          orderBy: { evidenceCount: "desc" },
          take: 40,
        })
      : Promise.resolve([]),
  ]);

  // BrandVisualIdentity (role-split primary/secondary/accent, edited via
  // the Visual Identity dialog, live-read by generation) is the real
  // source of truth for colors — BrandDossier.approvedColors never got an
  // edit UI and is a dead legacy fallback (see its own schema comment).
  // Merge role groups in display priority order and dedupe by hex so the
  // same swatch never appears twice if it's listed in more than one role.
  const visualIdentityColors = [
    ...parseColorSwatches(visualIdentity?.primaryColors),
    ...parseColorSwatches(visualIdentity?.secondaryColors),
    ...parseColorSwatches(visualIdentity?.accentColors),
  ];
  const seenHexes = new Set<string>();
  const dedupedVisualIdentityColors = visualIdentityColors.filter((c) => {
    const key = c.hex.toLowerCase();
    if (seenHexes.has(key)) return false;
    seenHexes.add(key);
    return true;
  });

  const payload = constitution
    ? safeParseConstitution(constitution.payload)
    : null;

  const confidence: BrandTwinConfidence = !constitution
    ? "low"
    : constitution.isMock
      ? "low"
      : constitution.status === "ACTIVE"
        ? "high"
        : "medium";

  return {
    brandId: brand.id,
    projectId,
    name: brand.name,
    version: constitution?.version ?? null,
    confidence,
    isMock: constitution?.isMock ?? false,

    identity: payload?.identity ?? null,
    businessModel: payload?.businessModel ?? null,
    positioning: payload?.positioning ?? null,
    valueProposition: payload?.valueProposition ?? null,
    audience: payload?.audiences ?? [],
    markets: payload?.markets ?? [],
    products: payload?.products ?? [],

    voice: {
      personality: payload?.personality ?? null,
      toneOfVoice: payload?.toneOfVoice ?? null,
    },
    visualDNA: {
      description: payload?.visualIdentity ?? null,
      colors:
        dedupedVisualIdentityColors.length > 0
          ? dedupedVisualIdentityColors
          : parseColorSwatches(dossier?.approvedColors),
      fonts: parseFontNames(dossier?.approvedFonts),
      logoAssetId: dossier?.logoAssetId ?? null,
    },

    approvedClaims: payload?.approvedClaims ?? [],
    unverifiedClaims: [
      ...(payload?.assumptions ?? []),
      ...(payload?.openQuestions ?? []),
    ],
    negativeRules: [
      ...(payload?.forbiddenClaims ?? []),
      ...(payload?.negativeBrief ?? []),
    ],

    currentFocus: currentFocusGoal
      ? {
          goalId: currentFocusGoal.id,
          title: currentFocusGoal.title,
          description: currentFocusGoal.description,
        }
      : null,
    creativePreferences: preferences.map((p) => ({
      id: p.id,
      type: p.type,
      scope: p.scope,
      value: p.value,
      rawMessage: p.rawMessage,
      createdAt: p.createdAt.toISOString(),
    })),
    creativeMemory: {
      works: learnings
        .filter((l) => l.polarity === "WORKS")
        .map((l) => ({ insight: l.insight, evidenceCount: l.evidenceCount })),
      avoid: learnings
        .filter((l) => l.polarity === "AVOID")
        .map((l) => ({ insight: l.insight, evidenceCount: l.evidenceCount })),
    },

    sources: constitution?.sourceFindingIds ?? [],
    updatedAt: constitution?.updatedAt.toISOString() ?? null,
  };
}

// The constitution payload is validated when it's written (see
// constitution-synthesis.ts / the reasoning service) — but BrandTwin reads
// it back out, and a hand-edited or pre-migration row is a real (if rare)
// possibility. Falling back to null fields is safer for a read-mostly
// summary than throwing and taking down the whole BrandTwin composition
// over one malformed section.
function safeParseConstitution(payload: unknown) {
  try {
    return parseConstitutionPayload(payload);
  } catch {
    return null;
  }
}
