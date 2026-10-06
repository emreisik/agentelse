import "server-only";

import { formatMoney } from "@/lib/ads/money";
import type { DriftChange } from "@/lib/ads/mirror";
import { prisma } from "@/lib/prisma";

// Drift (docs/meta-ads-plan.md §3.2): Ads Manager'da elle yapılan değişiklik.
// Bizim AdsOperation kayıtlarımızla (bütün projelerinkiler) açıklanan
// değişiklik drift sayılmaz. Otomatik geri alma yapılmaz.

const EXPLAIN_MARGIN_MS = 10 * 60_000;

export async function explainedByOperation(
  externalId: string,
  since: Date,
): Promise<boolean> {
  const op = await prisma.adsOperation.findFirst({
    where: {
      OR: [{ targetExternalId: externalId }, { resultExternalId: externalId }],
      createdAt: { gte: new Date(since.getTime() - EXPLAIN_MARGIN_MS) },
      status: { in: ["SENT", "UNKNOWN", "SUCCEEDED", "RECONCILED"] },
    },
    select: { id: true },
  });
  return Boolean(op);
}

const FIELD_LABEL: Record<DriftChange["field"], string> = {
  configuredStatus: "Status",
  dailyBudgetMinor: "Daily budget",
  lifetimeBudgetMinor: "Total budget",
  endTime: "End date",
  spendCapMinor: "Spending limit",
  bidStrategy: "Bid strategy",
  targetingHash: "Audience",
  creativeExternalId: "Creative",
};

function valueText(
  change: DriftChange,
  value: DriftChange["from"],
  currency: string | null,
): string {
  if (value === null) return "none";
  if (
    typeof value === "number" &&
    (change.field === "dailyBudgetMinor" ||
      change.field === "lifetimeBudgetMinor" ||
      change.field === "spendCapMinor")
  ) {
    return formatMoney(value, currency);
  }
  if (change.field === "endTime" && typeof value === "string") {
    return value.slice(0, 10);
  }
  return String(value);
}

// "Daily budget: 20 TRY → 50 TRY. Audience changed."
export function describeDrift(
  changes: DriftChange[],
  currency: string | null,
): string {
  return changes
    .map((change) => {
      const label = FIELD_LABEL[change.field];
      if (change.field === "targetingHash" || change.field === "creativeExternalId") {
        return `${label} changed.`;
      }
      return `${label}: ${valueText(change, change.from, currency)} → ${valueText(change, change.to, currency)}.`;
    })
    .join(" ");
}
