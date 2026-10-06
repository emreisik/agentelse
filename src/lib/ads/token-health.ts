import type { MetaTokenHealth } from "@/server/integrations/meta-client";

// Token sağlığının saf hesabı (docs/meta-ads-plan.md §3.6 Bekçiler, F1):
// debug_token sonucu + gerçekten verilmiş izinler -> kayıt. Uyarı eşikleri
// 14 / 7 / 1 gün.

export const TOKEN_WARN_DAYS = [14, 7, 1] as const;

export function tokenHealthFrom(input: {
  inspection: {
    isValid: boolean;
    expiresAt?: number;
    dataAccessExpiresAt?: number;
    granularScopes: { scope: string; target_ids?: string[] }[];
  } | null;
  granted: readonly string[];
  required: readonly string[];
  now: Date;
}): MetaTokenHealth {
  const { inspection, granted, required, now } = input;
  const missing = required.filter((scope) => !granted.includes(scope));
  const adsGrant = inspection?.granularScopes.find(
    (scope) => scope.scope === "ads_management",
  );
  return {
    checkedAt: now.toISOString(),
    isValid: inspection ? inspection.isValid : true,
    ...(inspection?.expiresAt
      ? { expiresAt: new Date(inspection.expiresAt * 1000).toISOString() }
      : {}),
    ...(inspection?.dataAccessExpiresAt
      ? {
          dataAccessExpiresAt: new Date(
            inspection.dataAccessExpiresAt * 1000,
          ).toISOString(),
        }
      : {}),
    missingScopes: missing,
    ...(adsGrant?.target_ids?.length
      ? { adAccountTargets: adsGrant.target_ids.map((id) => `act_${id}`) }
      : {}),
  };
}

// Bir sonraki uyarı eşiği (gün) ya da null: süre yoksa ya da 14 günden
// fazlaysa uyarı yok.
export function tokenWarningDays(
  health: Pick<MetaTokenHealth, "expiresAt" | "isValid"> | undefined,
  now: Date,
): number | null {
  if (!health) return null;
  if (!health.isValid) return 0;
  if (!health.expiresAt) return null;
  const days = (Date.parse(health.expiresAt) - now.getTime()) / 86_400_000;
  if (days <= 0) return 0;
  const threshold = [...TOKEN_WARN_DAYS].reverse().find((limit) => days <= limit);
  return threshold ?? null;
}
