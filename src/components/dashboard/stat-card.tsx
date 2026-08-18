import Link from "next/link";
import type { LucideIcon } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function StatCard({
  label,
  value,
  href,
  icon: Icon,
  tone = "accent",
}: {
  label: string;
  value: string | number;
  href: string;
  icon: LucideIcon;
  tone?: "accent" | "destructive";
}) {
  return (
    <Link href={href}>
      <Card className="h-full transition-colors hover:bg-muted/40">
        <CardContent className="flex h-full flex-col gap-3 pt-6">
          <span
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-xl",
              tone === "destructive"
                ? "bg-destructive/10 text-destructive"
                : "bg-muted text-foreground",
            )}
          >
            <Icon className="size-4.5" />
          </span>
          <div>
            <div className="text-2xl font-semibold tracking-tight">{value}</div>
            <div className="text-xs text-muted-foreground">{label}</div>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
