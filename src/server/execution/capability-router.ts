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

    const profile = await BrowserProfileRepository.requireByPurposeInProject(
      projectId,
      purpose,
    );
    return profile.id;
  },

  // Walks the provider registry in preference order and returns the first
  // one that is configured/healthy and declares it can serve this
  // capability. Domain services call only this — never a concrete provider.
  async route(
    capability: CapabilityKey,
    context: ExecutionPolicyContext,
  ): Promise<ExecutionProvider> {
    // Devre kesici: son yarım saatte sürekli hata veren (kota bitmiş,
    // anahtarı geçersiz, erişilemeyen) sağlayıcılar atlanır ve iş varsa bir
    // sonraki sağlayıcıya gider. Sağlık okunamazsa hiçbir sağlayıcı elenmez
    // — gözlemlenebilirlik katmanı yürütmeyi engellememeli.
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
        ? `No healthy execution provider available for capability ${capability} (devre kesici: ${skipped.join(", ")})`
        : `No execution provider available for capability ${capability}`,
    );
  },
};
