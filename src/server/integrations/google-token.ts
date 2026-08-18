import "server-only";

import { prisma } from "@/lib/prisma";
import { decryptSecret } from "@/server/security/crypto";
import {
  GoogleApiError,
  refreshGoogleAccessToken,
} from "@/server/integrations/google-client";

// google-client.ts saf bir REST sarmalayıcı olarak kalsın diye (telegram-
// client.ts ile aynı kural — API client'lar asla prisma'ya dokunmaz) bu
// küçük orkestrasyon adımı ayrı bir dosyada: refresh token'ı access token'a
// çevirir, invalid_grant gelirse kimlik bilgisini EXPIRED işaretler. Hem
// google-actions.ts (manuel test/yenileme) hem google-api-provider.ts
// (ANALYTICS_ANALYSIS görev yürütmesi) bunu paylaşır.
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
