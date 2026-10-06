import { ShieldCheck } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { GaMeasurementCounters } from "@/lib/website-analytics/health/view-types";

// /health "Google Analytics measurement checks" kartı (GA-F3, §3.11 Limited
// Use): yalnız sayaçlar. Mülk kimliği, adı, kontrol kanıtı ya da müşteri
// rakamı gösterilmez; `healthy` hesabını etkilemez; sunucuda çizilir.

// /health sayfasındaki StatTile görünümü (ga-health-card ile aynı).
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

export function GaMeasurementCountersCard({
  counters,
}: {
  counters: GaMeasurementCounters;
}) {
  const { scoreBuckets } = counters;
  const lastRun =
    counters.lastRunMinutesAgo === null
      ? "No measurement check has run yet"
      : `Last run ${counters.lastRunMinutesAgo} min ago`;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2 space-y-0">
        <span className="flex size-7 items-center justify-center rounded-lg bg-accent">
          <ShieldCheck className="size-4" />
        </span>
        <CardTitle className="text-base">
          Google Analytics measurement checks
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Tile label="Properties checked" value={counters.linksChecked} />
          <Tile
            label="Due for a check"
            value={counters.linksDue}
            tone="waiting"
          />
          <Tile
            label="Checks failing"
            value={counters.checksFailing}
            tone="danger"
          />
          <Tile
            label="Checks warning"
            value={counters.checksWarning}
            tone="waiting"
          />
          <Tile label="Couldn't check" value={counters.checksUnknown} />
          <Tile
            label="Open critical alerts"
            value={counters.alertsCritical}
            tone="danger"
          />
          <Tile
            label="Open warnings"
            value={counters.alertsWarn}
            tone="waiting"
          />
          <Tile label="Scores ≥80" value={scoreBuckets.good} tone="positive" />
          <Tile label="Scores 50–79" value={scoreBuckets.fair} tone="waiting" />
          <Tile label="Scores <50" value={scoreBuckets.poor} tone="danger" />
          <Tile label="No score yet" value={scoreBuckets.none} />
        </div>
        <div className="space-y-1 text-sm">
          <p className="text-muted-foreground">{lastRun}</p>
          <p className="text-xs text-muted-foreground">
            Counters only. Customer data is never shown here.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
