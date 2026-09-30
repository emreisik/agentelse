import { describe, expect, it } from "vitest";
import { z } from "zod";

import { constitutionSynthesisDef } from "./prompts/constitution-synthesis";
import { opportunityEvaluationDef } from "./prompts/opportunity-evaluation";
import { researchExtractionDef } from "./prompts/research-extraction";
import { councilEvaluationDef } from "./prompts/council-evaluation";
import { learningExtractionDef } from "./prompts/learning-extraction";
import { insightSynthesisDef } from "./prompts/insight-synthesis";
import { baselineAuditDef } from "./prompts/baseline-audit";
import { signalRelevanceDef } from "./prompts/signal-relevance";
import { goalGenerationDef } from "./prompts/goal-generation";
import { departmentRecommendationDef } from "./prompts/department-recommendation";
import { signalProfileRecommendationDef } from "./prompts/signal-profile-recommendation";
import { chatTurnDef } from "./prompts/chat-turn";
import { instagramStyleDef } from "./prompts/instagram-style";
import { strategySynthesisDef } from "./prompts/strategy-synthesis";
import { metaCampaignBriefDef } from "./prompts/meta-campaign-brief";
import { quickDiscoveryDef } from "./prompts/quick-discovery";

// reasoning-service.ts calls z.toJSONSchema(def.schema) on EVERY real
// (non-mock) call, before the model is ever reached — a schema containing a
// bare `.transform()` (no matching `.pipe()` giving it a declared output
// type) makes this throw "Transforms cannot be represented in JSON Schema"
// unconditionally, failing every real call for that def. This bit
// constitution-synthesis/research-extraction/department-recommendation/
// signal-profile-recommendation/instagram-style in production — real calls
// (isMock:false) failed for ~26 hours, undetected, until this was found via
// a live-log audit (2026-09-08). One test per def keeps this from silently
// recurring the next time someone adds a `.transform()`.
const DEFS: Record<string, { schema: z.ZodType }> = {
  constitutionSynthesisDef,
  opportunityEvaluationDef,
  researchExtractionDef,
  councilEvaluationDef,
  learningExtractionDef,
  insightSynthesisDef,
  baselineAuditDef,
  signalRelevanceDef,
  goalGenerationDef,
  departmentRecommendationDef,
  signalProfileRecommendationDef,
  chatTurnDef,
  instagramStyleDef,
  strategySynthesisDef,
  metaCampaignBriefDef,
  quickDiscoveryDef,
};

describe("reasoning def schemas are representable as JSON Schema", () => {
  for (const [name, def] of Object.entries(DEFS)) {
    it(`${name}.schema survives z.toJSONSchema()`, () => {
      expect(() => z.toJSONSchema(def.schema)).not.toThrow();
    });
  }
});
