import "server-only";

import { prisma } from "@/lib/prisma";
import { MetaApiError } from "@/server/integrations/meta-client";

// 190 hatası tutarlı ele alınır (docs/meta-ads-plan.md F0b): Meta token'ın
// süresinin dolduğunu ya da iptal edildiğini söylediğinde bağlantı EXPIRED
// olur, Integrations kutucuğu "Reconnect" ister ve sonraki her işlem
// "Connected" yazarken sessizce düşmez.
//
// İstisna 190/492: Sayfa token'ını türeten kişinin o Sayfada rolü kalmamıştır.
// Token geçerlidir; yalnız o Sayfaya bağlı özellik durur, bağlantı düşmez.

const PAGE_ROLE_MISSING_SUBCODE = 492;

export function isExpiredTokenError(error: unknown): boolean {
  return (
    error instanceof MetaApiError &&
    error.metaErrorCode === 190 &&
    error.metaErrorSubcode !== PAGE_ROLE_MISSING_SUBCODE
  );
}

// Hata 190 ise (492 hariç) bağlantıyı EXPIRED yapar; true döndürürse yapmıştır.
// Asla fırlatmaz: çağıranın kendi hata yolu bozulmamalı.
export async function markMetaCredentialExpiredOn(
  error: unknown,
  credentialId: string,
): Promise<boolean> {
  if (!isExpiredTokenError(error)) return false;
  try {
    const result = await prisma.integrationCredential.updateMany({
      where: { id: credentialId, status: "ACTIVE" },
      data: { status: "EXPIRED" },
    });
    return result.count === 1;
  } catch (writeError) {
    console.error(
      `[meta-credential-health] credential ${credentialId} could not be marked EXPIRED:`,
      writeError instanceof Error ? writeError.message : writeError,
    );
    return false;
  }
}
