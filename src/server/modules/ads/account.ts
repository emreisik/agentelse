import "server-only";

import type { AdsAccountView } from "@/lib/module-flows/ads/state";
import { AdsAccounts } from "@/server/ads/accounts";

// Whether the project can run Meta ads from the Ads Manager flow: the same
// check as hasActiveMetaAdsAccount (meta-api-provider.ts), an ACTIVE meta_ads
// connection with an ad account picked, plus the Page the ad runs as (the ad
// creative step fails without one). Metadata only: no token is read.

export async function loadAdsAccount(
  projectId: string,
): Promise<AdsAccountView> {
  // The account model (src/server/ads/accounts.ts) is the one source; this
  // keeps the view the Ads flow card reads (docs/meta-ads-plan.md F1).
  const account = await AdsAccounts.resolve(projectId);
  if (account.status === "needs-connect") return { status: "needs-connect" };
  if (account.status === "needs-account") return { status: "needs-account" };
  const base = {
    ...(account.adAccountId ? { adAccountId: account.adAccountId } : {}),
    ...(account.currency ? { currency: account.currency } : {}),
    ...(account.adAccountName ? { adAccountName: account.adAccountName } : {}),
  };
  if (account.status === "needs-page") return { status: "needs-page", ...base };
  return {
    status: "ready",
    ...base,
    ...(account.pageName ? { pageName: account.pageName } : {}),
  };
}
