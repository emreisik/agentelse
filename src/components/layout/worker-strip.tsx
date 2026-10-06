import { CircleAlert } from "lucide-react";

import type { HeartbeatLevel } from "@/lib/heartbeat";
import { cn } from "@/lib/utils";

// Arka plan işçisi durunca OWNER/ADMIN'e görünen şerit (docs/meta-ads-plan.md
// F0b). İstek anında sunucuda hesaplanır: diğer her şey çökse bile ekranı
// açan yönetici durumu görür.
export function WorkerStrip({
  level,
  since,
  timeZone,
  now,
}: {
  level: HeartbeatLevel;
  since: Date | null;
  timeZone: string;
  now: Date;
}) {
  if (level === "ok") return null;

  // Bir günden eskiyse gün de yazılır ("5 Oct, 10:42").
  const olderThanADay =
    since !== null && now.getTime() - since.getTime() > 20 * 3600_000;
  const time = since
    ? new Intl.DateTimeFormat("en-GB", {
        timeZone,
        ...(olderThanADay ? { day: "numeric", month: "short" } : {}),
        hour: "2-digit",
        minute: "2-digit",
      }).format(since)
    : null;

  const title =
    level === "never" || !time
      ? "Background jobs have not run yet"
      : `Background jobs paused since ${time}`;

  return (
    <div
      role="status"
      className={cn(
        "flex shrink-0 items-center gap-2 border-b px-4 py-2 text-xs",
        level === "warn"
          ? "border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200"
          : "border-red-500/30 bg-red-500/10 text-red-900 dark:text-red-200",
      )}
    >
      <CircleAlert className="size-3.5 shrink-0" aria-hidden />
      <span className="font-medium">{title}</span>
      <span className="text-muted-foreground hidden sm:inline">
        Scheduled posts, ad checks and approvals wait until they run again.
      </span>
    </div>
  );
}
