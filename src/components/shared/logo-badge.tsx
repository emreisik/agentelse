import { AgentelseMark } from "@/components/shared/agentelse-mark";
import { cn } from "@/lib/utils";

const SIZE_CLASSES = {
  sm: "size-7 rounded-lg p-1",
  md: "size-9 rounded-xl p-1.5",
} as const;

// Agentelse marka amblemi için tek render noktası: her zaman beyaz bir
// rozet içinde, hem koyu hem açık temada aynı görünür (login sayfası +
// sidebar header burayı kullanır) — rozet sabit beyaz olduğu için amblem
// rengi de tema token'ı yerine sabit ink tonuna sabitleniyor.
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
