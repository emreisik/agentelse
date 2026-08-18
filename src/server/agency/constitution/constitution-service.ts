import "server-only";

import { prisma } from "@/lib/prisma";
import { languageLabel, countryLabel } from "@/lib/locales";
import { constitutionSynthesisDef } from "@/server/reasoning/prompts/constitution-synthesis";
import { ReasoningService } from "@/server/reasoning/reasoning-service";
import { BrandConstitutionRepository } from "@/server/repositories/brand-constitution.repository";
import { FindingRepository } from "@/server/repositories/finding.repository";

import { BrandConstitutionPayloadSchema } from "./constitution-schema";

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
      // Modelin ürettiği metin yerine bilinen doğru kodlar yazılır — kesin
      // eşleşme garantisi verir, model parafraz riskini ortadan kaldırır.
      language: project.language,
      country: project.country,
      logoAssetIds: input.logoAssetIds ?? [],
    });

    const constitution = await BrandConstitutionRepository.createNextVersion({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      brandId: input.brandId,
      payload,
      summary: payload.identity,
      sourceFindingIds: findings.map((f) => f.id),
      isMock,
    });

    return BrandConstitutionRepository.activate(constitution.id, input.brandId);
  },

  getActive(brandId: string) {
    return BrandConstitutionRepository.getActive(brandId);
  },

  // Compact slice used as `context.brand` in downstream reasoning calls.
  async getBrandContext(brandId: string): Promise<Record<string, unknown>> {
    const active = await BrandConstitutionRepository.getActive(brandId);
    if (active) return active.payload as Record<string, unknown>;
    const dossier = await prisma.brandDossier.findUnique({
      where: { brandId },
    });
    return dossier
      ? {
          identity: dossier.summary,
          positioning: dossier.positioning,
          toneOfVoice: dossier.toneOfVoice,
          language: dossier.language,
          country: dossier.country,
        }
      : {};
  },
};
