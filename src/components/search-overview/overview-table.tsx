import Link from "next/link";

import { cn } from "@/lib/utils";
import { StatusDot } from "@/components/agency-overview/frame";
import { BQ_BADGE_LABEL } from "@/lib/seo/agency/copy";
import type { SearchAgencyRow } from "@/lib/seo/agency/overview";

// /search tablosu: tek duyarlı düzen, tablo kendi kabında yatay kayar.
// Birincil olmayan sitelerde motor kaynaklı alanlar (sağlık puanı, fırsat,
// uyarı) çizgi gösterir.

type Tone = "ok" | "warn" | "bad" | "idle";

const NUMBER = new Intl.NumberFormat("en-US");

function statusOf(row: SearchAgencyRow): { tone: Tone; label: string } {
  switch (row.health) {
    case "OK":
      return row.backfillDone
        ? { tone: "ok", label: "Connected" }
        : { tone: "idle", label: "Importing history" };
    case "DEGRADED":
      return { tone: "warn", label: "Updates failing" };
    case "AUTH":
      return { tone: "bad", label: "Reconnect needed" };
    case "NEEDS_PERMISSION":
      return { tone: "bad", label: "Needs permission" };
    case "ACCESS_LOST":
      return { tone: "bad", label: "Access lost" };
    case "GONE":
      return { tone: "bad", label: "Site not found" };
    case "API_DISABLED":
      return { tone: "bad", label: "API turned off" };
    default:
      return { tone: "idle", label: "Not checked yet" };
  }
}

function dayLabel(day: string | null): string {
  if (!day) return "—";
  return new Date(`${day}T00:00:00.000Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function Dash() {
  return <span className="text-muted-foreground">—</span>;
}

function Change({ pct }: { pct: number | null }) {
  if (pct === null) return null;
  if (pct === 0) {
    return <span className="text-xs text-muted-foreground">0.0%</span>;
  }
  return (
    <span
      className={cn(
        "text-xs tabular-nums",
        pct > 0
          ? "text-emerald-600 dark:text-emerald-400"
          : "text-destructive",
      )}
    >
      {pct > 0 ? "▲" : "▼"} {Math.abs(pct).toFixed(1)}%
    </span>
  );
}

const TH = "px-3 py-2 text-left text-xs font-medium text-muted-foreground";
const TD = "px-3 py-2.5 align-top";

export function SearchOverviewTable({ rows }: { rows: SearchAgencyRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
        No sites match this filter.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto rounded-xl ring-1 ring-foreground/10">
      <table className="w-full min-w-[56rem] text-sm">
        <thead className="border-b bg-muted/40">
          <tr>
            <th scope="col" className={TH}>
              Site
            </th>
            <th scope="col" className={TH}>
              Status
            </th>
            <th scope="col" className={cn(TH, "text-right")}>
              Clicks 28 d
            </th>
            <th scope="col" className={cn(TH, "text-right")}>
              Impressions
            </th>
            <th scope="col" className={cn(TH, "text-right")}>
              Health score
            </th>
            <th scope="col" className={cn(TH, "text-right")}>
              Opportunities
            </th>
            <th scope="col" className={TH}>
              Alerts
            </th>
            <th scope="col" className={TH}>
              BigQuery
            </th>
            <th scope="col" className={TH}>
              Data through
            </th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((row) => {
            const status = statusOf(row);
            const secondary = row.role === "SECONDARY";
            return (
              <tr key={row.linkId} data-row={row.linkId}>
                <td className={TD}>
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <Link
                      href={`/projects/${encodeURIComponent(row.projectId)}/arama?site=${encodeURIComponent(row.linkId)}`}
                      className="font-medium hover:underline"
                    >
                      {row.siteLabel}
                    </Link>
                    {secondary ? (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                        Secondary
                      </span>
                    ) : null}
                    {row.isMock ? (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                        Sample
                      </span>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {row.projectName}
                  </p>
                </td>
                <td className={TD}>
                  <StatusDot tone={status.tone} label={status.label} />
                  {row.attentionReasons.length > 0 ? (
                    <ul className="mt-0.5 space-y-0.5 text-xs text-muted-foreground">
                      {row.attentionReasons.slice(0, 2).map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                  ) : null}
                </td>
                <td className={cn(TD, "text-right tabular-nums")}>
                  {row.clicks === null ? (
                    <Dash />
                  ) : (
                    <div className="flex flex-col items-end">
                      <span>{NUMBER.format(row.clicks)}</span>
                      <Change pct={row.clicksChangePct} />
                    </div>
                  )}
                </td>
                <td className={cn(TD, "text-right tabular-nums")}>
                  {row.impressions === null ? (
                    <Dash />
                  ) : (
                    NUMBER.format(row.impressions)
                  )}
                </td>
                <td className={cn(TD, "text-right tabular-nums")}>
                  {row.healthScore === null ? (
                    <Dash />
                  ) : (
                    <span
                      title={
                        row.healthCapped
                          ? "Capped because of a critical issue"
                          : undefined
                      }
                    >
                      {Math.round(row.healthScore)}
                      {row.healthCapped ? " (capped)" : ""}
                    </span>
                  )}
                </td>
                <td className={cn(TD, "text-right tabular-nums")}>
                  {row.openOpportunities === null ? (
                    <Dash />
                  ) : (
                    NUMBER.format(row.openOpportunities)
                  )}
                </td>
                <td className={TD}>
                  {secondary ? (
                    <Dash />
                  ) : row.critical === 0 && row.warn === 0 ? (
                    <span className="text-muted-foreground">None</span>
                  ) : (
                    <div className="flex flex-col text-xs">
                      {row.critical > 0 ? (
                        <span className="text-destructive">
                          {row.critical} critical
                        </span>
                      ) : null}
                      {row.warn > 0 ? (
                        <span className="text-amber-600 dark:text-amber-400">
                          {row.warn} to check
                        </span>
                      ) : null}
                    </div>
                  )}
                </td>
                <td className={TD}>
                  {row.bigQuery === "OFF" ? (
                    <Dash />
                  ) : (
                    <span
                      className={cn(
                        "rounded bg-muted px-1.5 py-0.5 text-[11px]",
                        row.bigQuery === "ERROR"
                          ? "text-destructive"
                          : "text-muted-foreground",
                      )}
                    >
                      {BQ_BADGE_LABEL[row.bigQuery]}
                    </span>
                  )}
                </td>
                <td className={cn(TD, "text-muted-foreground")}>
                  {dayLabel(row.finalThrough)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
