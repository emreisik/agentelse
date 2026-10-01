import "server-only";

import { isIntegrationConfigured } from "@/lib/env";
import type { IntakeOffer } from "@/lib/intake-offer";
import { discoveryGates } from "@/server/guided-setup/flag";
import { ReasoningService } from "@/server/reasoning/reasoning-service";

// The server's facts behind the creation screen's note and the tap's start:
// reading a website's look needs a real model (never a mock, which would put
// invented style into a real brand kit) and the OpenAI key; researching the brand
// on the web needs, on top of that, the paid-research gate of guided setup to be
// open for this workspace (GUIDED_SETUP_DISCOVERY and its caps still apply when
// the research actually starts).
export function intakeOfferFor(workspaceId: string): IntakeOffer {
  const scan = !ReasoningService.isMockMode() && isIntegrationConfigured("OPENAI");
  if (!scan) return { scan: false, research: false };
  const gates = discoveryGates(workspaceId);
  return {
    scan: true,
    research: gates.enabled && !gates.mock && gates.providerOk,
  };
}
