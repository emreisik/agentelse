import type { DepartmentKey } from "@prisma/client";

import { DEPARTMENT_KEY, DEPARTMENT_COLOR } from "@/lib/labels";
import { cn } from "@/lib/utils";

const SIZE_CLASSES = {
  xs: { chip: "size-4.5 rounded-md", icon: "size-2.5", text: "text-xs" },
  sm: { chip: "size-6 rounded-lg", icon: "size-3.5", text: "text-sm" },
  md: { chip: "size-8 rounded-lg", icon: "size-4", text: "text-sm" },
} as const;

// The same identity EVERYWHERE a department is referenced (the "assigned to
// X team" note in chat, task cards, work plan nodes, the flow timeline...):
// an icon badge with a department-specific soft background color
// (DEPARTMENT_COLOR) + label. IDENTICAL to the canonical rendering in the
// departments panel (the DepartmentDetail header, the handoff cards in the
// tasks panel) — moved here to be shared from a single place, so plain-icon
// or plain-text renderings should NO LONGER be used.
export function DepartmentBadge({
  department,
  size = "sm",
  showLabel = true,
  className,
}: {
  department: DepartmentKey;
  size?: keyof typeof SIZE_CLASSES;
  showLabel?: boolean;
  className?: string;
}) {
  const meta = DEPARTMENT_KEY[department];
  const color = DEPARTMENT_COLOR[department];
  const Icon = meta?.icon;
  const sizing = SIZE_CLASSES[size];

  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      <span
        className={cn("flex shrink-0 items-center justify-center", sizing.chip)}
        style={{
          backgroundColor: `color-mix(in oklch, ${color} 15%, transparent)`,
          color,
        }}
      >
        {Icon ? <Icon className={sizing.icon} /> : null}
      </span>
      {showLabel ? (
        <span
          className={cn("truncate font-medium text-foreground", sizing.text)}
        >
          {meta?.label ?? department}
        </span>
      ) : null}
    </span>
  );
}
