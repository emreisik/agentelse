import "server-only";

import {
  parseGaReport,
  type GaRawReport,
} from "@/lib/website-analytics/response";
import { GoogleApiError } from "@/server/integrations/google/errors";
import { googleFetchJson } from "@/server/integrations/google/http";
import { recordGaApiOutcome } from "@/server/website-analytics/api-counters";

import { gaMockMode } from "./data-api";

// GA4 Data API runRealtimeReport (GA-F2 bölüm 2, "Right now"): son 30
// dakikanın aktif kullanıcıları. Realtime kotası çekirdek kotadan ayrıdır;
// kota yöneticisine girmez. Mock modda Google'a gidilmez. Sonuç /health
// sayaçlarına yazılır.

const DATA_BASE = "https://analyticsdata.googleapis.com/v1beta";

// Belirlenimci 2..14: aynı mülk aynı dakikada aynı sayıyı verir.
function mockActiveUsers(propertyId: string, now: Date): number {
  const minute = Math.floor(now.getTime() / 60_000);
  let hash = 2166136261;
  for (const char of `${propertyId}|${minute}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return 2 + ((hash >>> 0) % 13);
}

export async function runGaRealtimeActiveUsers(
  accessToken: string,
  propertyId: string,
): Promise<{ activeUsers: number }> {
  try {
    let activeUsers: number;
    if (gaMockMode()) {
      activeUsers = mockActiveUsers(propertyId, new Date());
    } else {
      const raw = await googleFetchJson<GaRawReport>(
        `${DATA_BASE}/properties/${encodeURIComponent(propertyId)}:runRealtimeReport`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            metrics: [{ name: "activeUsers" }],
            minuteRanges: [
              { name: "last30", startMinutesAgo: 29, endMinutesAgo: 0 },
            ],
            returnPropertyQuota: true,
          }),
        },
        { kind: "report" },
      );
      const report = parseGaReport(raw);
      activeUsers = report.rows[0]?.metrics[0] ?? 0;
    }
    recordGaApiOutcome("ok");
    return { activeUsers };
  } catch (error) {
    recordGaApiOutcome(
      error instanceof GoogleApiError ? error.errorClass : "UNKNOWN",
    );
    throw error;
  }
}
