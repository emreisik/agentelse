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
// synthesized.
//
// Re-derived from each new version, but MERGED with what a person has already
// decided, not wiped: it used to delete every row of all four tables, so a
// later version (the deep research rewriting the first-look draft) would have
// erased any claim a client had approved, any assumption they had confirmed or
// rejected, and any rule or fact added by hand. Now only the rows a previous
// promotion wrote and nobody has touched are replaced:
//  - facts: the ones this function files under the "constitution" category;
//  - assumptions: those still UNVERIFIED (CONFIRMED / REJECTED are verdicts);
//  - claims: those nobody approved (approvedByUserId is empty);
//  - rules: the two categories this function writes.
// A statement that matches a row that was kept is not written a second time.
// approvedByUserId/status are deliberately left at their "not yet reviewed"
// defaults — this promotes the AI's draft, it doesn't fabricate a human
// approval that never happened.
const PROMOTED_FACT_CATEGORY = "constitution";
const PROMOTED_RULE_CATEGORIES = ["negative-brief", "forbidden-claim"];

const normalized = (text: string) => text.trim().toLowerCase();

async function promoteConstitutionToBrandBrain(
  scope: BrandBrainScope,
  payload: BrandConstitutionPayload,
  constitutionVersion: number,
): Promise<void> {
  const { brandId } = scope;
  await Promise.all([
    prisma.brandFact.deleteMany({
      where: { brandId, category: PROMOTED_FACT_CATEGORY },
    }),
    prisma.brandAssumption.deleteMany({
      where: { brandId, status: "UNVERIFIED" },
    }),
    prisma.approvedClaim.deleteMany({
      where: { brandId, approvedByUserId: null },
    }),
    prisma.negativeBriefRule.deleteMany({
      where: { brandId, category: { in: PROMOTED_RULE_CATEGORIES } },
    }),
  ]);

  // What survived the delete above: a person's decisions and additions.
  const [keptAssumptions, keptClaims, keptRules] = await Promise.all([
    prisma.brandAssumption.findMany({
      where: { brandId },
      select: { statement: true },
    }),
    prisma.approvedClaim.findMany({
      where: { brandId },
      select: { claim: true },
    }),
    prisma.negativeBriefRule.findMany({
      where: { brandId },
      select: { rule: true },
    }),
  ]);
  const notKept = (texts: string[], kept: string[]) => {
    const taken = new Set(kept.map(normalized));
    return texts.filter((text) => !taken.has(normalized(text)));
  };
  const assumptions = notKept(
    payload.assumptions,
    keptAssumptions.map((row) => row.statement),
  );
  const claims = notKept(
    payload.approvedClaims,
    keptClaims.map((row) => row.claim),
  );
  const keptRuleTexts = keptRules.map((row) => row.rule);
  const negativeRules = notKept(payload.negativeBrief, keptRuleTexts);
  const forbiddenRules = notKept(payload.forbiddenClaims, keptRuleTexts);

  const source = `Brand Constitution v${constitutionVersion}`;
  await Promise.all([
    payload.knownFacts.length > 0
      ? prisma.brandFact.createMany({
          data: payload.knownFacts.map((statement, index) => ({
            ...scope,
            category: PROMOTED_FACT_CATEGORY,
            key: `known-fact-${index + 1}`,
            value: statement,
            source,
          })),
        })
      : undefined,
    assumptions.length > 0
      ? prisma.brandAssumption.createMany({
          data: assumptions.map((statement) => ({ ...scope, statement })),
        })
      : undefined,
    claims.length > 0
      ? prisma.approvedClaim.createMany({
          data: claims.map((claim) => ({ ...scope, claim })),
        })
      : undefined,
    negativeRules.length > 0 || forbiddenRules.length > 0
      ? prisma.negativeBriefRule.createMany({
          data: [
            ...negativeRules.map((rule) => ({
              ...scope,
              rule,
              category: "negative-brief",
            })),
            ...forbiddenRules.map((rule) => ({
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
    // A version may already exist: the first-look draft Quick Discovery wrote
    // from the brand's public pages. The research findings alone can be thin
    // (a few of the six research tasks completed), so the synthesis is handed
    // that draft to refine instead of starting from nothing and quietly
    // dropping what the first look had established.
    const previous = await BrandConstitutionRepository.getActive(
      input.brandId,
    );

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
          previousConstitution: previous?.payload ?? undefined,
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
