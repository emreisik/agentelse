import "server-only";

import type { ExecutionProvider } from "@/server/execution/types";
import { GoogleApiProvider } from "@/server/execution/providers/google/google-api-provider";
import { MetaApiProvider } from "@/server/execution/providers/meta/meta-api-provider";
import { TikTokApiProvider } from "@/server/execution/providers/tiktok/tiktok-api-provider";
import { LinkedInApiProvider } from "@/server/execution/providers/linkedin/linkedin-api-provider";
import { XApiProvider } from "@/server/execution/providers/x/x-api-provider";
import { OpenClawProvider } from "@/server/execution/providers/openclaw/openclaw-provider";
import { OpenAiAiProvider } from "@/server/execution/providers/openai/openai-ai.provider";
import { OpenAiCreativeProvider } from "@/server/execution/providers/openai/openai-creative.provider";
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
//
// GeminiAiProvider/GeminiCreativeProvider are deliberately NOT registered
// right now — the GCP project behind GEMINI_API_KEY hit a billing dunning
// block (403 "Lightning dunning decision is deny"), so every Gemini call
// (text AND image) was failing outright, and neither gemini-ai.provider.ts
// nor gemini-creative.provider.ts has an internal fallback of its own (each
// calls its Gemini backend directly with no try/catch around it) — a single
// bad call there fails the whole task, it doesn't hand off to OpenAI. Rather
// than wait for ProviderHealthService's circuit breaker to notice (it needs
// a failure RATE within a window, not just one bad call) OpenAiAiProvider/
// OpenAiCreativeProvider are the only real text/creative providers for now.
// The 4 search-grounded research capabilities Gemini owned exclusively
// (BRAND_DISCOVERY, WEB_RESEARCH, COMPETITOR_RESEARCH, SEO_RESEARCH —
// OpenAiAiProvider deliberately doesn't claim those, OpenAI's Chat
// Completions API has no built-in web-search tool) now fall to
// OpenClawProvider, exactly the fallback this file already documented for
// "Gemini unconfigured". Once that GCP project's billing is resolved,
// re-add `new GeminiAiProvider()` and `new GeminiCreativeProvider()` before
// their OpenAI counterparts below (see the two `import`s removed above too).
class ProviderRegistryImpl {
  private readonly providers: ExecutionProvider[] = [
    new MetaApiProvider(),
    new GoogleApiProvider(),
    new TikTokApiProvider(),
    new LinkedInApiProvider(),
    new XApiProvider(),
    new OpenAiAiProvider(),
    new OpenClawProvider(),
    new OpenAiCreativeProvider(),
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
