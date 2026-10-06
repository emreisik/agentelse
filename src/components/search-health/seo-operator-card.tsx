import Link from "next/link";
import { SearchCheck } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { timeAgo } from "@/lib/dates";
import type { SeoOperatorCounters } from "@/server/seo/health/operator-counters";

// /health "Search health (site audit)" kartı (SC-F3): yalnız sayaçlar. Proje
// adı, adres ya da Search Console verisi gösterilmez (Limited Use);
// `healthy` hesabını etkilemez; sunucuda çizilir.

// /health sayfasındaki StatTile görünümü (ga-measurement-counters-card ile aynı).
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

export function SeoOperatorCard({
  counters,
}: {
  counters: SeoOperatorCounters;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2 space-y-0">
        <span className="flex size-7 items-center justify-center rounded-lg bg-accent">
          <SearchCheck className="size-4" />
        </span>
        <CardTitle className="text-base">Search health (site audit)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Tile label="Sites tracked" value={counters.sitesTracked} />
          <Tile
            label="URL inspections today"
            value={counters.inspectionsToday}
          />
          <Tile
            label="Inspections paused"
            value={counters.inspectionSitesPaused}
            tone="waiting"
          />
          <Tile label="Crawls running" value={counters.crawlsRunning} />
          <Tile
            label="Crawls blocked"
            value={counters.crawlsBlocked}
            tone="waiting"
          />
          <Tile
            label="Crawl failures (24h)"
            value={counters.crawlFailures24h}
            tone="danger"
          />
        </div>
        <div className="space-y-1 text-sm">
          {counters.cwvKeyMissing ? (
            <p className="text-warning">
              CrUX key missing: Core Web Vitals are off until GOOGLE_API_KEY is
              set.
            </p>
          ) : null}
          <p className="text-muted-foreground">
            {counters.updatesLastSync
              ? `Google updates last synced ${timeAgo(counters.updatesLastSync)}`
              : "Google updates have not synced yet"}
            {" · "}
            <Link
              href="/health/search-updates"
              className="text-foreground underline-offset-2 hover:underline"
            >
              Manage Google updates
            </Link>
          </p>
          <p className="text-xs text-muted-foreground">
            Counters only. Customer data is never shown here.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
