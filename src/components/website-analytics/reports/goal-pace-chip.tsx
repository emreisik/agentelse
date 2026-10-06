import { cn } from "@/lib/utils";
import { formatMetric } from "@/lib/module-flows/analytics/format";
import { dayLabel } from "@/lib/website-analytics/reports/copy";
import type { GoalPaceChipView } from "@/lib/website-analytics/reports/types";

// web.* hedefinin bu ayki temposu (GA-F5, docs/website-reports.md): küçük bir
// hap ve isteğe bağlı ayrıntı satırı. Hook yok: sunucuda da istemcide de
// çizilir. Sayılar hazır gelir (okuma anında hedefin güncel değeriyle
// hesaplanmış görünüm); burada yalnız biçimlenir.

const TONE_CLASS: Record<GoalPaceChipView["tone"], string> = {
  good: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  warn: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  bad: "bg-red-500/10 text-red-700 dark:text-red-400",
  neutral: "bg-muted text-muted-foreground",
};

function money(view: GoalPaceChipView, value: number): string {
  return formatMetric(view.format, value, view.currency);
}

// "October 2026 so far: 4,120 of 9,000 · forecast 8,400 (7,900–8,900)"
export function paceDetailText(view: GoalPaceChipView): string {
  let text = `${view.monthLabel} so far: ${money(view, view.monthToDate)}`;
  if (view.target !== null) text += ` of ${money(view, view.target)}`;
  if (view.forecast !== null) {
    text += ` · forecast ${money(view, view.forecast)}`;
    if (view.low !== null && view.high !== null) {
      text += ` (${money(view, view.low)}–${money(view, view.high)})`;
    }
  }
  return text;
}

// Yalnız hap: rapor kartlarındaki hedef satırları da bunu kullanır.
export function PacePill({
  pace,
  label,
  tone,
}: {
  pace: GoalPaceChipView["pace"];
  label: string;
  tone: GoalPaceChipView["tone"];
}) {
  return (
    <span
      data-pace={pace}
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
        TONE_CLASS[tone],
      )}
    >
      {label}
    </span>
  );
}

export function GoalPaceChip({
  view,
  detailed,
}: {
  view: GoalPaceChipView;
  detailed?: boolean;
}) {
  const pill = <PacePill pace={view.pace} label={view.label} tone={view.tone} />;
  if (!detailed) return pill;
  return (
    <div className="space-y-1">
      {pill}
      <p className="text-xs text-muted-foreground">{paceDetailText(view)}</p>
      <p className="text-[11px] text-muted-foreground">
        Data through {dayLabel(view.through)}
      </p>
    </div>
  );
}
