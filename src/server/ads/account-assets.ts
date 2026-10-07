import "server-only";

import { normalizeAdAccountId } from "@/lib/ads/account-id";
import { AdsAccounts } from "@/server/ads/accounts";
import { withMetaCallContext } from "@/server/integrations/meta/call-context";
import {
  readAdAccountInstagram,
  readPixelSummary,
} from "@/server/integrations/meta/sync-reads";

// Reklam hesabının Instagram kimliği ve piksel durumu (F5a, P9): Brief ve
// lansman ön kontrolü okur. Hesap başına 15 dakika süreç belleğinde tutulur;
// okunamazsa null (çağıran varsayılanla devam eder, ekran düşmez).

const TTL_MS = 15 * 60_000;

type Assets = {
  instagramUserId: string | null;
  // Profil bağlantısı için (profil ziyareti hedefi).
  instagramUsername: string | null;
  hasPixel: boolean;
  readAt: number;
};

const cache = new Map<string, Assets>();

export async function adsAccountAssets(
  projectId: string,
  now: Date = new Date(),
): Promise<Assets | null> {
  const account = await AdsAccounts.resolveWithToken(projectId).catch(() => null);
  if (!account || !("accessToken" in account) || !account.adAccountId) return null;
  const adAccountId = normalizeAdAccountId(account.adAccountId);
  const cached = cache.get(adAccountId);
  if (cached && now.getTime() - cached.readAt < TTL_MS) return cached;
  return withMetaCallContext(
    { account: adAccountId, lane: "P1_USER", callSite: "ads.assets" },
    async () => {
      const [instagram, pixel] = await Promise.allSettled([
        readAdAccountInstagram(adAccountId, account.accessToken),
        readPixelSummary(adAccountId, account.accessToken, now),
      ]);
      const assets: Assets = {
        instagramUserId:
          instagram.status === "fulfilled" ? (instagram.value[0]?.id ?? null) : null,
        instagramUsername:
          instagram.status === "fulfilled"
            ? (instagram.value[0]?.username ?? null)
            : null,
        hasPixel: pixel.status === "fulfilled" ? pixel.value.firedLast7d : false,
        readAt: now.getTime(),
      };
      cache.set(adAccountId, assets);
      return assets;
    },
  );
}

export function resetAdsAccountAssetsForTests(): void {
  cache.clear();
}
