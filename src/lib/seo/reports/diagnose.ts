import {
  formatCount,
  formatPosition,
} from "@/lib/module-flows/analytics/format";
import { coverageDropped } from "@/lib/seo/coverage";
import { addDays, dayKeyToDate } from "@/lib/seo/dates";
import type { GscTotals } from "@/lib/seo/totals";

import {
  DIAGNOSE_CAUSE,
  DIAGNOSE_STEP_QUESTION,
  changeTextFromRatio,
} from "./text";
import type {
  DiagnoseAsk,
  DiagnoseInput,
  DiagnosePage,
  DiagnoseStep,
  DiagnoseStepKey,
  DiagnoseVerdict,
  SearchDiagnosis,
} from "./types";

// Tıklama düşüşü teşhis ağacı (docs/search-reports.md "Teşhis ağacı"). Saf ve
// drill'lerle sınanır. Sekiz adım sabit sırayla (veri → indeksleme → teknik →
// güncelleme → talep → sıralama → CTR → yamyamlık) cevap verir; düşüş varsa
// ilk "yes" birincil nedendir. Her adım, kanıt cümlelerinde yazdığı türetilmiş
// sayıları `metrics`te aynen (büyüklük olarak, yazıldığı gibi yuvarlanmış)
// taşır; böylece sayı denetimi her kanıt sayısını doğrulayabilir.

export const DIAGNOSE_STEP_ORDER: readonly DiagnoseStepKey[] = [
  "data",
  "indexing",
  "technical",
  "update",
  "demand",
  "ranking",
  "ctr",
  "cannibalization",
];

export const DIAG_DROP = -0.15;
export const DIAG_MIN_PREVIOUS = 30;
export const DIAG_STALE_DAYS = 6;
export const DIAG_POSITION_WORSE = 1;
export const DIAG_CTR_DROP = -0.15;
export const DIAG_DEMAND_DROP = -0.15;
export const DIAG_SEASONAL_DROP = -0.1;
export const DIAG_LOST_SHARE = 0.3;
export const DIAG_UPDATE_LEAD_DAYS = 3;
export const DIAG_MIN_DEMAND_IMPRESSIONS = 100;

export const DATA_ALERT_KINDS: readonly string[] = [
  "GSC_SYNC_STALE",
  "GSC_CONNECTION",
  "GSC_SITE_MISMATCH",
];
export const INDEXING_ALERT_KINDS: readonly string[] = [
  "GSC_INDEX_LOST",
  "GSC_COVERAGE_DROP",
  "GSC_NEW_PAGES_NOT_INDEXED",
  "GSC_CRAWLED_NOT_INDEXED",
];
export const TECHNICAL_ALERT_KINDS: readonly string[] = [
  "SEO_KEY_PAGE_NOINDEX",
  "SEO_ROBOTS_BLOCK",
  "SEO_ROBOTS_ERROR",
  "SEO_KEY_PAGE_ERROR",
  "GSC_CANONICAL_MISMATCH",
  "SEO_CANONICAL_OFFSITE",
  "GSC_LOST_URLS",
  "SEO_SITE_MIGRATION",
  "SEO_HTTPS",
  "SEO_CRAWL_BLOCKED",
];
export const RANKING_UPDATE_KINDS: readonly string[] = [
  "CORE",
  "SPAM",
  "HELPFUL_CONTENT",
  "REVIEWS",
  "OTHER_RANKING",
];
export const INDEXING_INCIDENT_KINDS: readonly string[] = [
  "INDEXING",
  "CRAWLING",
];
export const SERVING_INCIDENT_KINDS: readonly string[] = ["SERVING"];

const EVIDENCE_LIMIT = 4;
const ITEM_LIMIT = 5;
// Yamyamlık: kayıp tıklama alt sınırı ve pay eşikleri.
const CANNIBAL_MIN_LOST = 5;
const CANNIBAL_TOP_SHARE = 0.6;
const CANNIBAL_SHARE_SHIFT = 0.3;

const MANUAL_ACTIONS_TEXT =
  "Open Search Console → Security & Manual Actions → Manual actions. Agentelse can't see this report.";
const SECURITY_ISSUES_TEXT =
  "Open Search Console → Security & Manual Actions → Security issues. Agentelse can't see this report.";

// (c − p) / p; önceki değer 0 ya da altındaysa null.
export function changeRatio(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  if (previous <= 0) return null;
  return (current - previous) / previous;
}

type Pair = { current: GscTotals; previous: GscTotals };
type Draft = Omit<DiagnoseStep, "key" | "question">;

function sumOf(
  rows: readonly Pair[],
  which: "current" | "previous",
): GscTotals {
  const total: GscTotals = { clicks: 0, impressions: 0, positionWeighted: 0 };
  for (const row of rows) {
    total.clicks += row[which].clicks;
    total.impressions += row[which].impressions;
    total.positionWeighted += row[which].positionWeighted;
  }
  return total;
}

// Σ positionWeighted / Σ gösterim; gösterim yoksa null.
function avgPos(totals: GscTotals): number | null {
  return totals.impressions > 0
    ? totals.positionWeighted / totals.impressions
    : null;
}

function ctrOf(totals: GscTotals): number | null {
  return totals.impressions > 0 ? totals.clicks / totals.impressions : null;
}

function lostOf(row: Pair): number {
  return Math.max(0, row.previous.clicks - row.current.clicks);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

// Oran → yazıldığı gibi yuvarlanmış yüzde büyüklüğü.
function pctOf(ratio: number): number {
  return Math.round(Math.abs(ratio) * 100);
}

// Başlık zaten noktalama ile bitiyorsa nokta eklemez.
function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

function dayDiff(from: string, to: string): number {
  return Math.round(
    (dayKeyToDate(to).getTime() - dayKeyToDate(from).getTime()) / 86_400_000,
  );
}

type Update = DiagnoseInput["updates"][number];

// Güncelleme günlük aralıkla örtüşür mü; bitişi olmayan şu ana kadar sürer.
function overlaps(update: Update, from: string, to: string, today: string) {
  const start = update.startedAt.slice(0, 10);
  const end = update.endedAt ? update.endedAt.slice(0, 10) : today;
  return start <= to && end >= from;
}

function lostShare(
  pages: readonly DiagnosePage[],
  match: (page: DiagnosePage) => boolean,
): number {
  let total = 0;
  let matched = 0;
  for (const page of pages) {
    const lost = lostOf(page);
    total += lost;
    if (match(page)) matched += lost;
  }
  return total > 0 ? matched / total : 0;
}

function lostPageItems(
  pages: readonly DiagnosePage[],
  match: (page: DiagnosePage) => boolean,
  detail: (page: DiagnosePage, lost: number) => string,
): DiagnoseStep["items"] {
  return pages
    .filter((page) => lostOf(page) > 0 && match(page))
    .sort((a, b) => lostOf(b) - lostOf(a) || a.label.localeCompare(b.label))
    .slice(0, ITEM_LIMIT)
    .map((page) => ({ label: page.label, detail: detail(page, lostOf(page)) }));
}

function lostClicksText(lost: number): string {
  return `Lost ${formatCount(lost)} ${plural(lost, "click", "clicks")}`;
}

function unknownDraft(text: string): Draft {
  return { verdict: "unknown", evidence: [text], metrics: {}, items: [] };
}

function finish(
  key: DiagnoseStepKey,
  verdict: DiagnoseVerdict,
  draft: Pick<Draft, "evidence" | "metrics" | "items">,
): DiagnoseStep {
  return {
    key,
    question: DIAGNOSE_STEP_QUESTION[key],
    verdict,
    evidence: draft.evidence.slice(0, EVIDENCE_LIMIT),
    metrics: draft.metrics,
    items: draft.items.slice(0, ITEM_LIMIT),
  };
}

function withKey(key: DiagnoseStepKey, draft: Draft): DiagnoseStep {
  return finish(key, draft.verdict, draft);
}

// ---------------------------------------------------------------------------
// Adımlar
// ---------------------------------------------------------------------------

function dataStep(input: DiagnoseInput): DiagnoseStep {
  const { data, today } = input;
  const evidence: string[] = [];
  const metrics: Record<string, number> = {};

  if (data.linkHealth !== "OK" && data.linkHealth !== "UNKNOWN") {
    evidence.push("The Search Console connection reports a problem.");
  }
  if (data.finalThrough === null) {
    evidence.push("No final Search Console data is stored yet.");
  } else if (data.finalThrough < addDays(today, -DIAG_STALE_DAYS)) {
    const staleDays = dayDiff(data.finalThrough, today);
    metrics.staleDays = staleDays;
    evidence.push(
      `The latest final data is ${formatCount(staleDays)} days old.`,
    );
  }
  if (data.missingDays > 0) {
    metrics.missingDays = data.missingDays;
    evidence.push(
      `${formatCount(data.missingDays)} ${plural(data.missingDays, "day is", "days are")} missing from the stored data in this period.`,
    );
  }
  if (data.freshDays > 0) {
    metrics.freshDays = data.freshDays;
    evidence.push(
      `${formatCount(data.freshDays)} ${plural(data.freshDays, "day is", "days are")} still being revised by Google.`,
    );
  }
  if (!data.backfillDone) {
    evidence.push("The history import is still running.");
  }
  if (data.alertKinds.some((kind) => DATA_ALERT_KINDS.includes(kind))) {
    evidence.push("A Search Console data alert is open.");
  }

  const verdict: DiagnoseVerdict = evidence.length > 0 ? "yes" : "no";
  if (verdict === "no") {
    evidence.push(
      "The stored data for this period is complete and up to date.",
    );
  }

  // Google'ın "serving" olayı tek başına veri sorunu saymaz; yalnız kanıt ekler.
  if (input.updatesAvailable) {
    const serving = input.updates.find(
      (update) =>
        SERVING_INCIDENT_KINDS.includes(update.kind) &&
        overlaps(
          update,
          addDays(input.window.current.from, -DIAG_UPDATE_LEAD_DAYS),
          input.window.current.to,
          today,
        ),
    );
    if (serving) {
      evidence.push(
        `Google reported a search serving incident: ${sentence(serving.name)}`,
      );
    }
  }
  return finish("data", verdict, { evidence, metrics, items: [] });
}

function indexingStep(input: DiagnoseInput): DiagnoseStep {
  if (!input.health.available) {
    return withKey(
      "indexing",
      unknownDraft("Search health checks aren't turned on for this site."),
    );
  }
  const evidence: string[] = [];
  const metrics: Record<string, number> = {};

  const alerts = input.health.alerts.filter(
    (alert) =>
      INDEXING_ALERT_KINDS.includes(alert.kind) && alert.severity !== "INFO",
  );
  for (const alert of alerts.slice(0, 2)) {
    evidence.push(`Open alert: ${sentence(alert.title)}`);
  }

  const coverage = input.health.coverage;
  if (
    coverage?.current &&
    coverage.previous &&
    coverageDropped(coverage.previous, coverage.current)
  ) {
    metrics.coverageBeforePct = Math.round(coverage.previous.point * 100);
    metrics.coverageNowPct = Math.round(coverage.current.point * 100);
    evidence.push(
      `Estimated index coverage fell from ${metrics.coverageBeforePct}% to ${metrics.coverageNowPct}%.`,
    );
  }

  const notIndexed = (page: DiagnosePage) => page.indexed === false;
  const share = lostShare(input.pages, notIndexed);
  if (share >= DIAG_LOST_SHARE) {
    metrics.lostSharePct = Math.round(share * 100);
    evidence.push(
      `Pages that Google doesn't index carry ${metrics.lostSharePct}% of the lost clicks.`,
    );
  }

  if (input.updatesAvailable) {
    const incident = input.updates.find(
      (update) =>
        INDEXING_INCIDENT_KINDS.includes(update.kind) &&
        overlaps(
          update,
          addDays(input.window.current.from, -DIAG_UPDATE_LEAD_DAYS),
          input.window.current.to,
          input.today,
        ),
    );
    if (incident) {
      evidence.push(
        `Google reported an indexing or crawling incident: ${sentence(incident.name)}`,
      );
    }
  }

  const verdict: DiagnoseVerdict = evidence.length > 0 ? "yes" : "no";
  if (verdict === "no") {
    evidence.push("There's no sign of pages dropping out of Google's index.");
  }
  return finish("indexing", verdict, {
    evidence,
    metrics,
    items: lostPageItems(input.pages, notIndexed, (_page, lost) =>
      lostClicksText(lost),
    ),
  });
}

function technicalStep(input: DiagnoseInput): DiagnoseStep {
  if (!input.health.available) {
    return withKey(
      "technical",
      unknownDraft("Search health checks aren't turned on for this site."),
    );
  }
  const evidence: string[] = [];
  const metrics: Record<string, number> = {};

  const alerts = input.health.alerts.filter(
    (alert) =>
      TECHNICAL_ALERT_KINDS.includes(alert.kind) && alert.severity !== "INFO",
  );
  for (const alert of alerts.slice(0, 2)) {
    evidence.push(`Open alert: ${sentence(alert.title)}`);
  }

  const blocked = (page: DiagnosePage) =>
    (page.status !== null && page.status >= 400) || page.noindex === true;
  const share = lostShare(input.pages, blocked);
  if (share >= DIAG_LOST_SHARE) {
    metrics.lostSharePct = Math.round(share * 100);
    evidence.push(
      `Pages with errors or a noindex tag carry ${metrics.lostSharePct}% of the lost clicks.`,
    );
  }

  const verdict: DiagnoseVerdict = evidence.length > 0 ? "yes" : "no";
  if (verdict === "no") {
    evidence.push("Nothing on the site looks like it's blocking Google.");
  }
  return finish("technical", verdict, {
    evidence,
    metrics,
    items: lostPageItems(input.pages, blocked, (page, lost) =>
      page.noindex === true
        ? `Has a noindex tag. ${lostClicksText(lost)}`
        : `Returns status ${page.status}. ${lostClicksText(lost)}`,
    ),
  });
}

function updateStep(input: DiagnoseInput): DiagnoseStep {
  if (!input.updatesAvailable) {
    return withKey(
      "update",
      unknownDraft("Google's update history isn't available."),
    );
  }
  const from = addDays(input.window.current.from, -DIAG_UPDATE_LEAD_DAYS);
  const found = input.updates.filter(
    (update) =>
      RANKING_UPDATE_KINDS.includes(update.kind) &&
      overlaps(update, from, input.window.current.to, input.today),
  );
  if (found.length === 0) {
    return finish("update", "no", {
      evidence: ["No Google ranking update overlaps this period."],
      metrics: {},
      items: [],
    });
  }
  return finish("update", "yes", {
    evidence: found
      .slice(0, 2)
      .map(
        (update) =>
          `Google reported a ranking update that overlaps this period: ${sentence(update.name)}`,
      ),
    metrics: {},
    items: [],
  });
}

// Önceki dönemde tıklama getiren sorgular (eşleşen küme).
function matched<T extends Pair>(rows: readonly T[]): T[] {
  return rows.filter((row) => row.previous.clicks > 0);
}

function positionShift(rows: readonly Pair[]): {
  before: number | null;
  now: number | null;
  delta: number | null;
} {
  const before = avgPos(sumOf(rows, "previous"));
  const now = avgPos(sumOf(rows, "current"));
  return {
    before,
    now,
    delta: before !== null && now !== null ? now - before : null,
  };
}

function demandStep(input: DiagnoseInput): DiagnoseStep {
  const rows = matched(input.queries);
  const previous = sumOf(rows, "previous");
  const current = sumOf(rows, "current");
  if (previous.impressions < DIAG_MIN_DEMAND_IMPRESSIONS) {
    return withKey(
      "demand",
      unknownDraft("There aren't enough searches to tell if demand changed."),
    );
  }
  const impressions = changeRatio(current.impressions, previous.impressions);
  const { delta } = positionShift(rows);
  const stable = delta === null || Math.abs(delta) < DIAG_POSITION_WORSE;
  const verdict: DiagnoseVerdict =
    impressions !== null && impressions <= DIAG_DEMAND_DROP && stable
      ? "yes"
      : "no";

  const evidence: string[] = [];
  const metrics: Record<string, number> = {};
  if (impressions !== null) {
    metrics.impressionsChangePct = pctOf(impressions);
    evidence.push(
      `Impressions for the searches that used to bring clicks ${impressions < 0 ? "fell" : "rose"} ${metrics.impressionsChangePct}%.`,
    );
  }
  if (delta !== null) {
    metrics.positionShift = round1(Math.abs(delta));
    evidence.push(
      `Their average position moved by ${formatPosition(metrics.positionShift)}.`,
    );
  }
  if (input.yearAgo) {
    const lastYear = changeRatio(
      input.yearAgo.current.clicks,
      input.yearAgo.previous.clicks,
    );
    if (lastYear !== null && lastYear <= DIAG_SEASONAL_DROP) {
      metrics.yearAgoChangePct = pctOf(lastYear);
      evidence.push(
        `The same weeks last year also fell by ${metrics.yearAgoChangePct}%.`,
      );
    }
  }
  return finish("demand", verdict, { evidence, metrics, items: [] });
}

function rankingStep(input: DiagnoseInput): DiagnoseStep {
  const rows = matched(input.queries);
  const { before, now, delta } = positionShift(rows);
  if (before === null || now === null || delta === null) {
    return withKey(
      "ranking",
      unknownDraft("There isn't enough query data to compare positions."),
    );
  }
  const verdict: DiagnoseVerdict = delta >= DIAG_POSITION_WORSE ? "yes" : "no";
  const metrics = { positionBefore: round1(before), positionNow: round1(now) };
  const evidence = [
    `Average position on the searches that used to bring clicks went from ${formatPosition(metrics.positionBefore)} to ${formatPosition(metrics.positionNow)}.`,
  ];

  // Sayfa bazında: tıklama kaybeden ve konumu en çok kötüleşenler.
  const items = input.pages
    .map((page) => {
      const pageBefore = avgPos(page.previous);
      const pageNow = avgPos(page.current);
      return {
        page,
        before: pageBefore,
        now: pageNow,
        worse:
          pageBefore !== null && pageNow !== null ? pageNow - pageBefore : null,
      };
    })
    .filter(
      (entry) =>
        lostOf(entry.page) > 0 && entry.worse !== null && entry.worse > 0,
    )
    .sort(
      (a, b) =>
        (b.worse ?? 0) - (a.worse ?? 0) ||
        a.page.label.localeCompare(b.page.label),
    )
    .slice(0, ITEM_LIMIT)
    .map((entry) => ({
      label: entry.page.label,
      detail: `Position ${formatPosition(round1(entry.before ?? 0))} to ${formatPosition(round1(entry.now ?? 0))}. ${lostClicksText(lostOf(entry.page))}`,
    }));
  return finish("ranking", verdict, { evidence, metrics, items });
}

function ctrStep(input: DiagnoseInput): DiagnoseStep {
  const rows = matched(input.queries);
  const { delta } = positionShift(rows);
  const before = ctrOf(sumOf(rows, "previous"));
  const now = ctrOf(sumOf(rows, "current"));
  const change =
    before !== null && now !== null && before > 0 ? now / before - 1 : null;
  if (delta === null || change === null) {
    return withKey(
      "ctr",
      unknownDraft("There isn't enough query data to compare click rates."),
    );
  }
  const samePosition = Math.abs(delta) < DIAG_POSITION_WORSE;
  const verdict: DiagnoseVerdict =
    samePosition && change <= DIAG_CTR_DROP ? "yes" : "no";
  const metrics = { ctrChangePct: pctOf(change) };
  const evidence = [
    `The click-through rate on those searches ${change < 0 ? "fell" : "rose"} ${metrics.ctrChangePct}%${samePosition ? " at about the same position" : ""}.`,
  ];
  if (verdict === "yes") {
    evidence.push(
      "AI Overviews or new search features can take clicks at the same position.",
    );
  }
  return finish("ctr", verdict, { evidence, metrics, items: [] });
}

function cannibalizationStep(input: DiagnoseInput): DiagnoseStep {
  if (input.pairs.length === 0) {
    return withKey(
      "cannibalization",
      unknownDraft("No search and page pairs are stored for this period yet."),
    );
  }
  const byQuery = new Map<string, DiagnoseInput["pairs"]>();
  for (const pair of input.pairs) {
    const list = byQuery.get(pair.queryId);
    if (list) list.push(pair);
    else byQuery.set(pair.queryId, [pair]);
  }
  const labels = new Map(input.queries.map((query) => [query.id, query.label]));

  const found: { label: string; detail: string; lost: number }[] = [];
  for (const [queryId, pairs] of byQuery) {
    const prevTotal = pairs.reduce((sum, p) => sum + p.previous.clicks, 0);
    const curTotal = pairs.reduce((sum, p) => sum + p.current.clicks, 0);
    const lost = prevTotal - curTotal;
    if (lost < CANNIBAL_MIN_LOST || prevTotal <= 0 || curTotal <= 0) continue;

    // Önceki dönemin en çok tıklanan sayfası.
    const top = [...pairs].sort(
      (a, b) =>
        b.previous.clicks - a.previous.clicks || a.path.localeCompare(b.path),
    )[0]!;
    const topBefore = top.previous.clicks / prevTotal;
    const topNow = top.current.clicks / curTotal;
    if (topBefore < CANNIBAL_TOP_SHARE) continue;
    if (topBefore - topNow < CANNIBAL_SHARE_SHIFT - 1e-9) continue;

    const taker = pairs
      .filter((p) => p.pageId !== top.pageId)
      .map((p) => ({
        pair: p,
        gain: p.current.clicks / curTotal - p.previous.clicks / prevTotal,
      }))
      .filter((entry) => entry.gain >= CANNIBAL_SHARE_SHIFT - 1e-9)
      .sort(
        (a, b) => b.gain - a.gain || a.pair.path.localeCompare(b.pair.path),
      )[0];
    if (!taker) continue;
    found.push({
      label: labels.get(queryId) ?? queryId,
      detail: `${top.path} → ${taker.pair.path}`,
      lost,
    });
  }

  if (found.length === 0) {
    return finish("cannibalization", "no", {
      evidence: ["No search lost clicks to another of your pages."],
      metrics: {},
      items: [],
    });
  }
  found.sort((a, b) => b.lost - a.lost || a.label.localeCompare(b.label));
  const metrics = { queries: found.length };
  return finish("cannibalization", "yes", {
    evidence: [
      `${formatCount(found.length)} ${plural(found.length, "search", "searches")} lost clicks while another of your pages took over the top spot.`,
    ],
    metrics,
    items: found.map((entry) => ({ label: entry.label, detail: entry.detail })),
  });
}

// ---------------------------------------------------------------------------
// Ağaç
// ---------------------------------------------------------------------------

export function diagnoseSearchDrop(input: DiagnoseInput): SearchDiagnosis {
  const { current, previous } = input.totals;
  const change = changeRatio(current.clicks, previous.clicks);
  const dropped =
    previous.clicks >= DIAG_MIN_PREVIOUS &&
    change !== null &&
    change <= DIAG_DROP;

  const steps: DiagnoseStep[] = [
    dataStep(input),
    indexingStep(input),
    technicalStep(input),
    updateStep(input),
    demandStep(input),
    rankingStep(input),
    ctrStep(input),
    cannibalizationStep(input),
  ];

  const yes = steps.filter((step) => step.verdict === "yes");
  const primary = dropped ? (yes[0]?.key ?? null) : null;
  const also = dropped
    ? yes.filter((step) => step.key !== primary).map((step) => step.key)
    : [];

  const askUser: DiagnoseAsk[] = dropped
    ? [
        { screen: "Manual actions", text: MANUAL_ACTIONS_TEXT },
        { screen: "Security issues", text: SECURITY_ISSUES_TEXT },
      ]
    : [];

  const label =
    input.metric === "nonBrandClicks" ? "Non-brand clicks" : "Clicks";
  let summary: string;
  if (!dropped) {
    summary = `${label} did not drop in this period (${changeTextFromRatio(change)}).`;
  } else if (primary) {
    summary = `Most likely cause: ${DIAGNOSE_CAUSE[primary]}.`;
  } else {
    summary =
      "No single cause stands out. Check the steps below and the two Search Console screens.";
  }

  return {
    v: 1,
    metric: input.metric,
    window: input.window,
    current: current.clicks,
    previous: previous.clicks,
    changePct: change,
    dropped,
    primary,
    also,
    steps,
    askUser,
    summary,
  };
}
