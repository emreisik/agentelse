import { cn } from "@/lib/utils";
import { TONE_CLASSES, type EnumMeta } from "@/lib/labels";

// The single way to render an enum status in the Agency OS UI: label
// + tone tint that works in both themes. Falls back gracefully when a status
// value has no map entry (renders the raw value, neutral tone).
export function StatusBadge({
  meta,
  fallback,
  showIcon = false,
  accentColor,
  className,
  iconClassName = "size-3",
}: {
  meta: EnumMeta | undefined;
  fallback?: string;
  showIcon?: boolean;
  // For identity channels like a department's "team color" — never changes
  // the tone's semantic status color (bg/text), it just prepends a small
  // dot. See DEPARTMENT_COLOR.
  accentColor?: string;
  className?: string;
  iconClassName?: string;
}) {
  const label = meta?.label ?? fallback ?? "—";
  const tone = meta?.tone ?? "neutral";
  const Icon = showIcon ? meta?.icon : undefined;
  return (
    <span
      className={cn(
        "inline-flex h-5 w-fit shrink-0 items-center gap-1 rounded-4xl border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        TONE_CLASSES[tone],
        className,
      )}
    >
      {accentColor ? (
        <span
          aria-hidden="true"
          className="size-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: accentColor }}
        />
      ) : null}
      {Icon ? <Icon className={iconClassName} /> : null}
      {label}
    </span>
  );
}
