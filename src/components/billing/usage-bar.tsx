import { limitLevel, usedPercent, type LimitLevel } from "@/lib/billing/catalog";

const LEVEL_COLOR: Record<LimitLevel, string> = {
  ok: "var(--ws-accent)",
  low: "var(--ws-pending)",
  out: "var(--destructive)",
};

// One allowance as a bar: how much of it is spent. Colour follows the limit
// warning (calm, running low, used up). No client code: plain markup.
export function UsageBar({
  granted,
  available,
  label,
}: {
  granted: number;
  available: number;
  label: string;
}) {
  const percent = usedPercent(granted, available);
  const level = limitLevel(granted, available);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className="h-1.5 w-full overflow-hidden rounded-full"
      style={{ background: "var(--ws-surface-2)" }}
    >
      <div
        className="h-full rounded-full"
        style={{ width: `${percent}%`, background: LEVEL_COLOR[level] }}
      />
    </div>
  );
}
