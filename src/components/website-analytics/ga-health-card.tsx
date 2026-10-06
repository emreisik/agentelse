import { HeartPulse } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { GaHealthCounters } from "@/lib/website-analytics/health-counters";

// /health "Google Analytics" kartı (docs/google-analytics-plan.md §3.9,
// §3.11 Limited Use): yalnız sayaçlar. Mülk kimliği, adı ya da müşteri
// rakamı gösterilmez; sunucuda çizilir ("use client" yok).

function count(record: Record<string, number>, keys: string[]): number {
  return keys.reduce((sum, key) => sum + (record[key] ?? 0), 0);
}

// /health sayfasındaki StatTile görünümü (sayfadan içe aktarılmaz).
function Tile({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number | string;
  tone?: "danger" | "waiting" | "positive" | "neutral";
}) {
  const quiet = value === 0 || value === "—";
  const toneClass = quiet
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

function errorLine(errors: Partial<Record<string, number>>): string {
  const parts = Object.entries(errors)
    .filter((entry): entry is [string, number] => (entry[1] ?? 0) > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([klass, value]) => `${klass} ${value}`);
  return parts.length > 0 ? parts.join(" · ") : "No API errors";
}

export function GaHealthCard({ counters }: { counters: GaHealthCounters }) {
  const { links, sync, quota, api, catalog } = counters;
  const heartbeat =
    sync.heartbeatMinutesAgo === null
      ? "No sync heartbeat yet"
      : `Last sync heartbeat: ${sync.heartbeatMinutesAgo} min ago`;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2 space-y-0">
        <span className="flex size-7 items-center justify-center rounded-lg bg-accent">
          <HeartPulse className="size-4" />
        </span>
        <CardTitle className="text-base">Google Analytics</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Tile label="Properties" value={links.total} />
          <Tile
            label="Healthy"
            value={links.byHealth.OK ?? 0}
            tone="positive"
          />
          <Tile
            label="Need reconnect"
            value={count(links.byHealth, ["AUTH", "NEEDS_PERMISSION"])}
            tone="danger"
          />
          <Tile
            label="Access lost"
            value={count(links.byHealth, [
              "ACCESS_LOST",
              "GONE",
              "API_DISABLED",
            ])}
            tone="danger"
          />
          <Tile label="Failing" value={sync.failing} tone="danger" />
          <Tile label="Rate-limited" value={sync.rateLimited} tone="waiting" />
          <Tile
            label="Data late (>2 days)"
            value={sync.lagOver2Days}
            tone="waiting"
          />
          <Tile
            label="History loading"
            value={sync.backfillPending + sync.addonsPending}
          />
          <Tile
            label="Highest daily quota use"
            value={
              quota.maxDailyShare === null ? "—" : `${quota.maxDailyShare}%`
            }
          />
          <Tile
            label="Over half of hourly quota"
            value={quota.overHalfHourly}
            tone="waiting"
          />
          <Tile label="API calls (24 h)" value={api.calls} />
          <Tile
            label="Reports dropped"
            value={catalog.droppedReports}
            tone="waiting"
          />
          <Tile
            label="Deprecated fields"
            value={catalog.linksWithDeprecated}
            tone="waiting"
          />
          <Tile
            label="Google Ads reports on"
            value={catalog.googleAdsEnabled}
          />
          <Tile
            label="Search Console reports on"
            value={catalog.searchConsoleEnabled}
          />
        </div>
        <div className="space-y-1 text-sm">
          <p>{errorLine(api.errors)}</p>
          <p className="text-muted-foreground">{heartbeat}</p>
          <p className="text-xs text-muted-foreground">
            Counters only. Customer data is never shown here.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
