import { Building2 } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { GaAgencyCounters } from "@/server/website-analytics/agency/counters";

// /health "Google Analytics agency" kartı (GA-F8, Limited Use): yalnız
// sayaçlar. Mülk kimliği/adı, adres, e-posta ya da müşteri rakamı gösterilmez;
// `healthy` hesabını etkilemez; sunucuda çizilir. Sayaçlar kapalıysa (null)
// kart hiç çizilmez.

function Tile({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string | number;
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

function Group({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium">{title}</h3>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{children}</div>
    </section>
  );
}

// Bayt sayısı GB olarak ("12.3 GB").
function gigabytes(bytes: number): string {
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

export function GaAgencyCountersCard({
  counters,
}: {
  counters: GaAgencyCounters | null;
}) {
  if (!counters) return null;
  const { links, shares, bigQuery, funnels, risc, keys } = counters;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2 space-y-0">
        <span className="flex size-7 items-center justify-center rounded-lg bg-accent">
          <Building2 className="size-4" />
        </span>
        <CardTitle className="text-base">Google Analytics agency</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <Group title="Properties">
          <Tile label="Main properties" value={links.main} />
          <Tile label="Extra properties" value={links.extra} />
          <Tile
            label="Workspaces with extras"
            value={links.workspacesWithExtras}
          />
          <Tile
            label="Extras not healthy"
            value={links.extraHealthNotOk}
            tone="danger"
          />
          <Tile
            label="Extras with data older than 72 h"
            value={links.extraStale72h}
            tone="waiting"
          />
        </Group>

        {shares ? (
          <Group title="Client links (all reports)">
            <Tile label="Active client links" value={shares.active} />
            <Tile label="Created, 7 days" value={shares.created7d} />
            <Tile label="Links viewed, 7 days" value={shares.viewed7d} />
            <Tile label="Branded workspaces" value={shares.brandedWorkspaces} />
          </Group>
        ) : null}

        <Group title="BigQuery export">
          <Tile label="Sources pending" value={bigQuery.pending} tone="waiting" />
          <Tile label="Sources ok" value={bigQuery.ok} />
          <Tile label="Sources failing" value={bigQuery.error} tone="danger" />
          <Tile
            label="Billed this month"
            value={gigabytes(bigQuery.bytesThisMonth)}
          />
        </Group>

        <Group title="Funnels">
          <Tile label="Funnels defined" value={funnels.defined} />
          <Tile label="Ran in 24 h" value={funnels.ran24h} />
          <Tile label="Last run failed" value={funnels.failed} tone="danger" />
        </Group>

        <Group title="Google security events">
          <Tile label="Received, 24 h" value={risc.received24h} />
          <Tile label="Applied, 24 h" value={risc.applied24h} />
          <Tile label="Received, 30 days" value={risc.received30d} />
          <Tile
            label="Needs a recheck, 30 days"
            value={risc.recheck30d}
            tone="waiting"
          />
          <Tile label="Still pending" value={risc.pending} tone="danger" />
        </Group>

        {keys ? (
          <Group title="Token keys">
            <Tile label="Credentials on current key" value={keys.currentRows} />
            <Tile label="Credentials on legacy key" value={keys.legacyRows} />
            <Tile
              label="Credentials on other keys"
              value={keys.otherRows}
              tone="waiting"
            />
            <Tile label="Credentials in total" value={keys.totalRows} />
          </Group>
        ) : null}

        <p className="text-xs text-muted-foreground">
          Counters only. Customer data is never shown here.
        </p>
      </CardContent>
    </Card>
  );
}
