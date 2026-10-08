import {
  ConnectedAccountsCard,
} from "@/components/workspace/brand-overview-cards";
import { InstagramOverviewCard } from "@/components/workspace/instagram-overview-card";
import { AdsOverviewCard } from "@/components/workspace/ads-overview-card";
import { WebsiteOverviewCard } from "@/components/workspace/website-overview-card";
import { SearchOverviewCard } from "@/components/search-analytics/search-overview-card";
import { GaFlags } from "@/lib/website-analytics/flags";
import type { ConnectedAccount } from "@/lib/connected-accounts";

// The Brand tab: where the accounts stand (a row of icons), then the numbers
// of each connected channel (Instagram, Meta Ads, Website, Search Console).
// The brand's own profile, kit and strategy live in Brand Brain, not here.
export function BrandSummaryPanel({
  projectId,
  connections = [],
  searchOverview = false,
}: {
  projectId: string;
  // Where the project's accounts stand (Bağlı hesaplar), read by the page.
  connections?: ConnectedAccount[];
  // GSC_SYNC sunucuda okunur: kapalıyken kart ve isteği hiç yok.
  searchOverview?: boolean;
}) {
  return (
    <div className="flex flex-col gap-3 px-4 py-4 text-sm">
      <ConnectedAccountsCard projectId={projectId} accounts={connections} />

      {connections.some(
        (account) => account.key === "instagram" && account.state === "connected",
      ) ? (
        <InstagramOverviewCard projectId={projectId} />
      ) : null}

      {/* Meta Ads (K22): yalnız ayna açıkken ve hesap senkronlandıysa görünür. */}
      {connections.some(
        (account) => account.key === "meta-ads" && account.state === "connected",
      ) ? (
        <AdsOverviewCard projectId={projectId} />
      ) : null}

      {/* Website (GA-F2): Google Analytics ambarından son 28 gün. */}
      {GaFlags.sync() &&
      GaFlags.websitePage() &&
      GaFlags.brandCard() &&
      connections.some(
        (account) => account.key === "ga4" && account.state === "connected",
      ) ? (
        <WebsiteOverviewCard projectId={projectId} />
      ) : null}

      {/* Search Console (SC-F2): yalnız ambar açıkken ve senkron başladıysa görünür. */}
      {searchOverview &&
      connections.some(
        (account) =>
          account.key === "search-console" && account.state === "connected",
      ) ? (
        <SearchOverviewCard projectId={projectId} />
      ) : null}
    </div>
  );
}
