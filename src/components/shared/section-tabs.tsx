import Link from "next/link";

import { cn } from "@/lib/utils";

export type SectionTab = { key: string; label: string; count?: number };

// Link-based tabs: keeps pages RSC and every tab URL-addressable.
export function SectionTabs({
  base,
  param = "tab",
  tabs,
  active,
}: {
  base: string;
  param?: string;
  tabs: SectionTab[];
  active: string;
}) {
  return (
    <div className="flex items-center gap-1 border-b border-foreground/10">
      {tabs.map((tab) => {
        const isActive = tab.key === active;
        return (
          <Link
            key={tab.key}
            href={`${base}?${param}=${tab.key}`}
            className={cn(
              "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors",
              isActive
                ? "border-primary font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
            {tab.count !== undefined ? (
              <span
                className={cn(
                  "flex h-4 min-w-4 items-center justify-center rounded-4xl px-1 text-[10px] font-medium tabular-nums",
                  isActive
                    ? "bg-primary/15 text-primary"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {tab.count}
              </span>
            ) : null}
          </Link>
        );
      })}
    </div>
  );
}
