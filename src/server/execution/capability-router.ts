import "server-only";

import type { BrowserProfilePurpose, CapabilityKey } from "@prisma/client";

import { AgentelseError } from "@/server/security/errors";
import { BrowserProfileRepository } from "@/server/repositories/browser-profile.repository";
import { ExecutionPolicy } from "@/server/execution/execution-policy";
import { ProviderRegistry } from "@/server/execution/provider-registry";
import { ProviderHealthService } from "@/server/observability/provider-health.service";
import type {
  ExecutionPolicyContext,
  ExecutionProvider,
} from "@/server/execution/types";

export type RoutingDecision = {
  provider: ExecutionProvider;
  browserProfileId?: string;
};

export const CapabilityRouter = {
  // Resolves which browser profile (if any) this capability needs, strictly
  // scoped to the caller's own project — this is the choke point that keeps
  // a BityPay task from ever touching a biduniq-* browser profile.
  async resolveBrowserProfile(
    capability: CapabilityKey,
    projectId: string,
    payload: unknown,
  ): Promise<string | undefined> {
    if (!ExecutionPolicy.requiresBrowserProfile(capability)) return undefined;

    let purpose = ExecutionPolicy.staticBrowserPurpose(capability);

    if (!purpose && capability === "SOCIAL_ACCOUNT_SETUP") {
      const platform = (payload as Record<string, unknown> | undefined)
        ?.platform;
      if (typeof platform !== "string") {
        throw new AgentelseError(
          "ELEMENT_NOT_FOUND",
          "SOCIAL_ACCOUNT_SETUP requires a `platform` field in the request payload",
        );
      }
      purpose = platform as BrowserProfilePurpose;
    }

    if (!purpose) return undefined;

    // Soft lookup, still strictly project-scoped: a missing profile only
    // means the browser (OpenClaw) path can't serve this capability —
    // OpenClawProvider.canExecute rejects profile-bound capabilities without
    // a browserProfileId, so route() falls through to the API providers
    // (Meta for INSTAGRAM_PUBLISH/META_*, OpenAI for CRM_ANALYSIS/
    // EMAIL_DRAFT). Throwing here used to block those API paths outright,
    // before a provider was ever consulted, and stranded the Task in QUEUED.
    const profile = await BrowserProfileRepository.findByPurposeInProject(
      projectId,
      purpose,
    );
    return profile?.id;
  },

  // Walks the provider registry in preference order and returns the first
  // one that is configured/healthy and declares it can serve this
  // capability. Domain services call only this — never a concrete provider.
  async route(
    capability: CapabilityKey,
    context: ExecutionPolicyContext,
  ): Promise<ExecutionProvider> {
    // Circuit breaker: providers that have been failing continuously over
    // the last half hour (quota exhausted, invalid key, unreachable) are
    // skipped, and if there's work, it goes to the next provider. If health
    // can't be read, no provider is excluded — the observability layer must
    // never block execution.
    const unhealthy = await ProviderHealthService.unhealthyProviderKeys().catch(
      () => new Set<string>(),
    );

    const skipped: string[] = [];
    for (const provider of ProviderRegistry.all()) {
      if (!provider.isConfigured) continue;
      if (!(await provider.canExecute(capability, context))) continue;
      if (unhealthy.has(provider.key)) {
        skipped.push(provider.key);
        continue;
      }
      return provider;
    }

    throw new AgentelseError(
      "PROVIDER_UNAVAILABLE",
      skipped.length > 0
        ? `No healthy execution provider available for capability ${capability} (circuit breaker: ${skipped.join(", ")})`
        : `No execution provider available for capability ${capability}`,
    );
  },
};
