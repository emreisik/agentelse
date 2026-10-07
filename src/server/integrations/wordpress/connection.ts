import "server-only";

import type { CmsSite } from "@prisma/client";

import { applyMockMode } from "@/lib/seo/apply/flags";
import { prisma } from "@/lib/prisma";
import { LEGACY_KEY_ID } from "@/server/security/key-ring";

import { createWordPressClient, type WordPressClient } from "./client";
import { openWordPressSecret } from "./secret";
import { wpTransportFor, type WpTransport } from "./transport";

// WordPress bağlantısını okuyan ortak, işçi grafiğine girebilen dosya
// (tenant-context / next-auth / next/navigation içe aktarmaz). Mock ve gerçek
// kimlik bilgisi karışmasın diye mock süreç "wordpress_mock" sağlayıcısını,
// gerçek süreç "wordpress" sağlayıcısını kullanır (IntegrationCredential
// (projectId, provider) tekildir ve isMock sütunu yoktur).

export const WORDPRESS_KIND = "WORDPRESS";
export const WORDPRESS_PROVIDER = "wordpress";
export const WORDPRESS_PROVIDER_MOCK = "wordpress_mock";

export function providerFor(mock: boolean): string {
  return mock ? WORDPRESS_PROVIDER_MOCK : WORDPRESS_PROVIDER;
}

// Süreç kipine uyan CmsSite satırı (yoksa null). Başka kipin satırına dokunulmaz.
export async function loadCmsSite(
  projectId: string,
  options: { mock?: boolean } = {},
): Promise<CmsSite | null> {
  return prisma.cmsSite.findUnique({
    where: {
      projectId_kind_isMock: {
        projectId,
        kind: WORDPRESS_KIND,
        isMock: options.mock ?? applyMockMode(),
      },
    },
  });
}

function keyIdOf(metadata: unknown): string {
  if (typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)) {
    const keyId = (metadata as Record<string, unknown>).keyId;
    if (typeof keyId === "string" && keyId) return keyId;
  }
  return LEGACY_KEY_ID;
}

// Sitenin ETKİN kimlik bilgisiyle kurulmuş istemci; kimlik yoksa, iptal
// edilmişse ya da açılamıyorsa null (çağıran "bağlı değil / yeniden bağlan" der).
export async function getWordPressClientFor(
  site: CmsSite,
  deps: {
    transport?: WpTransport;
    pace?: (host: string) => Promise<void>;
  } = {},
): Promise<WordPressClient | null> {
  const credential = await prisma.integrationCredential.findUnique({
    where: {
      projectId_provider: {
        projectId: site.projectId,
        provider: providerFor(site.isMock),
      },
    },
  });
  if (!credential || credential.status !== "ACTIVE") return null;
  let credentials: { username: string; appPassword: string };
  try {
    credentials = openWordPressSecret(
      credential.encryptedSecret,
      keyIdOf(credential.metadata),
    );
  } catch {
    // Anahtar yoksa ya da kayıt bozuksa şifre açılamaz; hata metni sızdırılmaz.
    return null;
  }
  return createWordPressClient({
    origin: site.origin,
    restMode: site.restMode === "query" ? "query" : "pretty",
    credentials,
    transport: deps.transport ?? wpTransportFor(site.isMock),
    ...(deps.pace ? { pace: deps.pace } : {}),
  });
}
