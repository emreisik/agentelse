import type { SearchConsoleQueryRow } from "@/server/integrations/google-client";

// Pure, deterministic rule engine — mirrors meta-performance-rules.ts.
// No server-only import, no DB, no network. Fixed input -> fixed output.

export type SeoFinding = {
  rule: "DECLINING_TRAFFIC" | "CONTENT_OPPORTUNITY";
  // Distinguishes multiple CONTENT_OPPORTUNITY findings from the same scan
  // (one per query) — used to build a unique externalRef for signal dedup.
  key?: string;
  title: string;
  summary: string;
  metricsSnapshot: Record<string, number | string | undefined>;
};

const TRAFFIC_DECLINE_THRESHOLD = 0.2; // 20% session drop vs the previous scan
const CONTENT_OPPORTUNITY_MIN_IMPRESSIONS = 100;
const CONTENT_OPPORTUNITY_MAX_CTR = 0.02; // 2%
const CONTENT_OPPORTUNITY_POSITION_MIN = 8;
const CONTENT_OPPORTUNITY_POSITION_MAX = 20;
const MAX_CONTENT_OPPORTUNITIES = 3; // cap per scan — avoid flooding the signal feed

// Scan-over-scan trend (like Meta's evaluateTrendFinding), not a fixed
// calendar week — there's no dedicated GA4 date-range comparison call yet,
// and this keeps the same "diff against the last stored scan" pattern
// google-analytics-scanner.ts already uses for Search Console.
// GA_INSIGHTS=on iken (ve GA_INSIGHTS_PROJECTS projelerinde) çağrılmaz: tarayıcı GA bağlantılarını atlar, düşüşleri GA-F4 analiz motoru (AN1 anomali, AN2 ayrıştırma) haftanın günü tabanıyla bulur. Bayrak kapalıyken bu kural aynen çalışır.
export function evaluateTrafficFinding(input: {
  current: { activeUsers: number; sessions: number };
  previous?: { activeUsers: number; sessions: number };
}): SeoFinding | null {
  const { current, previous } = input;
  if (!previous || previous.sessions <= 0) return null;

  const change = (current.sessions - previous.sessions) / previous.sessions;
  if (change > -TRAFFIC_DECLINE_THRESHOLD) return null;

  return {
    rule: "DECLINING_TRAFFIC",
    title: "Site traffic declining",
    summary: `Sessions dropped ${Math.round(Math.abs(change) * 100)}% since the last scan (${previous.sessions} -> ${current.sessions}).`,
    metricsSnapshot: {
      currentSessions: current.sessions,
      previousSessions: previous.sessions,
    },
  };
}

// Search Console rows where the page/query is already earning meaningful
// impressions and ranks close to page one (8-20) but isn't converting that
// visibility into clicks — the "almost ranking, needs stronger content"
// pattern that's currently invisible to the agency loop.
export function evaluateContentOpportunities(
  rows: SearchConsoleQueryRow[],
): SeoFinding[] {
  return rows
    .filter(
      (row) =>
        row.impressions >= CONTENT_OPPORTUNITY_MIN_IMPRESSIONS &&
        row.ctr <= CONTENT_OPPORTUNITY_MAX_CTR &&
        row.position >= CONTENT_OPPORTUNITY_POSITION_MIN &&
        row.position <= CONTENT_OPPORTUNITY_POSITION_MAX,
    )
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, MAX_CONTENT_OPPORTUNITIES)
    .map((row) => {
      const query = row.keys[0] ?? "unknown query";
      return {
        rule: "CONTENT_OPPORTUNITY" as const,
        key: query,
        title: `Content opportunity: "${query}"`,
        summary: `"${query}" gets ${row.impressions} impressions at position ${row.position.toFixed(1)} but only ${(row.ctr * 100).toFixed(2)}% CTR — stronger content on this topic could convert more of that existing visibility.`,
        metricsSnapshot: {
          impressions: row.impressions,
          ctr: row.ctr,
          position: row.position,
        },
      };
    });
}

export function evaluateSeoFindings(input: {
  ga4?: {
    current: { activeUsers: number; sessions: number };
    previous?: { activeUsers: number; sessions: number };
  };
  gscRows: SearchConsoleQueryRow[];
}): SeoFinding[] {
  const findings: SeoFinding[] = [];
  if (input.ga4) {
    const trafficFinding = evaluateTrafficFinding(input.ga4);
    if (trafficFinding) findings.push(trafficFinding);
  }
  findings.push(...evaluateContentOpportunities(input.gscRows));
  return findings;
}
