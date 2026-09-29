import "server-only";

import { prisma } from "@/lib/prisma";
import { languageLabel, countryLabel } from "@/lib/locales";
import { constitutionSynthesisDef } from "@/server/reasoning/prompts/constitution-synthesis";
import { ReasoningService } from "@/server/reasoning/reasoning-service";
import { BrandConstitutionRepository } from "@/server/repositories/brand-constitution.repository";
import { BrandDecisionRepository } from "@/server/repositories/brand-decision.repository";
import { BrandEvidenceRepository } from "@/server/repositories/brand-evidence.repository";
import { FindingRepository } from "@/server/repositories/finding.repository";

import {
  BrandConstitutionPayloadSchema,
  type BrandConstitutionPayload,
} from "./constitution-schema";

type BrandBrainScope = {
  workspaceId: string;
  projectId: string;
  brandId: string;
};

// The constitution LLM call already produces knownFacts/assumptions/
// approvedClaims/negativeBrief/forbiddenClaims as vetted, structured output
// (constitution-synthesis.ts) — the same content every downstream
// generation prompt already trusts via ConstitutionService.getBrandContext.
// This "promotes" it into the dedicated BrandFact/BrandAssumption/
// ApprovedClaim/NegativeBriefRule tables the Brand Brain UI reads from
// (schema.prisma's BrandFact comment: "mirrored here when facts are
// promoted") — previously never implemented, so those sections stayed
// permanently empty regardless of how many times a brand's constitution
// synthesized. Re-derived fresh from each new version (delete + recreate,
// not append) so these tables never drift from the currently-ACTIVE
// constitution or accumulate stale rows from superseded versions.
// approvedByUserId/status are deliberately left at their "not yet reviewed"
// defaults — this promotes the AI's draft, it doesn't fabricate a human
// approval that never happened.
async function promoteConstitutionToBrandBrain(
  scope: BrandBrainScope,
  payload: BrandConstitutionPayload,
  constitutionVersion: number,
): Promise<void> {
  const { brandId } = scope;
  await Promise.all([
    prisma.brandFact.deleteMany({ where: { brandId } }),
    prisma.brandAssumption.deleteMany({ where: { brandId } }),
    prisma.approvedClaim.deleteMany({ where: { brandId } }),
    prisma.negativeBriefRule.deleteMany({ where: { brandId } }),
  ]);

  const source = `Brand Constitution v${constitutionVersion}`;
  await Promise.all([
    payload.knownFacts.length > 0
      ? prisma.brandFact.createMany({
          data: payload.knownFacts.map((statement, index) => ({
            ...scope,
            category: "constitution",
            key: `known-fact-${index + 1}`,
            value: statement,
            source,
          })),
        })
      : undefined,
    payload.assumptions.length > 0
      ? prisma.brandAssumption.createMany({
          data: payload.assumptions.map((statement) => ({
            ...scope,
            statement,
          })),
        })
      : undefined,
    payload.approvedClaims.length > 0
      ? prisma.approvedClaim.createMany({
          data: payload.approvedClaims.map((claim) => ({
            ...scope,
            claim,
          })),
        })
      : undefined,
    payload.negativeBrief.length > 0 || payload.forbiddenClaims.length > 0
      ? prisma.negativeBriefRule.createMany({
          data: [
            ...payload.negativeBrief.map((rule) => ({
              ...scope,
              rule,
              category: "negative-brief",
            })),
            ...payload.forbiddenClaims.map((rule) => ({
              ...scope,
              rule,
              category: "forbidden-claim",
            })),
          ],
        })
      : undefined,
  ]);
}

export type SynthesizeInput = {
  workspaceId: string;
  projectId: string;
  brandId: string;
  brandName: string;
  domain?: string;
  description?: string;
  logoAssetIds?: string[];
};

// Synthesizes the versioned Brand Constitution from accumulated Findings
// (spec section 9). Creates the next version and activates it atomically.
export const ConstitutionService = {
  async synthesize(input: SynthesizeInput) {
    const findings = await FindingRepository.listForProject(input.projectId, {
      limit: 300,
    });
    const project = await prisma.project.findUniqueOrThrow({
      where: { id: input.projectId },
      select: { language: true, country: true },
    });

    const { output, isMock } = await ReasoningService.run(
      constitutionSynthesisDef,
      {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        brandId: input.brandId,
        context: {
          brandName: input.brandName,
          domain: input.domain,
          description: input.description,
          language: project.language,
          country: project.country,
          languageName: languageLabel(project.language),
          countryName: countryLabel(project.country),
          findings: findings.map((f) => ({
            statement: f.statement,
            classification: f.classification,
            category: f.category,
          })),
        },
      },
    );

    const payload = BrandConstitutionPayloadSchema.parse({
      ...output,
      // Known-correct codes are written instead of the model's generated
      // text — guarantees an exact match and removes the risk of the model
      // paraphrasing them.
      language: project.language,
      country: project.country,
      logoAssetIds: input.logoAssetIds ?? [],
    });

    return ConstitutionService.publishVersion({
      scope: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        brandId: input.brandId,
      },
      payload,
      isMock,
      sourceFindingIds: findings.map((f) => f.id),
      evidenceIds: findings
        .filter((f): f is typeof f & { evidenceId: string } => !!f.evidenceId)
        .map((f) => f.evidenceId),
    });
  },

  // Stores a payload as the brand's next constitution version, activates it
  // and mirrors it into the Brand Brain tables. Shared by the deep synthesis
  // above (built from stored findings) and Quick Discovery (built from the
  // brand's public pages), so both are versioned, audited and read the same
  // way. `note` only shows up in the decision log entry.
  async publishVersion(input: {
    scope: BrandBrainScope;
    payload: BrandConstitutionPayload;
    isMock: boolean;
    sourceFindingIds: string[];
    evidenceIds: string[];
    note?: string;
  }) {
    const { scope, payload, isMock } = input;

    const constitution = await BrandConstitutionRepository.createNextVersion({
      ...scope,
      payload,
      summary: payload.identity,
      sourceFindingIds: input.sourceFindingIds,
      isMock,
    });

    const activated = await BrandConstitutionRepository.activate(
      constitution.id,
      scope.brandId,
    );

    await BrandDecisionRepository.record({
      ...scope,
      topic: "Brand Constitution",
      decision: `v${activated.version} activated${input.note ? ` (${input.note})` : ""}`,
      rationale: activated.summary ?? undefined,
      decidedByType: isMock ? "AI" : "SYSTEM",
    });

    await BrandEvidenceRepository.linkMany(
      scope,
      "BRAND_CONSTITUTION",
      activated.id,
      input.evidenceIds,
    );

    await promoteConstitutionToBrandBrain(scope, payload, activated.version);

    return activated;
  },

  getActive(brandId: string) {
    return BrandConstitutionRepository.getActive(brandId);
  },

  // Compact slice used as `context.brand` in downstream reasoning calls —
  // consumed as-is (JSON.stringify'd whole) by opportunity-evaluation,
  // idea-generation and council-evaluation prompt builders, so any field
  // added here automatically reaches those LLM calls with no template
  // changes needed.
  async getBrandContext(brandId: string): Promise<Record<string, unknown>> {
    const active = await BrandConstitutionRepository.getActive(brandId);
    let base: Record<string, unknown>;
    if (active) {
      base = active.payload as Record<string, unknown>;
    } else {
      const dossier = await prisma.brandDossier.findUnique({
        where: { brandId },
      });
      base = dossier
        ? {
            identity: dossier.summary,
            positioning: dossier.positioning,
            toneOfVoice: dossier.toneOfVoice,
            language: dossier.language,
            country: dossier.country,
          }
        : {};
    }

    // Closes the loop from LearningEngine/StrategyEngine (continuous
    // resynthesis, see strategy-service.ts) back into the reasoning that
    // decides what to pursue next — previously the refreshed strategy/
    // learnings only reached the two EXECUTION-prompt capabilities via
    // context-builder.ts's `strategySummary`/`brandLearnings` fields.
    // Same query shape/limit/fields as context-builder.ts so the two paths
    // stay consistent. Additive only: existing fields above are untouched.
    const [latestStrategy, recentLearnings] = await Promise.all([
      prisma.brandStrategyVersion.findFirst({
        where: { brandId },
        orderBy: { version: "desc" },
      }),
      prisma.brandLearning.findMany({
        where: { brandId },
        orderBy: { createdAt: "desc" },
        take: 10,
        select: { insight: true, confidence: true, sourceType: true },
      }),
    ]);

    return {
      ...base,
      strategySummary: latestStrategy?.summary ?? null,
      brandLearnings: recentLearnings,
    };
  },
};
