import "server-only";

import { prisma } from "@/lib/prisma";
import {
  GoogleApiError,
  listGa4Properties,
  listSearchConsoleSites,
  type GoogleAnalyticsMetadata,
  type GoogleSearchConsoleMetadata,
} from "@/server/integrations/google-client";
import type { GoogleErrorClass } from "@/server/integrations/google/error-catalog";
import {
  GOOGLE_PROVIDER,
  googleServiceForProvider,
} from "@/server/integrations/google/services";
import { getFreshGoogleAccessToken } from "@/server/integrations/google-token";

// Google bağlantılarının günlük sağlık kontrolü (docs/google-analytics-plan.md
// §3.2 "Token sağlığı"): token hâlâ geçerli mi, izin duruyor mu, seçili mülk
// ya da site hâlâ erişilebilir mi. Sorun, onu ilk fark eden zamanlanmış iş
// başarısız olmadan önce görünür. Süresi dolan token google-token.ts
// üzerinden EXPIRED olur; diğer durumlar metadata'daki `googleHealth`
// anahtarına yazılır. Seçim kendiliğinden değiştirilmez.

const HEALTH_INTERVAL_MS = 24 * 3600_000;
const DEFAULT_LIMIT = 5;

export type GoogleConnectionHealthState =
  | "OK"
  | "NEEDS_RECONNECT"
  | "NEEDS_PERMISSION"
  | "ACCESS_LOST"
  | "GONE"
  | "RATE_LIMITED"
  | "CHECK_FAILED";

export type GoogleConnectionHealthRecord = {
  state: GoogleConnectionHealthState;
  checkedAt: string;
};

type HealthMetadata = { googleHealth?: GoogleConnectionHealthRecord };

export function healthStateForErrorClass(
  errorClass: GoogleErrorClass,
): GoogleConnectionHealthState {
  switch (errorClass) {
    case "AUTH":
      return "NEEDS_RECONNECT";
    case "SCOPE_MISSING":
      return "NEEDS_PERMISSION";
    case "PERMISSION":
      return "ACCESS_LOST";
    case "NOT_FOUND":
      return "GONE";
    case "RATE_LIMIT":
    case "QUOTA_DAILY":
      return "RATE_LIMITED";
    default:
      return "CHECK_FAILED";
  }
}

export function isHealthCheckDue(
  record: GoogleConnectionHealthRecord | undefined,
  now: number,
): boolean {
  if (!record?.checkedAt) return true;
  const last = Date.parse(record.checkedAt);
  return Number.isNaN(last) || now - last >= HEALTH_INTERVAL_MS;
}

type CredentialRow = {
  id: string;
  provider: string;
  encryptedSecret: string;
  metadata: unknown;
};

async function checkConnection(
  credential: CredentialRow,
): Promise<GoogleConnectionHealthState> {
  const service = googleServiceForProvider(credential.provider);
  if (!service) return "CHECK_FAILED";
  try {
    const accessToken = await getFreshGoogleAccessToken(credential);
    // Liste okumak hem izni hem seçili mülk/site erişimini birlikte sınar.
    if (service === "analytics") {
      const selected = (credential.metadata as GoogleAnalyticsMetadata | null)
        ?.selectedGa4PropertyId;
      const properties = await listGa4Properties(accessToken);
      if (selected && !properties.some((p) => p.propertyId === selected)) {
        return "ACCESS_LOST";
      }
    } else {
      const selected = (
        credential.metadata as GoogleSearchConsoleMetadata | null
      )?.selectedSearchConsoleSite;
      const sites = await listSearchConsoleSites(accessToken);
      if (selected && !sites.some((s) => s.siteUrl === selected)) {
        return "ACCESS_LOST";
      }
    }
    return "OK";
  } catch (error) {
    return error instanceof GoogleApiError
      ? healthStateForErrorClass(error.errorClass)
      : "CHECK_FAILED";
  }
}

export const GoogleConnectionHealth = {
  async runDue(limit = DEFAULT_LIMIT, now = Date.now()): Promise<number> {
    const candidates = await prisma.integrationCredential.findMany({
      where: {
        provider: {
          in: [GOOGLE_PROVIDER.analytics, GOOGLE_PROVIDER.search_console],
        },
        status: "ACTIVE",
      },
      select: {
        id: true,
        provider: true,
        encryptedSecret: true,
        metadata: true,
      },
      orderBy: { updatedAt: "asc" },
      take: limit * 4,
    });

    let checked = 0;
    for (const credential of candidates) {
      if (checked >= limit) break;
      const record = (credential.metadata as HealthMetadata | null)
        ?.googleHealth;
      if (!isHealthCheckDue(record, now)) continue;
      checked += 1;

      const state = await checkConnection(credential);
      const health: GoogleConnectionHealthRecord = {
        state,
        checkedAt: new Date(now).toISOString(),
      };
      // Anahtar anahtar yazılır (jsonb_set): bütün nesneyi yazmak, kontrol
      // sürerken başka bir işin yazdığını geri alırdı. Koparılmış ya da
      // süresi dolmuş satıra yazılmaz.
      await prisma.$executeRaw`UPDATE "IntegrationCredential" SET metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{googleHealth}', ${JSON.stringify(health)}::jsonb) WHERE id = ${credential.id} AND status = 'ACTIVE'`;
    }
    return checked;
  },
};
