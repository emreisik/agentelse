import "server-only";

import { getEnv, isIntegrationConfigured } from "@/lib/env";
import {
  discoveryEnabledFor,
  parseDiscoveryCaps,
  parseDiscoveryScope,
  type DiscoveryCaps,
} from "@/lib/guided-setup/contract";
import { ReasoningService } from "@/server/reasoning/reasoning-service";

// The two switches of guided setup, read at call time (no module-level cache):
// a route or action re-checks the flag itself, because an action is a public
// POST and hiding the button is not a security boundary.

// The whole feature: every route and action, the redirect param, the chip, the
// Welcome card, the "+" item, the card launcher, the agent tool and the legacy
// resolver. Off by default; only the literal "true" turns it on.
export function isGuidedSetupEnabled(): boolean {
  return getEnv().GUIDED_SETUP;
}

export type DiscoveryGates = {
  // GUIDED_SETUP is on and GUIDED_SETUP_DISCOVERY covers this workspace.
  enabled: boolean;
  // Mock reasoning mode: nothing AI-made may reach a real Brand Core, so the
  // paid step is refused (never faked).
  mock: boolean;
  // Hosted web search only exists on the OpenAI provider and needs its key:
  // anywhere else the request would silently run without search.
  providerOk: boolean;
};

// The paid "Get ideas" run: whether it may start at all. The cost caps are a
// separate check (limits.ts); this is only "is the door open for this workspace
// and would the machinery actually search".
export function discoveryGates(workspaceId: string): DiscoveryGates {
  const env = getEnv();
  return {
    enabled:
      env.GUIDED_SETUP &&
      discoveryEnabledFor(
        parseDiscoveryScope(env.GUIDED_SETUP_DISCOVERY),
        workspaceId,
      ),
    mock: ReasoningService.isMockMode(),
    providerOk:
      env.REASONING_PROVIDER === "openai" && isIntegrationConfigured("OPENAI"),
  };
}

// The run caps in force: the documented ceilings, lowered by the environment.
export function discoveryCaps(): DiscoveryCaps {
  return parseDiscoveryCaps(getEnv().GUIDED_SETUP_DISCOVERY_CAPS);
}
