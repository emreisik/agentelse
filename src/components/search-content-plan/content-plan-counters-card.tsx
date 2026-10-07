import { CalendarRange } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { PlanEmptyReason } from "@/lib/seo/content-plan/types";
import type { SeoContentPlanCounters } from "@/server/seo/content-plan/counters";

// /health "SEO content plan" kartı (SC-F7): yalnız sayaçlar. Proje adı, kimlik,
// anahtar kelime, başlık ya da Search Console verisi gösterilmez (Limited Use);
// `healthy` hesabını etkilemez; sunucuda çizilir. Boş plan dökümü nedene göre
// verilir: "plan neden çıkmadı" sorusu buradan yanıtlanır.

const REASON_LABEL: Readonly<Record<PlanEmptyReason, string>> = {
  NO_DATA: "Not enough data",
  NO_CLUSTERS: "No topic groups",
  NO_GAPS: "No gaps",
  CAP_FULL: "Limit reached",
  NO_ROOM: "No days left",
  AI_LIMIT: "AI limit",
  ALL_FILTERED: "All filtered",
};

const REASON_ORDER: readonly PlanEmptyReason[] = [
  "NO_DATA",
  "NO_CLUSTERS",
  "NO_GAPS",
  "CAP_FULL",
  "NO_ROOM",
  "AI_LIMIT",
  "ALL_FILTERED",
];

// /health sayfasındaki StatTile görünümü (seo-action-counters-card ile aynı).
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

export function ContentPlanCountersCard({
  counters,
}: {
  counters: SeoContentPlanCounters;
}) {
  const reasons = REASON_ORDER.flatMap((reason) => {
    const count = counters.byEmptyReason[reason] ?? 0;
    return count > 0 ? [{ reason, count }] : [];
  });
  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2 space-y-0">
        <span className="flex size-7 items-center justify-center rounded-lg bg-accent">
          <CalendarRange className="size-4" />
        </span>
        <CardTitle className="text-base">SEO content plan</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Tile
            label="Projects with a plan"
            value={counters.projectsWithPlan}
          />
          <Tile label="Plans (30d)" value={counters.plans30d} />
          <Tile
            label="Empty plans (30d)"
            value={counters.empty30d}
            tone="waiting"
          />
          <Tile label="Articles planned" value={counters.slotsPlanned} />
          <Tile label="Articles written" value={counters.slotsWritten} />
          <Tile label="Articles published" value={counters.slotsPublished} />
          <Tile label="Articles skipped" value={counters.slotsSkipped} />
          <Tile
            label="Basic wording (30d)"
            value={counters.wordingBasic30d}
            tone="waiting"
          />
          <Tile label="Refreshes (30d)" value={counters.regenerations30d} />
          <Tile
            label="Blocked by limit (30d)"
            value={counters.capBlocked30d}
            tone="waiting"
          />
        </div>
        {reasons.length > 0 ? (
          <div className="space-y-1">
            <p className="text-xs font-medium">Empty plans by reason (30d)</p>
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
