import { Wrench } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { GaFixCounters } from "@/lib/website-analytics/fixes/view-types";

// /health "Google Analytics fixes" kartı (GA-F7, Limited Use): yalnız
// sayaçlar. Mülk kimliği/adı, değişiklik içeriği ya da kimlik gösterilmez;
// `healthy` hesabını etkilemez; sunucuda çizilir.

// /health sayfasındaki StatTile görünümü (ga-measurement-counters-card ile aynı).
function Tile({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "danger" | "waiting" | "positive" | "neutral";
}) {
  const toneClass =
    value === 0
      ? "text-muted-foreground"
      : tone === "danger"
        ? "text-destructive"
        : tone === "waiting"
          ? "text-warning"
          : tone === "positive"
            ? "text-success"
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

export function GaFixesCountersCard({ counters }: { counters: GaFixCounters }) {
  const failed = Object.entries(counters.failedByCode).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  const lastRun =
    counters.watch.lastRunMinutesAgo === null
      ? "The change watch has not run yet"
      : `Change watch last ran ${counters.watch.lastRunMinutesAgo} min ago`;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2 space-y-0">
        <span className="flex size-7 items-center justify-center rounded-lg bg-accent">
          <Wrench className="size-4" />
        </span>
        <CardTitle className="text-base">Google Analytics fixes</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Tile
            label="Properties with editing allowed"
            value={counters.linksWithEditAccess}
          />
          <Tile
            label="Waiting for approval"
            value={counters.pendingApprovals}
            tone="waiting"
          />
          <Tile
            label="Done and checked (30 days)"
            value={counters.last30d.verified}
            tone="positive"
          />
          <Tile
            label="Didn't work (30 days)"
            value={counters.last30d.failed}
            tone="danger"
          />
          <Tile label="Undone (30 days)" value={counters.last30d.undone} />
          <Tile
            label="Open outside-change alerts"
            value={counters.outsideAlertsOpen}
            tone="waiting"
          />
        </div>
        <div className="space-y-1 text-sm">
          <p className="text-muted-foreground">{lastRun}</p>
          {failed.length > 0 ? (
            <ul className="text-xs text-muted-foreground">
              {failed.map(([code, count]) => (
                <li key={code}>
                  {code}: {count}
                </li>
              ))}
            </ul>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Counters only. Customer data is never shown here.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
