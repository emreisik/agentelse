import "server-only";

import type { SignalCategory, SignalIntensity } from "@prisma/client";

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

    const byCategory = new Map(
      output.profiles.map((p) => [p.category, p.intensity]),
    );

    return SignalProfileRepository.upsertMany(
      scope,
      ALL_SIGNAL_CATEGORIES.map((category) => {
        const raw = byCategory.get(category);
        const intensity: SignalIntensity =
          raw && VALID_INTENSITIES.has(raw)
            ? (raw as SignalIntensity)
            : "MEDIUM";
        return { category, intensity };
      }),
    );
  },
};
