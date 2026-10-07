// BigQuery maliyet kalkanının saf kısmı (docs/search-agency.md): aylık sayaç
// devri, harcama kararı ve biçimleme. Beş katmanın bu dosyadaki payı: etkin
// tavan = min(ayar, sahibin sert tavanı), sorgu başına tavan ve aylık bütçe.

export type BqUsage = {
  usageMonth: string | null;
  bytesBilledMonth: number;
  queriesMonth: number;
};

// "YYYY-MM" (UTC).
export function currentUsageMonth(now: Date): string {
  return now.toISOString().slice(0, 7);
}

// Ay dönünce sayaçlar sıfırlanır.
export function rolloverUsage(usage: BqUsage, now: Date): BqUsage {
  const month = currentUsageMonth(now);
  return usage.usageMonth === month
    ? usage
    : { usageMonth: month, bytesBilledMonth: 0, queriesMonth: 0 };
}

export type SpendDecision =
  | { ok: true; maxBytesBilled: number }
  | { ok: false; reason: "OVER_QUERY_CAP" | "OVER_MONTHLY_BUDGET" };

// BigQuery en az 10 MB faturalar: tavan bu adıma yukarı yuvarlanır.
const BILLING_STEP = 10 * 1024 * 1024;

export function decideSpend(input: {
  estimateBytes: number;
  maxBytesPerQuery: number;
  monthlyBudgetBytes: number;
  usage: BqUsage;
  hardMax: number;
  hardMonthly: number;
}): SpendDecision {
  const queryCap = Math.min(input.maxBytesPerQuery, input.hardMax);
  const budget = Math.min(input.monthlyBudgetBytes, input.hardMonthly);
  if (input.estimateBytes > queryCap) {
    return { ok: false, reason: "OVER_QUERY_CAP" };
  }
  const left = budget - input.usage.bytesBilledMonth;
  if (input.estimateBytes > left) {
    return { ok: false, reason: "OVER_MONTHLY_BUDGET" };
  }
  const limit = Math.max(0, Math.min(queryCap, left));
  return {
    ok: true,
    maxBytesBilled: Math.max(
      BILLING_STEP,
      Math.ceil(limit / BILLING_STEP) * BILLING_STEP,
    ),
  };
}

export function recordSpend(usage: BqUsage, billedBytes: number): BqUsage {
  return {
    usageMonth: usage.usageMonth,
    bytesBilledMonth: usage.bytesBilledMonth + Math.max(0, billedBytes),
    queriesMonth: usage.queriesMonth + 1,
  };
}

function trimmed(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

// Ondalık birimler: "1.5 GB", "800 MB".
export function formatBytes(bytes: number): string {
  const value = Math.max(0, bytes);
  if (value >= 1e12) return `${trimmed(value / 1e12)} TB`;
  if (value >= 1e9) return `${trimmed(value / 1e9)} GB`;
  if (value >= 1e6) return `${Math.round(value / 1e6)} MB`;
  if (value >= 1e3) return `${Math.round(value / 1e3)} KB`;
  return `${Math.round(value)} B`;
}
