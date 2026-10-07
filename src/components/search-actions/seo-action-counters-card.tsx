import { ListChecks } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { EvaluationReason } from "@/lib/seo/actions/types";
import type { SeoActionCounters } from "@/server/seo/actions/operator-counters";

// /health "SEO actions" kartı (SC-F6): yalnız sayaçlar. Proje adı, adres,
// sorgu ya da Search Console verisi gösterilmez (Limited Use); `healthy`
// hesabını etkilemez; sunucuda çizilir. 30 günlük INCONCLUSIVE dökümü nedene
// göre verilir: planın "eylemlerin ≥ %80'i bir sonuca varsın" hedefi buradan
// denetlenir.

const REASON_LABEL: Readonly<Record<EvaluationReason, string>> = {
  LOW_DATA: "Low data",
  NO_DATA: "No data",
  NO_SEARCH_DATA: "No Search Console",
  NO_PAGE: "Page not found",
  GOOGLE_UPDATE: "Google update",
  OVERLAPPING_CHANGE: "Overlapping change",
  ALERT_GONE: "Issue gone",
};

const REASON_ORDER: readonly EvaluationReason[] = [
  "LOW_DATA",
  "NO_DATA",
  "NO_SEARCH_DATA",
  "NO_PAGE",
  "GOOGLE_UPDATE",
  "OVERLAPPING_CHANGE",
  "ALERT_GONE",
];

// /health sayfasındaki StatTile görünümü (seo-operator-card ile aynı).
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

export function SeoActionCountersCard({
  counters,
}: {
  counters: SeoActionCounters;
}) {
  const reasons = REASON_ORDER.flatMap((reason) => {
    const count = counters.inconclusiveByReason30d[reason] ?? 0;
    return count > 0 ? [{ reason, count }] : [];
  });
  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2 space-y-0">
        <span className="flex size-7 items-center justify-center rounded-lg bg-accent">
          <ListChecks className="size-4" />
        </span>
        <CardTitle className="text-base">SEO actions</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Tile label="Open" value={counters.open} />
          <Tile
            label="Awaiting verification"
            value={counters.awaitingVerification}
            tone="waiting"
          />
          <Tile label="Asked the user" value={counters.asked} tone="waiting" />
          <Tile label="Measuring" value={counters.measuring} />
          <Tile label="Worked (30d)" value={counters.evaluated30d.worked} />
          <Tile label="Didn't work (30d)" value={counters.evaluated30d.didnt} />
          <Tile
            label="No clear result (30d)"
            value={counters.evaluated30d.inconclusive}
            tone="waiting"
          />
          <Tile label="Expired (30d)" value={counters.expired30d} />
          <Tile label="Learnings (30d)" value={counters.learnings30d} />
        </div>
        {reasons.length > 0 ? (
          <div className="space-y-1">
            <p className="text-xs font-medium">
              No clear result by reason (30d)
            </p>
            <ul className="flex flex-wrap gap-1.5">
              {reasons.map(({ reason, count }) => (
                <li
                  key={reason}
                  className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                >
                  {`${REASON_LABEL[reason]} ${count}`}
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
