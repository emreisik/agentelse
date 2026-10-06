import Link from "next/link";
import { Lightbulb } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { timeAgo } from "@/lib/dates";
import { cn } from "@/lib/utils";
import {
  findingConfidenceText,
  operatorFindingTitle,
} from "@/lib/website-analytics/analysis/describe";
import type { GaInsightsMode } from "@/lib/website-analytics/analysis/flags";
import type { GaReviewVerdict } from "@/lib/website-analytics/analysis/types";
import type { GaInsightsOperatorView } from "@/lib/website-analytics/analysis/view-types";

// /health "Website insights (Google Analytics)" kartı (GA-F4, Limited Use):
// mod, kendi tablolarımızdan sayaçlar ve yalnız bakanın üye olduğu projelerden
// son bulgular (proje adı + genel başlık; konu, yol, açıklama ya da Google
// değeri yok). "Review" bağlantısı Website sayfasının inceleme moduna gider;
// `healthy` hesabını etkilemez; sunucuda çizilir.

const MODE_LABEL: Record<GaInsightsMode, string> = {
  off: "Off",
  shadow: "Shadow",
  on: "On",
};

const MODE_TONE: Record<GaInsightsMode, string> = {
  off: "bg-muted text-muted-foreground",
  shadow: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  on: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
};

const VERDICT_TEXT: Record<GaReviewVerdict, string> = {
  USEFUL: "Useful",
  NOT_USEFUL: "Not useful",
};

const PRECISION_TARGET_REVIEWS = 30;

// /health sayfasındaki StatTile görünümü (ga-measurement-counters-card ile aynı).
function Tile({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <div className="rounded-xl p-4 ring-1 ring-foreground/10">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="font-heading text-2xl font-semibold text-foreground">
        {value}
      </p>
      {hint ? (
        <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

function precisionText(precision: number | null, reviewed: number): string {
  if (reviewed === 0 || precision === null || !Number.isFinite(precision)) {
    return "—";
  }
  return `${Math.round(precision * 100)}%`;
}

export function GaInsightsOperatorCard({
  view,
}: {
  view: GaInsightsOperatorView;
}) {
  const { counters, mode } = view;
  const lastRun =
    counters.lastRunMinutesAgo === null
      ? "Not run yet"
      : `${counters.lastRunMinutesAgo} min ago`;
  const byRule = counters.byRule.filter((item) => item.open > 0);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2 space-y-0">
        <span className="flex size-7 items-center justify-center rounded-lg bg-accent">
          <Lightbulb className="size-4" />
        </span>
        <CardTitle className="text-base">
          Website insights (Google Analytics)
        </CardTitle>
        <span
          className={cn(
            "ml-auto rounded-full px-2 py-0.5 text-xs font-medium",
            MODE_TONE[mode] ?? MODE_TONE.off,
          )}
        >
          {MODE_LABEL[mode] ?? MODE_LABEL.off}
        </span>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Tile label="Open (shadow)" value={counters.openShadow} />
          <Tile label="Open (live)" value={counters.openLive} />
          <Tile label="New in 7 days" value={counters.createdLast7d} />
          <Tile
            label="Reviewable"
            value={counters.reviewable}
            hint="Open findings in projects you can open"
          />
          <Tile label="Reviewed" value={counters.reviewed} />
          <Tile
            label="Useful %"
            value={precisionText(counters.precision, counters.reviewed)}
            hint={
              counters.reviewed < PRECISION_TARGET_REVIEWS
                ? "Target ≥ 70% on 30 reviewed"
                : undefined
            }
          />
          <Tile label="Links analyzed" value={counters.linksAnalyzed} />
          <Tile label="Links due" value={counters.linksDue} />
          <Tile label="Last run" value={lastRun} />
        </div>

        {byRule.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5" aria-label="Open by rule">
            {byRule.map((item) => (
              <li
                key={item.ruleKey}
                className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
              >
                {item.ruleKey} · {item.open}
              </li>
            ))}
          </ul>
        ) : null}

        <div className="space-y-2">
          <h3 className="text-xs font-medium text-muted-foreground">
            Recent findings in your projects
          </h3>
          {view.recent.length > 0 ? (
            <ul className="divide-y divide-foreground/10 text-sm">
              {view.recent.map((item) => (
                <li
                  key={item.id}
                  className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2 first:pt-0 last:pb-0"
                >
                  <span className="font-medium">{item.projectName}</span>
                  <span className="text-muted-foreground">·</span>
                  <span>{operatorFindingTitle(item.ruleKey, item.kind)}</span>
                  <span className="text-xs text-muted-foreground">
                    {findingConfidenceText(item.confidence)} ·{" "}
                    {timeAgo(item.createdAt)}
                    {item.mode === "shadow" ? " · Shadow" : ""}
                    {" · "}
                    {item.verdict ? VERDICT_TEXT[item.verdict] : "Not reviewed"}
                  </span>
                  <Link
                    href={`/projects/${item.projectId}/site?insights=review#finding-${item.id}`}
                    className="ml-auto text-xs font-medium underline-offset-2 hover:underline"
                  >
                    Review
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              {
                "No findings in your projects yet. Join a project's workspace to review its findings."
              }
            </p>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Counts only. Customer figures and page addresses are never shown here.
        </p>
      </CardContent>
    </Card>
  );
}
