import { cn } from "@/lib/utils";
import { formatCount, formatPercent } from "@/lib/module-flows/analytics/format";
import type { GoalPace, SeoGoalMetricKey } from "@/lib/seo/reports/types";

// SEO hedefinin 13 haftalık temposu (SC-F5, docs/search-reports.md "Hedefler"):
// küçük bir hap. Hook yok; sunucuda da istemcide de çizilir. Etiket hazır
// gelir (PACE_LABEL); burada yalnız renk seçilir.

const TONE_CLASS: Record<GoalPace, string> = {
  achieved: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  on_track:
    "bg-transparent text-emerald-700 ring-1 ring-emerald-500/40 dark:text-emerald-400",
  // "Behind" daha kötüdür (aralığın tamamı hedefin altında): kırmızı; "At
  // risk" aralık hedefi kapsar: sarı (web tempo çipleriyle aynı sözlük).
  at_risk: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  behind: "bg-red-500/10 text-red-700 dark:text-red-400",
  unknown: "bg-muted text-muted-foreground",
};

export function SeoGoalPaceBadge({
  pace,
  label,
}: {
  pace: GoalPace;
  label: string;
}) {
  return (
    <span
      data-pace={pace}
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
        TONE_CLASS[pace],
      )}
    >
      {label}
    </span>
  );
}

// Yüzde birimli iki anahtar (endeksli sayfa payı, iyi CWV payı); kalanlar
// sayıdır. Birim tablosu lib/seo/reports/goals.ts'te de durur; burada yalnız
// biçimleme için iki anahtar bilinir ki bu dosya saf ve bağımsız kalsın.
const PERCENT_KEYS: readonly SeoGoalMetricKey[] = [
  "seo.indexedShare",
  "seo.cwvGoodShare",
];

export function goalValueText(
  metricKey: SeoGoalMetricKey,
  value: number | null,
): string {
  if (value === null) return "—";
  return PERCENT_KEYS.includes(metricKey)
    ? formatPercent(value)
    : formatCount(value);
}
