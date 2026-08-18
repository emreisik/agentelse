import "server-only";

import type { ExecutionProvider } from "@/server/execution/types";
import { GoogleApiProvider } from "@/server/execution/providers/google/google-api-provider";
import { MetaApiProvider } from "@/server/execution/providers/meta/meta-api-provider";
import { TikTokApiProvider } from "@/server/execution/providers/tiktok/tiktok-api-provider";
import { LinkedInApiProvider } from "@/server/execution/providers/linkedin/linkedin-api-provider";
import { XApiProvider } from "@/server/execution/providers/x/x-api-provider";
import { OpenClawProvider } from "@/server/execution/providers/openclaw/openclaw-provider";
import { GeminiAiProvider } from "@/server/execution/providers/gemini/gemini-ai.provider";
import { GeminiCreativeProvider } from "@/server/execution/providers/gemini/gemini-creative.provider";
import { MockOpenClawProvider } from "@/server/execution/providers/mock/mock-openclaw.provider";
import { MockAiProvider } from "@/server/execution/providers/mock/mock-ai.provider";
import { MockCreativeProvider } from "@/server/execution/providers/mock/mock-creative.provider";
import { MockPublishingProvider } from "@/server/execution/providers/mock/mock-publishing.provider";

// Registration order is the preference order CapabilityRouter walks: real
// providers first (only usable once configured/healthy), mocks last as the
// development fallback. No domain code should import a concrete provider
// class directly — only this registry and CapabilityRouter may.
//
// MetaApiProvider/GoogleApiProvider come before OpenClawProvider: if the
// project has a real Meta/Google OAuth connection (see meta-api-provider.ts
// and google-api-provider.ts canExecute), the real API is preferred over
// browser automation.
class ProviderRegistryImpl {
  private readonly providers: ExecutionProvider[] = [
    new MetaApiProvider(),
    new GoogleApiProvider(),
    new TikTokApiProvider(),
    new LinkedInApiProvider(),
    new XApiProvider(),
    new OpenClawProvider(),
    new GeminiCreativeProvider(),
    new GeminiAiProvider(),
    new MockCreativeProvider(),
    new MockPublishingProvider(),
    new MockAiProvider(),
    new MockOpenClawProvider(),
  ];

  all(): readonly ExecutionProvider[] {
    // AGENTELSE_PROVIDER_MODE=mock forces the mock fleet regardless of
    // which real providers are configured — integration tests run against
    // the full pipeline without spending real API/OpenClaw calls.
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
