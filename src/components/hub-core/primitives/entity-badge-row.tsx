import type { EnumMeta } from "@/lib/labels";
import { StatusBadge } from "@/components/shared/status-badge";

// Summarizes multiple enum fields of a record (e.g. status + type + level)
// in a single row — placed under the card title in panel lists.
export function EntityBadgeRow({
  badges,
}: {
  badges: Array<{ meta: EnumMeta | undefined; fallback?: string }>;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {badges.map((badge, index) => (
        <StatusBadge key={index} meta={badge.meta} fallback={badge.fallback} />
      ))}
    </div>
  );
}
