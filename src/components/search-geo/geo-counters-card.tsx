import { Sparkles } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { GEO_CHECKS } from "@/lib/seo/geo/catalog";
import { isGeoCheckId } from "@/lib/seo/geo/types";
import type { SeoGeoCounters } from "@/server/seo/geo/counters";

// /health "AI search visibility" kartı (SC-F8): yalnız sayaçlar. Proje adı,
// adres, sayfa ya da kurum adı gösterilmez; `healthy` hesabını etkilemez.

function Tile({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "waiting" | "neutral";
}) {
  const toneClass =
    value === 0
      ? "text-muted-foreground"
      : tone === "waiting"
        ? "text-warning"
        : "text-foreground";
  return (
    <div className="rounded-xl p-4 ring-1 ring-foreground/10">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`font-heading text-2xl font-semibold ${toneClass}`}>
        {value}
      </p>
    </div>
  );
}

export function GeoCountersCard({ counters }: { counters: SeoGeoCounters }) {
  const warns = Object.entries(counters.warnByCheck)
    .filter(([id, count]) => isGeoCheckId(id) && count > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2 space-y-0">
        <span className="flex size-7 items-center justify-center rounded-lg bg-accent">
          <Sparkles className="size-4" />
        </span>
        <CardTitle className="text-base">AI search visibility</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Tile label="Sites" value={counters.sites} />
          <Tile label="Checked (30d)" value={counters.audited30d} />
          <Tile label="llms.txt present" value={counters.llmsPresent} />
          <Tile label="Score under 50" value={counters.scoreBuckets.low} tone="waiting" />
          <Tile label="Score 50 to 79" value={counters.scoreBuckets.mid} />
          <Tile label="Score 80 or more" value={counters.scoreBuckets.high} />
          <Tile label="Linked to Analytics" value={counters.trafficLinked} />
        </div>
        {warns.length > 0 ? (
          <div className="space-y-1">
            <p className="text-xs font-medium">Needs attention by check</p>
            <ul className="flex flex-wrap gap-1.5">
              {warns.map(([id, count]) => (
                <li
                  key={id}
                  className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                >
                  {isGeoCheckId(id) ? GEO_CHECKS[id].title : id} {count}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Counters only. Customer data is never shown here.
        </p>
      </CardContent>
    </Card>
  );
}
