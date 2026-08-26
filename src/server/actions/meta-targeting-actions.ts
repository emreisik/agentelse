"use server";

import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import { MetaAdsQuery } from "@/server/integrations/meta-ads-query";
import {
  searchMetaAdGeoLocations,
  type MetaAdGeoLocation,
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
