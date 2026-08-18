import type { EnumMeta } from "@/lib/labels";
import { StatusBadge } from "@/components/shared/status-badge";

// Bir kaydın birden fazla enum alanını (status + type + level gibi) tek
// satırda özetler — panel listelerinde kart başlığının altına konur.
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
