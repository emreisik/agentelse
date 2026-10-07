import "server-only";

import {
  createGaAdminWriter,
  type GaAdminWriter,
} from "@/server/integrations/google-analytics/admin-write";
import { gaMockMode } from "@/server/integrations/google-analytics/data-api";
import { getFreshGoogleAccessToken } from "@/server/integrations/google-token";

import type { GaFixDeps } from "./types";

// GA-F7 uygulama/geri alma motorunun bağımlılıkları (docs/website-fixes.md).
// Mock modda token sabittir ve Google'a hiç gidilmez; yazıcı ancak token
// alındıktan sonra, ilk yazma/okuma anında kurulur.

export const GA_FIX_MOCK_TOKEN = "mock-token";

export type ResolvedGaFixDeps = {
  now: Date;
  mock: boolean;
  tokenFor: NonNullable<GaFixDeps["tokenFor"]>;
  writerFor(token: string): GaAdminWriter;
};

export function resolveGaFixDeps(deps: GaFixDeps = {}): ResolvedGaFixDeps {
  const mock = deps.mock ?? gaMockMode();
  const tokenFor: ResolvedGaFixDeps["tokenFor"] =
    deps.tokenFor ??
    (mock
      ? async () => GA_FIX_MOCK_TOKEN
      : (credential) => getFreshGoogleAccessToken(credential));
  return {
    now: deps.now ?? new Date(),
    mock,
    tokenFor,
    writerFor: (token) => deps.writer ?? createGaAdminWriter(token),
  };
}
