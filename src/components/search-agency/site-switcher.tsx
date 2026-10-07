import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import type { ProjectSiteView } from "@/lib/seo/agency/types";
import { cn } from "@/lib/utils";

import {
  healthLabel,
  healthTone,
  siteHref,
  type HealthTone,
} from "./form-helpers";

// Search sayfasının site seçici şeridi (SC-F9). Tek site varsa hiçbir şey
// çizilmez. Seçim bir görünüm geçersiz kılmasıdır (?site=), veri değiştirmez;
// birincil site parametresiz adrese gider.

const DOT_CLASS: Record<HealthTone, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  bad: "bg-destructive",
  idle: "bg-muted-foreground/40",
};

export function HealthDot({ health }: { health: string }) {
  const tone = healthTone(health);
  return (
    <span
      role="img"
      aria-label={healthLabel(health)}
      title={healthLabel(health)}
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        DOT_CLASS[tone],
      )}
    />
  );
}

export function SiteSwitcher({
  sites,
  viewedLinkId,
  base,
  keep,
}: {
  projectId: string;
  sites: ProjectSiteView[];
  viewedLinkId: string | null;
  base: string;
  keep?: Record<string, string>;
}) {
  if (sites.length <= 1) return null;
  // Görüntülenen site verilmediyse birincil site seçili sayılır.
  const currentId =
    viewedLinkId ??
    sites.find((site) => site.role === "PRIMARY")?.linkId ??
    null;
  return (
    <nav aria-label="Search Console sites" data-card="site-switcher">
      <ul className="flex flex-wrap items-center gap-1.5">
        {sites.map((site) => {
          const selected = site.linkId === currentId;
          return (
            <li key={site.linkId} className="min-w-0">
              <Link
                href={siteHref(
                  base,
                  site.role === "PRIMARY" ? null : site.linkId,
                  keep,
                )}
                aria-current={selected ? "page" : undefined}
                className={cn(
                  "inline-flex max-w-[16rem] items-center gap-2 rounded-lg px-2.5 py-1 text-sm ring-1 ring-foreground/10 transition-colors hover:bg-muted",
                  selected && "bg-accent font-medium ring-foreground/25",
                )}
              >
                <HealthDot health={site.health} />
                <span className="truncate">{site.siteLabel}</span>
                {site.role === "SECONDARY" ? (
                  <Badge variant="outline">Secondary</Badge>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
