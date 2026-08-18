import "server-only";

import { prisma } from "@/lib/prisma";
import { decryptSecret } from "@/server/security/crypto";
import {
  GoogleApiError,
  refreshGoogleAccessToken,
} from "@/server/integrations/google-client";

// To keep google-client.ts a pure REST wrapper (same rule as
// telegram-client.ts — API clients never touch prisma), this small
// orchestration step lives in a separate file: it converts the refresh
// token into an access token, and marks the credential EXPIRED if
// invalid_grant comes back. Both google-actions.ts (manual test/refresh)
// and google-api-provider.ts (ANALYTICS_ANALYSIS task execution) share this.
export async function getFreshGoogleAccessToken(credential: {
  id: string;
  encryptedSecret: string;
}): Promise<string> {
  try {
    const refreshToken = decryptSecret(credential.encryptedSecret);
    const { accessToken } = await refreshGoogleAccessToken(refreshToken);
    return accessToken;
  } catch (error) {
    if (
      error instanceof GoogleApiError &&
      error.googleErrorCode === "invalid_grant"
    ) {
      await prisma.integrationCredential.update({
        where: { id: credential.id },
        data: { status: "EXPIRED" },
      });
    }
    throw error;
  }
}
