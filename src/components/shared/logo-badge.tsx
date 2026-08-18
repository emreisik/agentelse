import Image from "next/image";

import { cn } from "@/lib/utils";

const SIZE_CLASSES = {
  sm: "size-7 rounded-lg p-1",
  md: "size-9 rounded-xl p-1.5",
} as const;

// Gerçek marka amblemi (public/logo.png — beyaz zeminli, lacivert H düğümü)
// için tek render noktası: her zaman beyaz bir rozet içinde, hem koyu hem
// açık temada aynı görünür (login sayfası + sidebar header burayı kullanır).
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
      <Image
        src="/logo.png"
        alt="HubTeam.ai"
        width={64}
        height={64}
        className="h-full w-full object-contain"
      />
    </span>
  );
}
