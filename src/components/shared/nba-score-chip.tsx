import { cn } from "@/lib/utils";

// NBA (Next Best Action) score chip — 0..1 value, tinted by strength.
export function NbaScoreChip({
  value,
  className,
}: {
  value: number | null | undefined;
  className?: string;
}) {
  if (value === null || value === undefined) return null;
  const strong = value >= 0.7;
  const mid = value >= 0.4;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-semibold tabular-nums",
        strong
          ? "bg-primary text-primary-foreground"
          : mid
            ? "bg-primary/15 text-primary"
            : "bg-muted text-muted-foreground",
        className,
      )}
      title="Next Best Action skoru"
    >
      <span className="text-[9px] font-medium opacity-80">NBA</span>
      {value.toFixed(2)}
    </span>
  );
}
