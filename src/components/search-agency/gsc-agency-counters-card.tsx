import { Building2 } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatBytes } from "@/lib/seo/agency/bq/cost";
import type { GscAgencyCounters } from "@/lib/seo/agency/types";

// /health "Search agency" kartı (SC-F9): yalnız sayaçlar. Site adı, proje,
// sorgu ya da müşteri rakamı gösterilmez; sunucuda çizilir. Boş (null) parçalar
// hiç çizilmez.

function Tile({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number | string;
  tone?: "danger" | "waiting" | "neutral";
}) {
  const zero = value === 0;
  const toneClass = zero
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

export function GscAgencyCountersCard({
  counters,
}: {
  counters: GscAgencyCounters;
}) {
  const { bigQuery, splitTests, shares } = counters;
  return (
    <Card data-card="gsc-agency-counters">
      <CardHeader className="flex flex-row items-center gap-2 space-y-0">
        <span className="flex size-7 items-center justify-center rounded-lg bg-accent">
          <Building2 className="size-4" />
        </span>
        <CardTitle className="text-base">Search agency</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Tile label="Extra sites" value={counters.extraSites} />
          <Tile
            label="Page group rule sets"
            value={counters.pageGroupRuleSets}
          />
          {bigQuery ? (
            <>
              <Tile label="BigQuery sources" value={bigQuery.sources} />
              <Tile label="BigQuery on" value={bigQuery.active} />
              <Tile
                label="BigQuery needs attention"
                value={bigQuery.error}
                tone="danger"
              />
              <Tile
                label="BigQuery budget used up"
                value={bigQuery.budget}
                tone="waiting"
              />
              <Tile label="BigQuery paused" value={bigQuery.paused} />
              <Tile
                label="Periods imported (7 days)"
                value={bigQuery.periodsImported7d}
              />
              <Tile
                label="Billed this month"
                value={formatBytes(bigQuery.bytesBilledThisMonth)}
              />
            </>
          ) : null}
          {splitTests ? (
            <>
              <Tile label="Split tests open" value={splitTests.open} />
              <Tile label="Waiting for the change" value={splitTests.applied} />
              <Tile label="Measuring" value={splitTests.evaluating} />
              <Tile
                label="Worked (30 days)"
                value={splitTests.evaluated30d.worked}
              />
              <Tile
                label="Didn't work (30 days)"
                value={splitTests.evaluated30d.didnt}
              />
              <Tile
                label="No clear result (30 days)"
                value={splitTests.evaluated30d.inconclusive}
              />
              <Tile
                label="Expired (30 days)"
                value={splitTests.expired30d}
                tone="waiting"
              />
            </>
          ) : null}
          {shares ? (
            <>
              <Tile label="Active share links" value={shares.active} />
              <Tile label="Links created (7 days)" value={shares.created7d} />
              <Tile label="Links viewed (7 days)" value={shares.viewed7d} />
              <Tile
                label="Workspaces with branding"
                value={shares.brandedWorkspaces}
              />
            </>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          Counters only. Customer data is never shown here.
        </p>
      </CardContent>
    </Card>
  );
}
