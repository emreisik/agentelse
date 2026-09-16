import "server-only";

import type { SignalCategory, SignalIntensity } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { ConstitutionService } from "@/server/agency/constitution/constitution-service";
import { signalProfileRecommendationDef } from "@/server/reasoning/prompts/signal-profile-recommendation";
import { ReasoningService } from "@/server/reasoning/reasoning-service";
import { SignalProfileRepository } from "@/server/repositories/signal-profile.repository";

export const ALL_SIGNAL_CATEGORIES: SignalCategory[] = [
  "COMPETITOR",
  "PRODUCT_LAUNCH",
  "TECHNOLOGY",
  "SEO",
  "SOCIAL_TREND",
  "PAID_ADVERTISING",
  "MEDIA",
  "CREATOR",
  "PARTNERSHIP",
  "EVENT",
  "OFFLINE",
  "CUSTOMER",
  "MARKET",
  "CULTURE",
  "PERFORMANCE",
  "OTHER",
];

const VALID_INTENSITIES = new Set([
  "VERY_HIGH",
  "HIGH",
  "MEDIUM",
  "LOW",
  "OFF",
]);

export const SignalProfileService = {
  // Recommends per-category intensities from the brand constitution
  // (spec section 8) and persists one ProjectSignalProfile row per category.
  async generateForProject(scope: {
    workspaceId: string;
    projectId: string;
    brandId: string;
  }) {
    const brand = await ConstitutionService.getBrandContext(scope.brandId);

    const { output } = await ReasoningService.run(
      signalProfileRecommendationDef,
      {
        ...scope,
        context: { brand, categories: ALL_SIGNAL_CATEGORIES },
      },
    );

    const byCategory = new Map(output.profiles.map((p) => [p.category, p]));

    // Real per-project domains, regardless of what (if anything) the LLM
    // proposed — so the COMPETITOR category's config is populated even when
    // the model has nothing to ground a source in yet (e.g. right after
    // setup, before any COMPETITOR_RESEARCH has run).
    const competitors = await prisma.competitor.findMany({
      where: { projectId: scope.projectId },
      select: { name: true, domain: true },
      take: 20,
    });
    const competitorSources = competitors
      .map((c) => c.domain ?? c.name)
      .filter((source): source is string => Boolean(source));

    return SignalProfileRepository.upsertMany(
      scope,
      ALL_SIGNAL_CATEGORIES.map((category) => {
        const recommended = byCategory.get(category);
        const intensity: SignalIntensity =
          recommended && VALID_INTENSITIES.has(recommended.intensity)
            ? recommended.intensity
            : "MEDIUM";

        const sources = new Set(recommended?.sources ?? []);
        if (category === "COMPETITOR") {
          for (const source of competitorSources) sources.add(source);
        }

        return {
          category,
          intensity,
          config: sources.size > 0 ? { sources: [...sources] } : undefined,
        };
      }),
    );
  },
};
