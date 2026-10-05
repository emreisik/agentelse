import "server-only";

import { prisma } from "@/lib/prisma";
import {
  GOOGLE_PROVIDER,
  type GoogleAnalyticsMetadata,
  type GoogleSearchConsoleMetadata,
} from "@/server/integrations/google-client";

// The project's Google integrations that can be read right now: Google
// Analytics and Search Console are separate integrations (separate OAuth
// grants, possibly different Google accounts); each counts only when it is
// ACTIVE and has its property/site selected. Shared by the ANALYTICS_ANALYSIS
// provider and the Analytics / SEO modules.
export type ActiveGoogleConnections = {
  analytics: {
    credential: { id: string; encryptedSecret: string };
    propertyId: string;
  } | null;
  searchConsole: {
    credential: { id: string; encryptedSecret: string };
    siteUrl: string;
  } | null;
};

export async function findActiveGoogleConnections(
  projectId: string,
): Promise<ActiveGoogleConnections> {
  const credentials = await prisma.integrationCredential.findMany({
    where: {
      projectId,
      provider: {
        in: [GOOGLE_PROVIDER.analytics, GOOGLE_PROVIDER.search_console],
      },
      status: "ACTIVE",
    },
  });
  const ga = credentials.find((c) => c.provider === GOOGLE_PROVIDER.analytics);
  const gsc = credentials.find(
    (c) => c.provider === GOOGLE_PROVIDER.search_console,
  );
  const propertyId = (ga?.metadata as GoogleAnalyticsMetadata | null)
    ?.selectedGa4PropertyId;
  const siteUrl = (gsc?.metadata as GoogleSearchConsoleMetadata | null)
    ?.selectedSearchConsoleSite;
  return {
    analytics: ga && propertyId ? { credential: ga, propertyId } : null,
    searchConsole: gsc && siteUrl ? { credential: gsc, siteUrl } : null,
  };
}
