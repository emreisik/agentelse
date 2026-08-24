import { cn } from "@/lib/utils";

const SIZE_CLASSES = {
  sm: "size-7 rounded-lg p-1",
  md: "size-9 rounded-xl p-1.5",
} as const;

// Single render point for the Agentelse logo: always inside a white badge,
// looks identical in both dark and light theme (the login page + sidebar
// header use this).
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
      <img
        src="/agentelse.png"
        alt="Agentelse"
        className="h-full w-full object-contain"
      />
    </span>
  );
}
