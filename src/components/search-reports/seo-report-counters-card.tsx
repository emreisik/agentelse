import { LineChart } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { SeoReportCounters } from "@/server/seo/reports/counters";

// /health "Search reports" kartı (SC-F5): yalnız sayaçlar. Rapor metni, sorgu,
// sayfa ya da müşteri rakamı gösterilmez; sunucuda çizilir.

function Tile({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "danger" | "waiting" | "neutral";
}) {
  const toneClass =
    value === 0
      ? "text-muted-foreground"
      : tone === "danger"
        ? "text-destructive"
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

export function SeoReportCountersCard({
  counters,
}: {
  counters: SeoReportCounters;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2 space-y-0">
        <span className="flex size-7 items-center justify-center rounded-lg bg-accent">
          <LineChart className="size-4" />
        </span>
        <CardTitle className="text-base">Search reports</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Tile label="Sites tracked" value={counters.linksTracked} />
          <Tile label="Weekly reports (7 days)" value={counters.weekly7d} />
          <Tile label="Monthly reports (35 days)" value={counters.monthly35d} />
          <Tile label="Pulses (7 days)" value={counters.pulses7d} />
          <Tile label="Roadmaps (35 days)" value={counters.roadmaps35d} />
          <Tile
            label="AI summaries skipped (30 days)"
            value={counters.narrativeSkipped30d}
            tone="waiting"
          />
          <Tile
            label="Sites failing to report"
            value={counters.failingLinks}
            tone="danger"
          />
          <Tile label="SEO goals tracked" value={counters.goalsTracked} />
        </div>
        <p className="text-xs text-muted-foreground">
          Counters only. Customer data is never shown here.
        </p>
      </CardContent>
    </Card>
  );
}
