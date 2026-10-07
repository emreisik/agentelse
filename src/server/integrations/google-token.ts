import "server-only";

import { prisma } from "@/lib/prisma";
import { decryptGoogleSecret } from "@/server/integrations/google/secret";
import {
  GoogleApiError,
  refreshGoogleAccessToken,
} from "@/server/integrations/google-client";
import {
  cachedGoogleAccessToken,
  forgetGoogleAccessTokens,
  googleAccessTokenKey,
} from "@/server/integrations/google/access-token";

// To keep google-client.ts a pure REST wrapper (same rule as
// telegram-client.ts — API clients never touch prisma), this small
// orchestration step lives in a separate file: it converts the refresh
// token into an access token, and marks the credential EXPIRED if
// invalid_grant comes back. Both google-actions.ts (manual test/refresh)
// and google-api-provider.ts (ANALYTICS_ANALYSIS task execution) share this.
// Access token'lar bellekte önbelleklenir (google/access-token.ts): bir saatlik
// token, bitişine 5 dk kalana kadar yeniden kullanılır.
export async function getFreshGoogleAccessToken(credential: {
  id: string;
  encryptedSecret: string;
}): Promise<string> {
  // Disconnect token'ı siler; koparılmış bir bağlantı kullanılamaz.
  if (!credential.encryptedSecret) {
    throw new GoogleApiError("This Google connection was removed", undefined, {
      errorClass: "AUTH",
    });
  }
  try {
    return await cachedGoogleAccessToken(
      googleAccessTokenKey(credential.id, credential.encryptedSecret),
      () => refreshGoogleAccessToken(decryptGoogleSecret(credential.encryptedSecret)),
    );
  } catch (error) {
    if (
      error instanceof GoogleApiError &&
      error.googleErrorCode === "invalid_grant"
    ) {
      forgetGoogleAccessTokens(credential.id);
      // Yalnız satır hâlâ koparılmamışsa: Disconnect edilmiş (REVOKED) bir
      // bağlantı EXPIRED'a düşüp "Needs reconnection" görünmez.
      await prisma.integrationCredential.updateMany({
        where: { id: credential.id, status: { not: "REVOKED" } },
        data: { status: "EXPIRED" },
      });
    }
    throw error;
  }
}
