import "server-only";

import { prisma } from "@/lib/prisma";
import {
  buildConnectedAccounts,
  type ConnectedAccount,
} from "@/lib/connected-accounts";
import { getChannelConnections } from "@/server/integrations/channel-connections";
import { META_PROVIDER } from "@/server/integrations/meta-client";

// Reads where the project's accounts stand for the right panel's "Bağlı
// hesaplar" card: Instagram, Meta Ads and the simple channels through the same
// source the plan card and the creative card use (getChannelConnections), the
// Facebook Page (the one picked in the Facebook integration, which is its own
// connection, independent of Instagram and Meta Ads), GA4 and Search Console (linked AND a property/site
// chosen), and whether the project has a website.
// Never throws into the page: on any failure the card simply has no rows.

const GOOGLE_PROVIDERS = {
  ga4: "google_analytics",
  searchConsole: "google_search_console",
} as const;

export async function loadConnectedAccounts(
  projectId: string,
  website: string | null,
): Promise<ConnectedAccount[]> {
  try {
    const [connections, credentials] = await Promise.all([
      getChannelConnections(projectId),
      prisma.integrationCredential.findMany({
        where: {
          projectId,
          provider: {
            in: [
              META_PROVIDER.instagram,
              META_PROVIDER.facebook,
              META_PROVIDER.ads,
              GOOGLE_PROVIDERS.ga4,
              GOOGLE_PROVIDERS.searchConsole,
            ],
          },
        },
        select: { provider: true, status: true, metadata: true },
      }),
    ]);

    const active = (provider: string) =>
      credentials.find(
        (credential) =>
          credential.provider === provider && credential.status === "ACTIVE",
      );
    // The Facebook Page comes from the Facebook integration only: a Page an
    // Instagram connection or an ad account happens to use is not "Facebook
    // connected".
    const facebookMeta = (active(META_PROVIDER.facebook)?.metadata ??
      null) as { selectedPageId?: string; selectedPageName?: string } | null;
    const facebookPage =
      facebookMeta?.selectedPageId !== undefined
        ? { name: facebookMeta.selectedPageName }
        : null;
    const ga4 = (active(GOOGLE_PROVIDERS.ga4)?.metadata ?? null) as {
      selectedGa4PropertyId?: string;
      selectedGa4PropertyName?: string;
    } | null;
    const searchConsole = (active(GOOGLE_PROVIDERS.searchConsole)?.metadata ??
      null) as { selectedSearchConsoleSite?: string } | null;

    return buildConnectedAccounts({
      instagram: {
        connected: connections.instagram?.connected === true,
        label: connections.instagram?.accountLabel,
      },
      facebookPage,
      metaAds: {
        connected: connections.ads?.connected === true,
        label: connections.ads?.accountLabel,
      },
      ga4: {
        linked: ga4 !== null,
        selected: Boolean(ga4?.selectedGa4PropertyId),
        label: ga4?.selectedGa4PropertyName,
      },
      searchConsole: {
        linked: searchConsole !== null,
        selected: Boolean(searchConsole?.selectedSearchConsoleSite),
        label: searchConsole?.selectedSearchConsoleSite,
      },
      website,
      others: {
        tiktok: connections.tiktok,
        linkedin: connections.linkedin,
        x: connections.x,
      },
    });
  } catch (error) {
    console.error("[connected-accounts] failed:", error);
    return [];
  }
}
