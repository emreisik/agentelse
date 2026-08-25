import "server-only";

import { prisma } from "@/lib/prisma";
import { decryptSecret } from "@/server/security/crypto";
import {
  listMetaAdSets,
  listMetaAds,
  listMetaCampaigns,
  type MetaAdSetSummary,
  type MetaAdSummary,
  type MetaCampaignSummary,
  type MetaCredentialMetadata,
} from "@/server/integrations/meta-client";

// Read-only query layer behind the /ads page — always hits Meta live (no
// local Campaign/AdSet/Ad table), the same "fetch fresh every time" spirit
// as fetchMetaAdsInsights. Kept as its own module (not inline in the page)
// so that if this ever needs to move to a synced/cached model, only this
// file changes — callers keep the same shape.
export type MetaAdsConnectionState =
  | { status: "NOT_CONNECTED" }
  | { status: "NO_AD_ACCOUNT" }
  | { status: "READY"; accessToken: string; adAccountId: string };

async function resolveConnection(
  projectId: string,
): Promise<MetaAdsConnectionState> {
  const credential = await prisma.integrationCredential.findUnique({
    where: { projectId_provider: { projectId, provider: "meta" } },
  });
  if (!credential || credential.status !== "ACTIVE") {
    return { status: "NOT_CONNECTED" };
  }
  const metadata = (credential.metadata ?? {}) as MetaCredentialMetadata;
  if (!metadata.selectedAdAccountId) {
    return { status: "NO_AD_ACCOUNT" };
  }
  return {
    status: "READY",
    accessToken: decryptSecret(credential.encryptedSecret),
    adAccountId: metadata.selectedAdAccountId,
  };
}

type ReadyConnection = Extract<MetaAdsConnectionState, { status: "READY" }>;

// campaigns/adSets/ads all take an already-resolved connection rather than
// a projectId — resolveConnection() does a Prisma lookup + decryptSecret,
// and the /ads page needs all three of these in one render (to know which
// level of the drill-down to show), so resolving it once in the page and
// threading it through avoids doing that same lookup 2-3 times per request.
export const MetaAdsQuery = {
  resolveConnection,

  async campaigns(conn: ReadyConnection): Promise<MetaCampaignSummary[]> {
    return listMetaCampaigns({
      adAccountId: conn.adAccountId,
      accessToken: conn.accessToken,
    });
  },

  async adSets(
    conn: ReadyConnection,
    campaignId: string,
  ): Promise<MetaAdSetSummary[]> {
    return listMetaAdSets({ campaignId, accessToken: conn.accessToken });
  },

  async ads(conn: ReadyConnection, adSetId: string): Promise<MetaAdSummary[]> {
    return listMetaAds({ adSetId, accessToken: conn.accessToken });
  },
};
