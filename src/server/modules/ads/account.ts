import "server-only";

import { prisma } from "@/lib/prisma";
import type { AdsAccountView } from "@/lib/module-flows/ads/state";
import {
  META_PROVIDER,
  type MetaAdsMetadata,
} from "@/server/integrations/meta-client";

// Whether the project can run Meta ads from the Ads Manager flow: the same
// check as hasActiveMetaAdsAccount (meta-api-provider.ts), an ACTIVE meta_ads
// connection with an ad account picked, plus the Page the ad runs as (the ad
// creative step fails without one). Metadata only: no token is read.

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export async function loadAdsAccount(
  projectId: string,
): Promise<AdsAccountView> {
  const credential = await prisma.integrationCredential.findUnique({
    where: { projectId_provider: { projectId, provider: META_PROVIDER.ads } },
    select: { status: true, metadata: true },
  });
  if (!credential || credential.status !== "ACTIVE") {
    return { status: "needs-connect" };
  }
  const metadata = (credential.metadata ?? {}) as Partial<MetaAdsMetadata>;
  const adAccountId = text(metadata.selectedAdAccountId);
  if (!adAccountId) return { status: "needs-account" };

  const account = Array.isArray(metadata.adAccounts)
    ? metadata.adAccounts.find((row) => row?.adAccountId === adAccountId)
    : undefined;
  const code = text(account?.currency)?.toUpperCase();
  const currency = code && /^[A-Z]{3}$/.test(code) ? code : undefined;
  const adAccountName =
    text(account?.adAccountName) ?? text(metadata.selectedAdAccountName);
  const base = {
    ...(currency ? { currency } : {}),
    ...(adAccountName ? { adAccountName } : {}),
  };

  const pageId = text(metadata.selectedPageId);
  const page = Array.isArray(metadata.pages)
    ? metadata.pages.find((row) => row?.pageId === pageId)
    : undefined;
  if (!pageId || !page) return { status: "needs-page", ...base };
  const pageName = text(page.pageName) ?? text(metadata.selectedPageName);
  return { status: "ready", ...base, ...(pageName ? { pageName } : {}) };
}
