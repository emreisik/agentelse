import { cn } from "@/lib/utils";

// Compact 0..max dimension bar. Default thresholds: >=0.7 success, >=0.4
// primary, else warning. `invert` flips the color logic for risk-like
// dimensions where HIGH is bad.
export function ScoreBar({
  value,
  max = 1,
  label,
  invert = false,
  className,
}: {
  value: number | null | undefined;
  max?: number;
  label?: string;
  invert?: boolean;
  className?: string;
}) {
  const ratio =
    value === null || value === undefined
      ? null
      : Math.max(0, Math.min(1, value / max));
  const effective = ratio === null ? null : invert ? 1 - ratio : ratio;
  const fill =
    effective === null
      ? "bg-muted-foreground/30"
      : effective >= 0.7
        ? "bg-success"
        : effective >= 0.4
          ? "bg-primary"
          : "bg-warning";
  return (
    <div className={cn("min-w-0", className)}>
      {label ? (
        <div className="mb-0.5 flex items-center justify-between gap-2">
          <span className="truncate text-[10px] text-muted-foreground">
            {label}
          </span>
          <span className="text-[10px] font-medium tabular-nums">
            {ratio === null
              ? "—"
              : (value as number).toFixed(max === 1 ? 2 : 1)}
          </span>
        </div>
      ) : null}
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full transition-all", fill)}
          style={{ width: `${ratio === null ? 0 : ratio * 100}%` }}
        />
      </div>
    </div>
  );
}
