import type { CouncilType, CreativeLens } from "@prisma/client";

import { LENS_DEFINITIONS } from "@/server/agency/ideas/creative-lenses";

// Council definitions (spec sections 22-23). Pure module. MVP: each council
// is one structured multi-perspective evaluation, not separate LLM processes.

export type CouncilDefinition = {
  type: CouncilType;
  dimensions: string[];
};

export const COUNCILS: Record<CouncilType, CouncilDefinition> = {
  STRATEGY: {
    type: "STRATEGY",
    dimensions: [
      "goalAlignment",
      "positioningFit",
      "differentiation",
      "feasibility",
      "evidence",
      "risk",
    ],
  },
  CREATIVE: {
    type: "CREATIVE",
    dimensions: [
      "originality",
      "brandFit",
      "culturalFit",
      "potentialImpact",
      "shareability",
      "mediaPotential",
      "feasibility",
      "evidence",
      "risk",
    ],
  },
  GROWTH: {
    type: "GROWTH",
    dimensions: [
      "expectedImpact",
      "measurability",
      "costEfficiency",
      "speedToLearn",
      "feasibility",
      "evidence",
      "risk",
    ],
  },
  MEDIA: {
    type: "MEDIA",
    dimensions: [
      "newsworthiness",
      "channelFit",
      "audienceReach",
      "timing",
      "feasibility",
      "evidence",
      "risk",
    ],
  },
  RISK: {
    type: "RISK",
    dimensions: [
      "brandSafety",
      "legalExposure",
      "reputationRisk",
      "operationalRisk",
      "reversibility",
    ],
  },
};

// AgencyDirector picks councils by idea type (spec section 22): the lens's
// affiliated council, plus RISK for anything externally visible.
export function pickCouncils(input: {
  lens?: CreativeLens | null;
  externallyVisible: boolean;
}): CouncilType[] {
  const primary = input.lens
    ? LENS_DEFINITIONS[input.lens].defaultCouncil
    : "STRATEGY";
  const councils: CouncilType[] = [primary];
  if (input.externallyVisible && primary !== "RISK") councils.push("RISK");
  return councils;
}
