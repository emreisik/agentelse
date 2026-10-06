import Link from "next/link";

import { cn } from "@/lib/utils";
import type {
  MeasurementSummary,
  MeasurementTone,
} from "@/lib/website-analytics/health/view-types";

// Ölçüm sağlığı puanının küçük gösterimleri (GA-F3): nokta (Marka sekmesi
// Website kartı), satır (Integrations GA diyaloğu) ve çip (Website sayfası
// başlığı). İstemci güvenli: yalnız türler, next/link ve cn içe aktarılır,
// çünkü "use client" olan Website kartı da bunu kullanır.

const DOT_TONE: Record<MeasurementTone, string> = {
  ok: "bg-emerald-500",
  warning: "bg-amber-500",
  error: "bg-rose-500",
  unknown: "bg-muted-foreground",
};

export function MeasurementDot({ tone }: { tone: MeasurementTone }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full",
        DOT_TONE[tone] ?? DOT_TONE.unknown,
      )}
    />
  );
}

function issuesText(summary: MeasurementSummary): string {
  if (summary.issues > 0) return ` · ${summary.issues} to fix`;
  return summary.score === null ? "" : " · No problems found";
}

export function MeasurementScoreLine({
  summary,
  href,
}: {
  summary: MeasurementSummary;
  href: string | null;
}) {
  return (
    <p className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
      <MeasurementDot tone={summary.tone} />
      <span>
        Measurement health {summary.label}
        {issuesText(summary)}
      </span>
      {href ? (
        <Link
          href={href}
          className="font-medium text-foreground underline-offset-2 hover:underline"
        >
          View checks
        </Link>
      ) : null}
    </p>
  );
}

export function MeasurementScoreChip({
  summary,
  href,
}: {
  summary: MeasurementSummary;
  href: string;
}) {
  return (
    <Link
      href={href}
      title="Measurement health"
      className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
    >
      <MeasurementDot tone={summary.tone} />
      Tracking {summary.label}
    </Link>
  );
}
