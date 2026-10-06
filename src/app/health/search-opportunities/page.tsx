import { notFound } from "next/navigation";
import { Lightbulb } from "lucide-react";

import { AppShell } from "@/components/layout/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SEO_RULE_LABEL } from "@/lib/seo/rules/copy";
import { isPlatformOperator } from "@/server/security/operator";
import { requireUser } from "@/server/security/tenant-context";
import { loadSeoOpportunityCounters } from "@/server/seo/opportunities/operator-counters";

// SEO fırsat motoru operatör sayfası (SC-F4, docs/search-opportunities.md):
// yalnız platform operatörü ve yalnız sayılar (proje adı, sorgu, sayfa ya da
// bulgu metni yok). Gölge kipte "on"a geçiş ölçütü burada izlenir.
// SEO_INSIGHTS=off iken sayfa yoktur (404).

const PRECISION_TARGET = 0.7;
const REVIEW_TARGET = 30;

const MODE_LABEL = { off: "Off", shadow: "Shadow", on: "On" } as const;

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl p-4 ring-1 ring-foreground/10">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="font-heading text-2xl font-semibold tabular-nums">
        {value}
      </p>
    </div>
  );
}

function percent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

export default async function SearchOpportunitiesHealthPage() {
  const { userId } = await requireUser();
  if (!isPlatformOperator(userId)) notFound();
  const counters = await loadSeoOpportunityCounters(new Date()).catch(
    () => null,
  );
  if (!counters) notFound();

  const ready =
    counters.reviewed >= REVIEW_TARGET &&
    counters.precision !== null &&
    counters.precision >= PRECISION_TARGET;

  return (
    <AppShell>
      <div className="space-y-6 p-6">
        <div>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">
            Search opportunities
          </h1>
          <p className="text-sm text-muted-foreground">
            Counts from the SEO opportunity engine. Mode:{" "}
            {MODE_LABEL[counters.mode]}.
          </p>
        </div>

        {counters.mode === "shadow" ? (
          <p
            className="rounded-xl p-4 text-sm ring-1 ring-foreground/10"
            data-acceptance={ready ? "met" : "not-met"}
          >
            Turn SEO_INSIGHTS on when precision is at least 70% on 30 reviewed
            findings.{" "}
            <span className="text-muted-foreground">
              {ready
                ? "This is met now."
                : `Now: ${percent(counters.precision)} on ${counters.reviewed} reviewed.`}
            </span>
          </p>
        ) : null}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile
            label="Sites tracked"
            value={String(counters.linksTracked)}
          />
          <StatTile label="Ran in 24 hours" value={String(counters.ran24h)} />
          <StatTile label="Failing sites" value={String(counters.failing)} />
          <StatTile
            label="AI skipped (budget)"
            value={String(counters.llmSkippedBudget)}
          />
          <StatTile
            label="Findings (14 days)"
            value={String(counters.findings14d)}
          />
          <StatTile
            label="Reviewed (30 days)"
            value={String(counters.reviewed)}
          />
          <StatTile label="Precision" value={percent(counters.precision)} />
        </div>

        <Card>
          <CardHeader className="flex flex-row items-center gap-2 space-y-0">
            <span className="flex size-7 items-center justify-center rounded-lg bg-accent">
              <Lightbulb className="size-4" />
            </span>
            <CardTitle className="text-base">By rule</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">Rule</th>
                    <th className="py-2 pr-3 text-right font-medium">
                      Created (14 days)
                    </th>
                    <th className="py-2 pr-3 text-right font-medium">Useful</th>
                    <th className="py-2 text-right font-medium">Not useful</th>
                  </tr>
                </thead>
                <tbody>
                  {counters.byRule.map((row) => (
                    <tr key={row.ruleKey} className="border-t border-border">
                      <td className="py-2 pr-3">
                        {SEO_RULE_LABEL[row.ruleKey] ?? row.ruleKey}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {row.created14d}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {row.useful}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {row.notUseful}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
