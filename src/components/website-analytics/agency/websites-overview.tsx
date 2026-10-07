import Link from "next/link";
import { BarChart3 } from "lucide-react";

import { StatusDot } from "@/components/agency-overview/frame";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  rowStatus,
  type WebsitesOverviewRow,
} from "@/lib/website-analytics/agency/overview";
import {
  formatCount,
  formatMoney,
} from "@/lib/module-flows/analytics/format";

// "All properties" listesi (GA-F8, /websites): yalnız sayılar ve mülk/proje
// adları. Google'dan gelen başka metin (sağlık nedeni, e-posta) gösterilmez.
// Sunucuda çizilir; veri server/website-analytics/agency/overview.ts'ten gelir.

const BIGQUERY_LABEL: Record<Exclude<WebsitesOverviewRow["bigQuery"], "off">, string> = {
  pending: "BigQuery: waiting",
  ok: "BigQuery: ok",
  error: "BigQuery: needs a look",
};

function Chip({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "bad";
}) {
  return (
    <span
      className={
        tone === "bad"
          ? "rounded bg-destructive/10 px-1.5 py-0.5 text-[11px] text-destructive"
          : "rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
      }
    >
      {children}
    </span>
  );
}

// "+5%" / "-3%"; karşılaştırma yoksa boş.
function Change({ value }: { value: number | null }) {
  if (value === null) return null;
  const rounded = Math.round(value);
  const sign = rounded > 0 ? "+" : "";
  const tone =
    rounded > 0
      ? "text-success"
      : rounded < 0
        ? "text-destructive"
        : "text-muted-foreground";
  return <span className={`ml-1 text-xs ${tone}`}>{`${sign}${rounded}%`}</span>;
}

function Stat({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium">{children}</dd>
    </div>
  );
}

// "2026-10-05" -> "Oct 5"
function dayLabel(dayKey: string): string {
  const date = new Date(`${dayKey}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return dayKey;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function PropertyRow({
  row,
  linkProjects,
}: {
  row: WebsitesOverviewRow;
  linkProjects: boolean;
}) {
  const status = rowStatus(row);
  const href =
    row.role === "extra"
      ? `/projects/${row.projectId}/site?property=${encodeURIComponent(row.propertyId)}`
      : `/projects/${row.projectId}/site`;
  const alerts =
    row.alertsCritical + row.alertsWarn === 0
      ? "0"
      : [
          row.alertsCritical > 0 ? `${row.alertsCritical} critical` : null,
          row.alertsWarn > 0 ? `${row.alertsWarn} to check` : null,
        ]
          .filter(Boolean)
          .join(", ");

  return (
    <li className="rounded-lg border px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <StatusDot tone={status.tone} label={status.label} />
          {linkProjects ? (
            <Link href={href} className="truncate font-medium hover:underline">
              {row.projectName}
            </Link>
          ) : (
            <span className="truncate font-medium">{row.projectName}</span>
          )}
          {row.propertyName ? (
            <span className="truncate text-muted-foreground">
              {row.propertyName}
            </span>
          ) : null}
          <Chip>{row.role === "main" ? "Main" : "Extra"}</Chip>
          {row.serviceLevel === "360" ? <Chip>360</Chip> : null}
          {row.isMock ? <Chip>Demo</Chip> : null}
          {row.connection === "needs_reconnect" ? (
            <Chip tone="bad">Needs reconnect</Chip>
          ) : null}
        </div>
        <span className="text-xs text-muted-foreground">
          {row.dataThrough
            ? `Data through ${dayLabel(row.dataThrough)}`
            : "No data yet"}
        </span>
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        <Stat label="Sessions 7d">
          {row.sessions7d === null ? (
            "—"
          ) : (
            <>
              {formatCount(row.sessions7d)}
              <Change value={row.sessionsChangePct} />
            </>
          )}
        </Stat>
        <Stat label="Key events 7d">
          {row.keyEvents7d === null ? (
            "—"
          ) : (
            <>
              {formatCount(Math.round(row.keyEvents7d))}
              <Change value={row.keyEventsChangePct} />
            </>
          )}
        </Stat>
        <Stat label="Revenue 7d">
          {row.revenue7d === null
            ? "—"
            : formatMoney(row.revenue7d, row.currency, true)}
        </Stat>
        <Stat label="Measurement score">
          {row.measurementScore === null ? "—" : row.measurementScore}
        </Stat>
        <Stat label="Open findings">{row.openFindings}</Stat>
        <Stat label="Alerts">{alerts}</Stat>
        {row.agentelseChanges > 0 ? (
          <Stat label="Changes by Agentelse">{row.agentelseChanges}</Stat>
        ) : null}
        {row.role === "main" && row.activeShares > 0 ? (
          <Stat label="Client links">{row.activeShares}</Stat>
        ) : null}
      </dl>
      {row.bigQuery !== "off" ? (
        <div className="mt-2">
          <Chip tone={row.bigQuery === "error" ? "bad" : "neutral"}>
            {BIGQUERY_LABEL[row.bigQuery]}
          </Chip>
        </div>
      ) : null}
    </li>
  );
}

export function WebsitesOverviewList({
  rows,
  truncated,
  linkProjects,
}: {
  rows: WebsitesOverviewRow[];
  truncated: boolean;
  // Proje bağları /projects/<id>/site'a gider; o sayfa GA_WEBSITE_PAGE
  // kapalıyken 404 verir, bu yüzden bayrak kapalıyken düz metin çizilir.
  linkProjects: boolean;
}) {
  return (
    <Card size="sm">
      <CardHeader className="flex flex-row items-center gap-2 space-y-0">
        <span className="flex size-7 items-center justify-center rounded-lg bg-primary/10">
          <BarChart3 className="size-4 text-primary" />
        </span>
        <CardTitle className="text-base">All properties ({rows.length})</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No properties here yet. Connect Google Analytics in a project, or
            link a Google account above.
          </p>
        ) : (
          <ul className="space-y-2">
            {rows.map((row) => (
              <PropertyRow
                key={row.linkId}
                row={row}
                linkProjects={linkProjects}
              />
            ))}
          </ul>
        )}
        {truncated ? (
          <p className="text-xs text-muted-foreground">
            Showing the first 200 properties.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
