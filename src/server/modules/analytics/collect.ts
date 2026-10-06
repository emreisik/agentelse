import "server-only";

import {
  orderedSources,
  type AnalyticsPeriod,
  type AnalyticsSource,
} from "@/lib/module-flows/analytics/catalog";
import {
  failedSection,
  type ReportData,
  type ReportSection,
} from "@/lib/module-flows/analytics/report";
import {
  findActiveGoogleConnections,
  type ActiveGoogleConnections,
} from "@/server/integrations/google-connections";

import { collectGa4, collectSearchConsole } from "./google";
import { collectInstagram } from "./instagram";
import { collectMetaAds } from "./meta-ads";

// Collects a report from REAL data (docs/modules.md "Analytics"): every asked
// source is read at the same time and on its own, so one that fails (not
// connected, expired, rate limited, down) becomes its section's reason while
// the others still report. Never throws. The summary is written afterwards,
// from these numbers only (summary.ts).

export async function collectReport(
  projectId: string,
  period: AnalyticsPeriod,
  sections: readonly AnalyticsSource[],
  now: number = Date.now(),
): Promise<ReportData> {
  const wanted = orderedSources(sections);
  const google: Promise<ActiveGoogleConnections | null> =
    wanted.includes("ga4") || wanted.includes("searchConsole")
      ? findActiveGoogleConnections(projectId).catch((error: unknown) => {
          console.error(
            "[analytics] google connections read failed:",
            error instanceof Error ? error.message : error,
          );
          return null;
        })
      : Promise.resolve(null);

  const read = async (source: AnalyticsSource): Promise<ReportSection> => {
    switch (source) {
      case "instagram":
        return collectInstagram(projectId, period, now);
      case "metaAds":
        return collectMetaAds(projectId, period);
      case "ga4": {
        const connections = await google;
        if (!connections) return failedSection("ga4", "error");
        return collectGa4(connections.analytics, period, projectId);
      }
      case "searchConsole": {
        const connections = await google;
        if (!connections) return failedSection("searchConsole", "error");
        return collectSearchConsole(connections.searchConsole, period);
      }
    }
  };

  const collected = await Promise.all(
    wanted.map((source) =>
      read(source).catch((error: unknown) => {
        console.error(
          `[analytics] ${source} read failed:`,
          error instanceof Error ? error.message : error,
        );
        return failedSection(source, "error");
      }),
    ),
  );

  return {
    period,
    builtAt: new Date(now).toISOString(),
    sections: collected,
    summary: null,
    summaryNote: null,
  };
}
