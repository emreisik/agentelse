import { addDays } from "@/lib/seo/dates";

import type { BqBadge, SiteRole } from "./types";

// Çalışma alanı "Search" genel bakışı (/search) için saf mantık: satır
// biçimi, dikkat puanı, süzgeç, sıralama ve toplamlar. Ambar okuması
// src/server/seo/agency/overview.ts'tedir.

export type SearchAgencyRow = {
  linkId: string;
  projectId: string;
  projectName: string;
  siteUrl: string;
  siteLabel: string;
  role: SiteRole;
  isMock: boolean;
  health: string;
  healthReason: string | null;
  finalThrough: string | null;
  backfillDone: boolean;
  clicks: number | null;
  previousClicks: number | null;
  // Yüzde, tek ondalık; 56 günlük veri yoksa null
  clicksChangePct: number | null;
  impressions: number | null;
  position: number | null;
  healthScore: number | null;
  healthCapped: boolean;
  openOpportunities: number | null;
  critical: number;
  warn: number;
  bigQuery: BqBadge;
  attention: number;
  attentionReasons: string[];
};

export type SearchAgencyTotals = {
  sites: number;
  projects: number;
  clicks: number;
  previousClicks: number;
  needAttention: number;
  critical: number;
};

export type SearchAgencyOverview = {
  rows: SearchAgencyRow[];
  totals: SearchAgencyTotals;
  truncated: boolean;
};

export type AgencyFilter = "all" | "attention" | "secondary" | "bigquery";

const FILTERS: readonly AgencyFilter[] = [
  "all",
  "attention",
  "secondary",
  "bigquery",
];

// Bu puanın üstü "dikkat ister" sayılır.
export const ATTENTION_THRESHOLD = 30;

export function parseAgencyFilter(value: unknown): AgencyFilter {
  return typeof value === "string" &&
    (FILTERS as readonly string[]).includes(value)
    ? (value as AgencyFilter)
    : "all";
}

const BROKEN_HEALTH = new Set([
  "AUTH",
  "NEEDS_PERMISSION",
  "ACCESS_LOST",
  "GONE",
  "API_DISABLED",
]);

// Kaç gün eski veri "güncel değil" sayılır (PT günü).
const STALE_DAYS = 5;

export function attentionOf(
  row: Pick<
    SearchAgencyRow,
    | "health"
    | "critical"
    | "clicksChangePct"
    | "previousClicks"
    | "finalThrough"
    | "bigQuery"
  >,
  today: string,
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  if (BROKEN_HEALTH.has(row.health)) {
    score += 50;
    reasons.push("Search Console needs attention");
  } else if (row.health === "DEGRADED") {
    score += 30;
    reasons.push("Search Console updates are failing");
  }
  if (row.critical > 0) {
    score += Math.min(45, row.critical * 15);
    reasons.push(
      row.critical === 1
        ? "1 critical issue"
        : `${row.critical} critical issues`,
    );
  }
  if (
    row.clicksChangePct !== null &&
    row.clicksChangePct <= -20 &&
    (row.previousClicks ?? 0) >= 100
  ) {
    score += 25;
    reasons.push(`Clicks fell ${Math.round(Math.abs(row.clicksChangePct))}%`);
  }
  if (row.finalThrough !== null && row.finalThrough < addDays(today, -STALE_DAYS)) {
    score += 20;
    reasons.push("Data is out of date");
  }
  if (row.bigQuery === "ERROR") {
    score += 15;
    reasons.push("BigQuery export needs attention");
  }
  return { score: Math.min(100, score), reasons };
}

export function applyAgencyFilter(
  rows: readonly SearchAgencyRow[],
  filter: AgencyFilter,
): SearchAgencyRow[] {
  switch (filter) {
    case "attention":
      return rows.filter((row) => row.attention >= ATTENTION_THRESHOLD);
    case "secondary":
      return rows.filter((row) => row.role === "SECONDARY");
    case "bigquery":
      return rows.filter((row) => row.bigQuery !== "OFF");
    default:
      return [...rows];
  }
}

// Dikkat azalan, tıklama azalan (boş sona), site adı artan; son eşitlik
// bozucu bağ kimliği, sıra her yüklemede aynı kalsın.
export function sortAgencyRows(
  rows: readonly SearchAgencyRow[],
): SearchAgencyRow[] {
  return [...rows].sort(
    (a, b) =>
      b.attention - a.attention ||
      (b.clicks ?? -1) - (a.clicks ?? -1) ||
      a.siteLabel.localeCompare(b.siteLabel) ||
      a.linkId.localeCompare(b.linkId),
  );
}

export function summarize(rows: readonly SearchAgencyRow[]): SearchAgencyTotals {
  return {
    sites: rows.length,
    projects: new Set(rows.map((row) => row.projectId)).size,
    clicks: rows.reduce((sum, row) => sum + (row.clicks ?? 0), 0),
    previousClicks: rows.reduce((sum, row) => sum + (row.previousClicks ?? 0), 0),
    needAttention: rows.filter((row) => row.attention >= ATTENTION_THRESHOLD)
      .length,
    critical: rows.reduce((sum, row) => sum + row.critical, 0),
  };
}
