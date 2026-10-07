import { FilePenLine } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { SeoApplyCounters } from "@/server/seo/apply/counters";

// /health "Website changes" kartı (SC-F8): yalnız sayaçlar. Proje adı, adres,
// sayfa yolu, başlık ya da içerik gösterilmez; `healthy` hesabını etkilemez;
// sunucuda çizilir. StatTile görünümü diğer SEO sayaç kartlarıyla aynıdır.

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

function Chips({
  title,
  counts,
}: {
  title: string;
  counts: Record<string, number>;
}) {
  const entries = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (entries.length === 0) return null;
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium">{title}</p>
      <ul className="flex flex-wrap gap-1.5">
        {entries.map(([name, count]) => (
          <li
            key={name}
            className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
          >
            {`${name} ${count}`}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SeoApplyCountersCard({
  counters,
}: {
  counters: SeoApplyCounters;
}) {
  const { last30d, indexNow } = counters;
  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2 space-y-0">
        <span className="flex size-7 items-center justify-center rounded-lg bg-accent">
          <FilePenLine className="size-4" />
        </span>
        <CardTitle className="text-base">Website changes</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Tile label="Connected sites" value={counters.sites} />
          <Tile
            label="Unhealthy sites"
            value={Math.max(0, counters.sites - counters.healthy)}
            tone="danger"
          />
          <Tile
            label="Waiting for approval"
            value={counters.pendingApprovals}
            tone="waiting"
          />
          <Tile label="Proposed (30d)" value={last30d.proposed} />
          <Tile label="Done and checked (30d)" value={last30d.verified} />
          <Tile label="Failed (30d)" value={last30d.failed} tone="danger" />
          <Tile label="Undone (30d)" value={last30d.undone} />
          <Tile label="Rejected (30d)" value={last30d.rejected} />
          <Tile label="Expired (30d)" value={last30d.expired} />
          <Tile label="Linked to actions" value={counters.linkedActions} />
          <Tile label="IndexNow projects" value={indexNow.projects} />
          <Tile label="IndexNow sent (30d)" value={indexNow.sent30d} />
          <Tile
            label="IndexNow failed (30d)"
            value={indexNow.failed30d}
            tone="danger"
          />
        </div>
        <Chips title="By kind (30d)" counts={counters.byKind30d} />
        <Chips title="Failed by reason (30d)" counts={counters.failedByCode} />
        <p className="text-xs text-muted-foreground">
          Counters only. Customer data is never shown here.
        </p>
      </CardContent>
    </Card>
  );
}
