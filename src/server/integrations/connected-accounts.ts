import "server-only";

import { prisma } from "@/lib/prisma";
import {
  buildConnectedAccounts,
  type ConnectedAccount,
} from "@/lib/connected-accounts";
import { getChannelConnections } from "@/server/integrations/channel-connections";
import {
  META_PROVIDER,
  type MetaInstagramMetadata,
} from "@/server/integrations/meta-client";

// Reads where the project's accounts stand for the right panel's "Bağlı
// hesaplar" card: Instagram, Meta Ads and the simple channels through the same
// source the plan card and the creative card use (getChannelConnections), the
// Facebook Page linked through the Instagram connection, GA4 and Search Console
// (linked AND a property/site chosen), and whether the project has a website.
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
    const meta = (active(META_PROVIDER.instagram)?.metadata ??
      null) as Partial<MetaInstagramMetadata> | null;
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
      // The Page picked when Instagram was connected: Instagram publishing
      // goes through a Facebook Page, so having one selected is the Page being
      // linked.
      facebookPage:
        meta?.selectedPageId !== undefined
          ? { name: meta.selectedPageName }
          : null,
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
