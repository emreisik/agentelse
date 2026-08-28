"use server";

import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import { MetaAdsQuery } from "@/server/integrations/meta-ads-query";
import {
  searchMetaAdGeoLocations,
  searchMetaAdLocales,
  type MetaAdGeoLocation,
  type MetaAdLocale,
} from "@/server/integrations/meta-client";

// Bridges the client-side debounced city search (city-search-command.tsx)
// to the server-only meta-client.ts — reuses MetaAdsQuery.resolveConnection
// (the same credential/token resolution the /ads page and analysis use)
// instead of duplicating it.
export async function searchMetaCitiesAction(
  projectId: string,
  query: string,
): Promise<MetaAdGeoLocation[]> {
  if (query.trim().length < 2) return [];
  const { userId } = await requireUser();
  await requireProjectAccess(userId, projectId);

  const conn = await MetaAdsQuery.resolveConnection(projectId);
  if (conn.status !== "READY") return [];

  try {
    return await searchMetaAdGeoLocations({
      query: query.trim(),
      accessToken: conn.accessToken,
    });
  } catch {
    return [];
  }
}

// Same bridge as searchMetaCitiesAction, for locale-search-command.tsx —
// replaces the former hardcoded META_LOCALES table with a live Meta lookup
// (see searchMetaAdLocales's comment for why: Meta doesn't publish a static
// locale reference, and the table had at least one confirmed-wrong id).
export async function searchMetaLocalesAction(
  projectId: string,
  query: string,
): Promise<MetaAdLocale[]> {
  if (query.trim().length < 2) return [];
  const { userId } = await requireUser();
  await requireProjectAccess(userId, projectId);

  const conn = await MetaAdsQuery.resolveConnection(projectId);
  if (conn.status !== "READY") return [];

  try {
    return await searchMetaAdLocales({
      query: query.trim(),
      accessToken: conn.accessToken,
    });
  } catch {
    return [];
  }
}
