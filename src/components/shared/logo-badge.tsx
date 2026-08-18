import { AgentelseMark } from "@/components/shared/agentelse-mark";
import { cn } from "@/lib/utils";

const SIZE_CLASSES = {
  sm: "size-7 rounded-lg p-1",
  md: "size-9 rounded-xl p-1.5",
} as const;

// Single render point for the Agentelse mark: always inside a white badge,
// looks identical in both dark and light theme (the login page + sidebar
// header use this) — since the badge is fixed white, the mark color is
// also pinned to a fixed ink tone instead of a theme token.
export function LogoBadge({
  size = "md",
  className,
}: {
  size?: keyof typeof SIZE_CLASSES;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center bg-white ring-1 ring-black/5",
        SIZE_CLASSES[size],
        className,
      )}
    >
      <AgentelseMark className="h-full w-full text-[#0d0d0d]" />
    </span>
  );
}
