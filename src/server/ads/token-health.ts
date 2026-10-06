import "server-only";

import { tokenHealthFrom } from "@/lib/ads/token-health";
import { metaWorkExcludedHere } from "@/lib/local-worker-policy";
import { prisma } from "@/lib/prisma";
import { markMetaCredentialExpiredOn } from "@/server/integrations/meta-credential-health";
import {
  fetchMetaPermissions,
  inspectMetaToken,
  META_PROVIDER,
  requiredMetaScopes,
  type MetaService,
  type MetaTokenHealth,
} from "@/server/integrations/meta-client";
import { withMetaCallContext } from "@/server/integrations/meta/call-context";
import { decryptSecret } from "@/server/security/crypto";

// Günlük token sağlığı (docs/meta-ads-plan.md §3.6 Bekçiler, F1): Facebook
// yolu bağlantılarının (Meta Ads, Facebook, Facebook üzerinden Instagram)
// token'ı debug_token ve /me/permissions ile denetlenir. Sonuç metadata
// `tokenHealth` anahtarına yazılır (Integrations kutucuğu gösterir; F2'de
// uyarılar buradan açılır). Geçersiz token bağlantıyı EXPIRED yapar.

const CHECK_EVERY_MS = 24 * 60 * 60_000;

const SERVICE_OF: Record<string, MetaService> = {
  [META_PROVIDER.ads]: "ads",
  [META_PROVIDER.facebook]: "facebook",
  [META_PROVIDER.instagram]: "instagram",
};

export async function checkCredentialToken(
  credential: {
    id: string;
    provider: string;
    encryptedSecret: string;
  },
  now: Date = new Date(),
): Promise<MetaTokenHealth | null> {
  const service = SERVICE_OF[credential.provider];
  if (!service || !credential.encryptedSecret) return null;
  const accessToken = decryptSecret(credential.encryptedSecret);
  try {
    const [inspection, granted] = await withMetaCallContext(
      { callSite: "token-health", lane: "P2_BACKGROUND" },
      () =>
        Promise.all([inspectMetaToken(accessToken), fetchMetaPermissions(accessToken)]),
    );
    const health = tokenHealthFrom({
      inspection,
      granted,
      required: requiredMetaScopes(service),
      now,
    });
    await prisma.$executeRaw`UPDATE "IntegrationCredential" SET metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{tokenHealth}', ${JSON.stringify(health)}::jsonb) WHERE id = ${credential.id}`;
    if (!health.isValid) {
      await prisma.integrationCredential.updateMany({
        where: { id: credential.id, status: "ACTIVE" },
        data: { status: "EXPIRED" },
      });
    }
    return health;
  } catch (error) {
    // 190: token öldü — bağlantı EXPIRED; diğer hatalar ertesi güne kalır.
    await markMetaCredentialExpiredOn(error, credential.id);
    console.error(
      `[token-health] credential ${credential.id} could not be checked:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

export const MetaTokenHealthCheck = {
  // Tick adımı: kontrolü 24 saatten eski en fazla `limit` bağlantı.
  async runDue(limit = 5, now: Date = new Date()): Promise<number> {
    if (metaWorkExcludedHere(process.env)) return 0;
    const candidates = await prisma.integrationCredential.findMany({
      where: {
        provider: { in: Object.keys(SERVICE_OF) },
        status: "ACTIVE",
        // Instagram Login connections have their own host and token rules.
        NOT: { metadata: { path: ["login"], equals: "instagram" } },
      },
      select: { id: true, provider: true, encryptedSecret: true, metadata: true },
      orderBy: { updatedAt: "asc" },
      take: limit * 5,
    });
    let checked = 0;
    for (const credential of candidates) {
      if (checked >= limit) break;
      const health = (credential.metadata as { tokenHealth?: MetaTokenHealth } | null)
        ?.tokenHealth;
      if (
        health?.checkedAt &&
        now.getTime() - Date.parse(health.checkedAt) < CHECK_EVERY_MS
      ) {
        continue;
      }
      checked += 1;
      await checkCredentialToken(credential, now);
    }
    return checked;
  },
};
