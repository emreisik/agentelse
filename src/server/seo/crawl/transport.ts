import "server-only";

import { seoMockMode } from "@/lib/seo/health-flags";
import {
  guardedTransport,
  type GuardedTransport,
} from "@/server/security/guarded-transport";

import { currentMockSiteOverrides, mockSiteTransport } from "./mock-site";

// Tarayıcının taşıyıcısı çağrı anında seçilir: mock kipinde hiçbir istek
// süreçten çıkmaz (bellek içi site, setMockSiteOverrides ile tatbikat),
// aksi hâlde korumalı gerçek taşıyıcı.
export function siteTransport(): GuardedTransport {
  if (!seoMockMode()) return guardedTransport;
  const overrides = currentMockSiteOverrides();
  return mockSiteTransport(overrides ? { overrides } : {});
}
