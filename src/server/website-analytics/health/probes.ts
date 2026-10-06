import "server-only";

import {
  evaluatePiiProbe,
  piiProbeRequest,
} from "@/lib/website-analytics/health/pii-probe";
import type { GaPiiProbeResult } from "@/lib/website-analytics/health/types";
import { runGaRealtimeActiveUsers } from "@/server/integrations/google-analytics/realtime";
import type { GaSyncContext } from "@/server/website-analytics/sync/context";
import { runGaRequests } from "@/server/website-analytics/sync/requests";

// GA-F3'ün iki Google çağrısı (docs/measurement-health.md): MH12 PII
// yoklaması (tek runReport, kota yöneticisi altında, kanal ctx.lane: zamanlı
// turda P2, 'I fixed it' ile P1) ve MH1_RT realtime ölçümü. Google'ın filtreyi
// reddetmesi (VALIDATION) "error" sonucudur; kota ertelemesi (GaQuotaDeferred)
// ve diğer Google hataları (GoogleApiError) çağırana yükselir.

export async function runPiiProbe(
  ctx: GaSyncContext,
  input: { from: string; to: string; forced: boolean },
): Promise<GaPiiProbeResult> {
  const at = ctx.now.toISOString();
  const [outcome] = await runGaRequests(
    ctx,
    [piiProbeRequest(input.from, input.to)],
    ctx.lane,
  );
  if (!outcome || !outcome.ok) {
    return {
      v: 1,
      at,
      from: input.from,
      to: input.to,
      forced: input.forced,
      outcome: "error",
      pages: 0,
      views: 0,
      params: [],
      email: false,
      phone: false,
    };
  }
  return evaluatePiiProbe(outcome.report, {
    at,
    from: input.from,
    to: input.to,
    forced: input.forced,
  });
}

export async function runRealtimeProbe(
  accessToken: string,
  propertyId: string,
): Promise<number> {
  const { activeUsers } = await runGaRealtimeActiveUsers(
    accessToken,
    propertyId,
  );
  return activeUsers;
}
