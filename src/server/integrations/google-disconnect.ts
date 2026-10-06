import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { decryptSecret } from "@/server/security/crypto";
import { forgetGoogleAccessTokens } from "@/server/integrations/google/access-token";
import { revokeGoogleToken } from "@/server/integrations/google/oauth";
import {
  shouldRevokeAtGoogle,
  type GoogleConnectionRef,
} from "@/server/integrations/google/revoke-policy";
import { GOOGLE_PROVIDER } from "@/server/integrations/google/services";

// Google bağlantısını koparır (GA ya da Search Console; ikisi ayrı ayrı).
// google-token.ts gibi bir düzenleme adımıdır: REST çağrısı çekirdekte, DB
// burada.
//
// - Refresh token ve Google'dan okunan metadata (mülk/site listeleri, seçim,
//   test sonuçları, hesap e-postası) HEMEN silinir; satır REVOKED olur ve
//   yalnız yeni bir OAuth bağlantısı onu geri getirebilir.
// - Google'da iptal yalnız aynı Google hesabını kullanan başka canlı Agentelse
//   bağlantısı yoksa yapılır (revoke-policy.ts). Google iptali Cloud projesi
//   düzeyinde uyguladığı için, aksi hâlde diğer entegrasyon da kopardı.

type GoogleCredentialRow = {
  id: string;
  encryptedSecret: string;
  metadata: Prisma.JsonValue | null;
};

export type GoogleDisconnectResult = {
  revokedAtGoogle: boolean;
};

function refOf(row: GoogleCredentialRow): GoogleConnectionRef {
  const metadata = (row.metadata ?? {}) as {
    googleSub?: unknown;
    connectedEmail?: unknown;
  };
  return {
    id: row.id,
    encryptedSecret: row.encryptedSecret,
    googleSub:
      typeof metadata.googleSub === "string" ? metadata.googleSub : null,
    email:
      typeof metadata.connectedEmail === "string"
        ? metadata.connectedEmail
        : null,
  };
}

async function sameAccountConnections(
  target: GoogleConnectionRef,
): Promise<GoogleConnectionRef[]> {
  const sameAccount: Prisma.IntegrationCredentialWhereInput[] = [
    { encryptedSecret: target.encryptedSecret },
  ];
  if (target.googleSub) {
    sameAccount.push({
      metadata: { path: ["googleSub"], equals: target.googleSub },
    });
  }
  if (target.email) {
    sameAccount.push({
      metadata: { path: ["connectedEmail"], equals: target.email },
    });
  }
  const rows = await prisma.integrationCredential.findMany({
    where: {
      id: { not: target.id },
      provider: {
        in: [GOOGLE_PROVIDER.analytics, GOOGLE_PROVIDER.search_console],
      },
      status: { not: "REVOKED" },
      OR: sameAccount,
    },
    select: { id: true, encryptedSecret: true, metadata: true },
  });
  return rows.map(refOf);
}

export async function disconnectGoogleCredential(
  credential: GoogleCredentialRow,
): Promise<GoogleDisconnectResult> {
  const target = refOf(credential);
  let revokedAtGoogle = false;

  if (target.encryptedSecret && (target.googleSub || target.email)) {
    const others = await sameAccountConnections(target);
    if (shouldRevokeAtGoogle(target, others)) {
      try {
        await revokeGoogleToken(decryptSecret(target.encryptedSecret));
        revokedAtGoogle = true;
      } catch (error) {
        // İptal en iyi çabadır: başarısız olsa da bizim token'ımız aşağıda
        // silinir; kullanıcı izni Google hesabından da kaldırabilir.
        console.error(
          "[google-disconnect] revoke failed:",
          error instanceof Error ? error.message : error,
        );
      }
    }
  }

  forgetGoogleAccessTokens(credential.id);
  await prisma.integrationCredential.update({
    where: { id: credential.id },
    data: {
      status: "REVOKED",
      encryptedSecret: "",
      metadata: { disconnectedAt: new Date().toISOString() },
    },
  });
  // Google Analytics ambarı (Ga*) ve Search Console ambarı (Gsc*: bağ, günlük
  // toplamlar, kırılımlar, sözlükler, haftalık/aylık özetler) bağ silinince
  // cascade ile gider; gizlilik metni "right away" der.
  await prisma.gaPropertyLink.deleteMany({
    where: { credentialId: credential.id },
  });
  await prisma.gscSiteLink.deleteMany({
    where: { credentialId: credential.id },
  });
  return { revokedAtGoogle };
}
