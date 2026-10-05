import "server-only";

import { prisma } from "@/lib/prisma";
import {
  siteLabel,
  type AnalyticsSourceStates,
  type SourceState,
} from "@/lib/module-flows/analytics/catalog";
import {
  GOOGLE_PROVIDER,
  type GoogleAnalyticsMetadata,
  type GoogleSearchConsoleMetadata,
} from "@/server/integrations/google-client";
import {
  instagramLoginExpired,
  resolveInstagramTarget,
} from "@/server/integrations/instagram-target";
import {
  META_PROVIDER,
  type MetaAdsMetadata,
  type MetaInstagramMetadata,
} from "@/server/integrations/meta-client";

// The brief's live connection state of each report source (docs/modules.md
// "Analytics"). ONE credential read without the secrets; the rules are the
// readers' own: an Instagram account resolveInstagramTarget can address and
// whose login has not lapsed, an ACTIVE Meta Ads connection with an ad account
// picked (hasActiveMetaAdsAccount), an ACTIVE Google Analytics / Search Console
// connection with its property / site picked (findActiveGoogleConnections). So
// the brief never offers a source the report would then fail to read.

const ACCOUNT_MAX = 80;

export type CredentialRow = {
  provider: string;
  status: string;
  metadata: unknown;
  accountLabel: string | null;
};

const PROVIDERS = [
  META_PROVIDER.instagram,
  META_PROVIDER.ads,
  GOOGLE_PROVIDER.analytics,
  GOOGLE_PROVIDER.search_console,
] as const;

const NOT_CONNECTED: SourceState = { status: "not_connected", account: null };

function label(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, ACCOUNT_MAX) : null;
}

function metadataOf<T>(row: CredentialRow): Partial<T> {
  const value = row.metadata;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Partial<T>)
    : {};
}

// Not there, or switched off: an EXPIRED row says so, anything else is simply
// not connected. Null = there and ACTIVE, read on.
function inactive(row: CredentialRow | undefined): SourceState | null {
  if (!row) return NOT_CONNECTED;
  if (row.status === "EXPIRED") return { status: "expired", account: null };
  return row.status === "ACTIVE" ? null : NOT_CONNECTED;
}

function instagramState(
  row: CredentialRow | undefined,
  now: number,
): SourceState {
  const off = inactive(row);
  if (off) return off;
  if (!row) return NOT_CONNECTED;
  const metadata = metadataOf<MetaInstagramMetadata>(row);
  if (instagramLoginExpired(metadata, now)) {
    return { status: "expired", account: null };
  }
  const target = resolveInstagramTarget(metadata);
  if (!target) return { status: "setup", account: null };
  const username = label(target.username);
  return {
    status: "connected",
    account: username ? `@${username}` : label(row.accountLabel),
  };
}

function metaAdsState(row: CredentialRow | undefined): SourceState {
  const off = inactive(row);
  if (off) return off;
  if (!row) return NOT_CONNECTED;
  const metadata = metadataOf<MetaAdsMetadata>(row);
  if (!metadata.selectedAdAccountId) return { status: "setup", account: null };
  return {
    status: "connected",
    account: label(metadata.selectedAdAccountName) ?? label(row.accountLabel),
  };
}

function ga4State(row: CredentialRow | undefined): SourceState {
  const off = inactive(row);
  if (off) return off;
  if (!row) return NOT_CONNECTED;
  const metadata = metadataOf<GoogleAnalyticsMetadata>(row);
  if (!metadata.selectedGa4PropertyId)
    return { status: "setup", account: null };
  return {
    status: "connected",
    account: label(metadata.selectedGa4PropertyName),
  };
}

function searchConsoleState(row: CredentialRow | undefined): SourceState {
  const off = inactive(row);
  if (off) return off;
  if (!row) return NOT_CONNECTED;
  const metadata = metadataOf<GoogleSearchConsoleMetadata>(row);
  const site = metadata.selectedSearchConsoleSite;
  if (!site) return { status: "setup", account: null };
  return { status: "connected", account: label(siteLabel(site)) };
}

export function sourceStatesFrom(
  rows: readonly CredentialRow[],
  now: number,
): AnalyticsSourceStates {
  const byProvider = new Map(rows.map((row) => [row.provider, row]));
  return {
    instagram: instagramState(byProvider.get(META_PROVIDER.instagram), now),
    metaAds: metaAdsState(byProvider.get(META_PROVIDER.ads)),
    ga4: ga4State(byProvider.get(GOOGLE_PROVIDER.analytics)),
    searchConsole: searchConsoleState(
      byProvider.get(GOOGLE_PROVIDER.search_console),
    ),
  };
}

export async function loadAnalyticsSources(
  projectId: string,
  now: number = Date.now(),
): Promise<AnalyticsSourceStates> {
  const rows = await prisma.integrationCredential.findMany({
    where: { projectId, provider: { in: [...PROVIDERS] } },
    select: {
      provider: true,
      status: true,
      metadata: true,
      accountLabel: true,
    },
  });
  return sourceStatesFrom(rows, now);
}
