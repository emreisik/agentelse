import "server-only";

import type { ExecutionProvider } from "@/server/execution/types";
import { GoogleApiProvider } from "@/server/execution/providers/google/google-api-provider";
import { MetaApiProvider } from "@/server/execution/providers/meta/meta-api-provider";
import { TikTokApiProvider } from "@/server/execution/providers/tiktok/tiktok-api-provider";
import { LinkedInApiProvider } from "@/server/execution/providers/linkedin/linkedin-api-provider";
import { XApiProvider } from "@/server/execution/providers/x/x-api-provider";
import { OpenAiAiProvider } from "@/server/execution/providers/openai/openai-ai.provider";
import { OpenAiCreativeProvider } from "@/server/execution/providers/openai/openai-creative.provider";
import { MockResearchProvider } from "@/server/execution/providers/mock/mock-research.provider";
import { MockAiProvider } from "@/server/execution/providers/mock/mock-ai.provider";
import { MockCreativeProvider } from "@/server/execution/providers/mock/mock-creative.provider";
import { MockPublishingProvider } from "@/server/execution/providers/mock/mock-publishing.provider";

// Registration order is the preference order CapabilityRouter walks: real
// providers first (only usable once configured/healthy), mocks last as the
// development fallback. No domain code should import a concrete provider
// class directly — only this registry and CapabilityRouter may.
//
// OpenAiAiProvider and OpenAiCreativeProvider are the only real text/creative
// providers. OpenAiAiProvider also serves the public-web research family via
// OpenAI's hosted web_search (see its OWNED_CAPABILITIES). Browser-only
// capabilities (SOCIAL_ACCOUNT_SETUP, SOCIAL_PROFILE_AUDIT, SIGNAL_SCAN,
// MEASUREMENT_CHECK, ...) have no real provider since the browser-agent
// integration was removed: CapabilityRouter.route() throws PROVIDER_UNAVAILABLE
// for them.
class ProviderRegistryImpl {
  private readonly providers: ExecutionProvider[] = [
    new MetaApiProvider(),
    new GoogleApiProvider(),
    new TikTokApiProvider(),
    new LinkedInApiProvider(),
    new XApiProvider(),
    new OpenAiAiProvider(),
    new OpenAiCreativeProvider(),
    new MockCreativeProvider(),
    new MockPublishingProvider(),
    new MockAiProvider(),
    new MockResearchProvider(),
  ];

  all(): readonly ExecutionProvider[] {
    // AGENTELSE_PROVIDER_MODE=mock forces the mock fleet regardless of
    // which real providers are configured — integration tests run against
    // the full pipeline without spending real API calls.
    if (process.env.AGENTELSE_PROVIDER_MODE === "mock") {
      return this.providers.filter((provider) =>
        provider.key.startsWith("mock-"),
      );
    }
    // Default is always real: mock providers are only visible in test mode.
    // If no real provider is available, the job fails explicitly instead of
    // silently "completing" with fake content.
    return this.providers.filter(
      (provider) => !provider.key.startsWith("mock-"),
    );
  }

  // Raw list that hasn't passed through the mode filter — health sync must
  // know about every provider, not just the ones currently eligible for routing.
  registered(): readonly ExecutionProvider[] {
    return this.providers;
  }

  getByKey(key: string): ExecutionProvider | undefined {
    return this.providers.find((provider) => provider.key === key);
  }
}

export const ProviderRegistry = new ProviderRegistryImpl();
