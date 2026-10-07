import "server-only";

import type { CmsSite } from "@prisma/client";

import { applyMockMode } from "@/lib/seo/apply/flags";
import type { WordPressClient } from "@/server/integrations/wordpress/client";
import { getWordPressClientFor } from "@/server/integrations/wordpress/connection";

import type { SeoApplyDeps } from "./types";

// SC-F8 uygulama/geri alma motorunun bağımlılıkları. Mock kipinde istemci
// bellek içi sahte WordPress'e konuşur (getWordPressClientFor aktarımı kimlik
// bilgisinin sağlayıcısına göre seçer); testler istemciyi doğrudan enjekte eder.

export type ResolvedApplyDeps = {
  now: Date;
  mock: boolean;
  clientFor(site: CmsSite): Promise<WordPressClient | null>;
};

export function resolveApplyDeps(deps: SeoApplyDeps = {}): ResolvedApplyDeps {
  const injected = deps.client;
  const clientFor =
    deps.clientFor ??
    (injected
      ? async () => injected
      : (site: CmsSite) => getWordPressClientFor(site));
  return {
    now: deps.now ?? new Date(),
    mock: deps.mock ?? applyMockMode(),
    clientFor,
  };
}
