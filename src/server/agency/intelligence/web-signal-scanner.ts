import "server-only";

import type { SignalCategory } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { ConstitutionService } from "@/server/agency/constitution/constitution-service";
import { SignalUniverse } from "@/server/agency/signals/signal-universe";
import {
  MAX_WEB_SIGNALS,
  WEB_SIGNAL_CATEGORIES,
  webSignalScanDef,
  type WebSignalScanOutput,
} from "@/server/reasoning/prompts/web-signal-scan";
import { ReasoningService } from "@/server/reasoning/reasoning-service";
import { isProjectAgencyActive } from "@/server/repositories/agency-loop-state.repository";

// The Brand Brain's weekly look at the outside world: once a week per active
// project, one web-searching call reports what moved in the brand's market
// (competitors, trends, cultural moments, news) as sourced signals. They go in
// through the signal front door, so the usual chain takes over: scoring ->
// insight -> opportunity -> the daily idea step -> the idea pool -> plans.
// The last scan is the newest ReasoningCall of this purpose: no extra state.

const SCAN_INTERVAL_MS = 7 * 24 * 60 * 60_000;
// A failed scan is tried again after this long, not on every tick.
const FAILED_RETRY_MS = 6 * 60 * 60_000;
const SOURCE = "web-scan";
// Public pages found by a search: useful, not as solid as the brand's own
// numbers (Meta, GA4).
const RELIABILITY = 0.6;
const MAX_TITLE = 200;
const MAX_SUMMARY = 1000;

type Attempt = { createdAt: Date; status: string };

export function webScanDue(last: Attempt | null, now: Date): boolean {
  if (!last) return true;
  const age = now.getTime() - last.createdAt.getTime();
  return last.status === "OK"
    ? age >= SCAN_INTERVAL_MS
    : age >= FAILED_RETRY_MS;
}

export type WebSignal = {
  category: SignalCategory;
  title: string;
  summary: string;
  sourceUrl: string;
  occurredAt?: Date;
};

function httpUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function dayOf(raw: string | undefined, now: Date): Date | undefined {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined;
  const date = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return undefined;
  // An event can be ahead; nothing is a year ahead.
  return date.getTime() - now.getTime() > 366 * 24 * 60 * 60_000
    ? undefined
    : date;
}

// What the model reported, made safe to store: a real http(s) source on every
// signal, a known category (else MARKET), trimmed text, no repeats, at most
// MAX_WEB_SIGNALS.
export function normalizeWebSignals(
  output: WebSignalScanOutput,
  now: Date,
): WebSignal[] {
  const seen = new Set<string>();
  const signals: WebSignal[] = [];
  for (const raw of output.signals) {
    if (signals.length >= MAX_WEB_SIGNALS) break;
    const sourceUrl = httpUrl(raw.sourceUrl);
    const title = raw.title.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
    if (!sourceUrl || !title) continue;
    const key = `${sourceUrl}|${title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const category = (WEB_SIGNAL_CATEGORIES as readonly string[]).includes(
      raw.category,
    )
      ? (raw.category as SignalCategory)
      : "MARKET";
    signals.push({
      category,
      title,
      summary: raw.summary.trim().slice(0, MAX_SUMMARY),
      sourceUrl,
      occurredAt: dayOf(raw.date, now),
    });
  }
  return signals;
}

export const WebSignalScanner = {
  // At most `limit` projects per tick, the longest-unscanned first.
  async runDueScans(limit = 2, now: Date = new Date()): Promise<number> {
    const projects = await prisma.project.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, workspaceId: true },
    });
    if (projects.length === 0) return 0;

    const attempts = await prisma.reasoningCall.findMany({
      where: {
        purpose: webSignalScanDef.purpose,
        projectId: { in: projects.map((project) => project.id) },
      },
      orderBy: { createdAt: "desc" },
      distinct: ["projectId"],
      select: { projectId: true, createdAt: true, status: true },
    });
    const lastOf = new Map(
      attempts.map((attempt) => [attempt.projectId, attempt] as const),
    );
    const due = projects
      .filter((project) => webScanDue(lastOf.get(project.id) ?? null, now))
      .sort(
        (a, b) =>
          (lastOf.get(a.id)?.createdAt.getTime() ?? 0) -
          (lastOf.get(b.id)?.createdAt.getTime() ?? 0),
      );

    let scanned = 0;
    for (const project of due) {
      if (scanned >= limit) break;
      if (!(await isProjectAgencyActive(project.id))) continue;
      const brand = await prisma.brand.findFirst({
        where: { projectId: project.id, isDefault: true },
        select: { id: true, name: true },
      });
      if (!brand) continue;
      scanned += 1;
      try {
        await scanProject(
          {
            workspaceId: project.workspaceId,
            projectId: project.id,
            brandId: brand.id,
          },
          brand.name,
          now,
        );
      } catch (error) {
        console.error(
          `[web-signal-scanner] scan failed for project ${project.id}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
    return scanned;
  },
};

async function scanProject(
  scope: { workspaceId: string; projectId: string; brandId: string },
  brandName: string,
  now: Date,
): Promise<number> {
  const brand = await ConstitutionService.getBrandContext(scope.brandId);
  const markets = Array.isArray(brand.markets)
    ? (brand.markets as unknown[]).filter((m) => typeof m === "string")
    : [];
  const { output } = await ReasoningService.run(webSignalScanDef, {
    ...scope,
    context: {
      brandName,
      brand,
      today: now.toISOString().slice(0, 10),
      market: markets.join(", "),
    },
  });

  let ingested = 0;
  for (const signal of normalizeWebSignals(output, now)) {
    const result = await SignalUniverse.ingestRaw({
      ...scope,
      source: SOURCE,
      category: signal.category,
      externalRef: signal.sourceUrl,
      title: signal.title,
      summary: signal.summary,
      payload: { sourceUrl: signal.sourceUrl },
      occurredAt: signal.occurredAt,
      reliability: RELIABILITY,
    });
    if (!result.duplicate) ingested += 1;
  }
  return ingested;
}
