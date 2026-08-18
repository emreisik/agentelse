import "server-only";

import type { ExecutionProvider } from "@/server/execution/types";
import { GoogleApiProvider } from "@/server/execution/providers/google/google-api-provider";
import { MetaApiProvider } from "@/server/execution/providers/meta/meta-api-provider";
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
// MetaApiProvider/GoogleApiProvider OpenClawProvider'dan önce: proje gerçek
// bir Meta/Google OAuth bağlantısına sahipse (bkz. meta-api-provider.ts ve
// google-api-provider.ts canExecute) gerçek API, tarayıcı otomasyonuna
// tercih edilir.
class ProviderRegistryImpl {
  private readonly providers: ExecutionProvider[] = [
    new MetaApiProvider(),
    new GoogleApiProvider(),
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
    // Varsayılan daima gerçek: mock sağlayıcılar yalnızca test modunda
    // görünür. Gerçek sağlayıcı yoksa iş sessizce sahte içerikle
    // "tamamlanmak" yerine açıkça başarısız olur.
    return this.providers.filter(
      (provider) => !provider.key.startsWith("mock-"),
    );
  }

  // Mod filtresinden geçmemiş ham liste — sağlık senkronizasyonu her
  // sağlayıcıyı tanımlamalı, yalnızca o an yönlendirmeye uygun olanları değil.
  registered(): readonly ExecutionProvider[] {
    return this.providers;
  }

  getByKey(key: string): ExecutionProvider | undefined {
    return this.providers.find((provider) => provider.key === key);
  }
}

export const ProviderRegistry = new ProviderRegistryImpl();
