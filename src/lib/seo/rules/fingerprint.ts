import { createHash } from "node:crypto";

import type { RuleSnapshot, SeoRuleKey } from "@/lib/seo/opportunity-types";

// Bulgu parmak izi = bağ + kural + konu + dönem. Dönem haftalık kurallarda
// pencerenin Pazar'ı ("W:2026-09-27"), SO3'te son tam ay ("M:2026-08-01").
// Aynı fırsat yeni haftada yeni satırdır; eskisi SUPERSEDED olur.

export function weeklyPeriodKey(
  snapshot: Pick<RuleSnapshot, "current">,
): string {
  return `W:${snapshot.current.to}`;
}

export const MONTHLY_PERIOD_PREFIX = "M:";

export function monthlyPeriodKey(month: string): string {
  return `${MONTHLY_PERIOD_PREFIX}${month}`;
}

// Haftalık koşunun güncel dönemi: o haftanın anahtarı ve hâlâ açık aylık (SO3)
// satırlar. Ay değişince eski SO3 satırı SUPERSEDED olur; açık "M:" satırı
// her zaman güncel aydır.
export function currentPeriodFilter(weeklyKey: string): {
  OR: [{ periodKey: string }, { periodKey: { startsWith: string } }];
} {
  return {
    OR: [
      { periodKey: weeklyKey },
      { periodKey: { startsWith: MONTHLY_PERIOD_PREFIX } },
    ],
  };
}

export function seoFindingFingerprint(input: {
  linkId: string;
  ruleKey: SeoRuleKey;
  subject: string;
  periodKey: string;
}): string {
  return createHash("sha256")
    .update(
      [input.linkId, input.ruleKey, input.subject, input.periodKey].join("|"),
    )
    .digest("hex")
    .slice(0, 32);
}
