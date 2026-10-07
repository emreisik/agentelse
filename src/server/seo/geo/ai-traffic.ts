import "server-only";

import { hostTwin, inScope } from "@/lib/seo/crawl-url";
import { seoGeoTrafficEnabled } from "@/lib/seo/apply/flags";
import type { AiTrafficView } from "@/lib/seo/geo/view-types";
import { assistantTotals } from "@/lib/website-analytics/analysis/ai-referrals";
import { addDays } from "@/lib/website-analytics/days";
import { SeoSites } from "@/server/seo/site/sites";
import { loadGaWindowTables } from "@/server/website-analytics/analysis/windows";
import { primaryGaLink } from "@/server/website-analytics/store";

// AI yönlendirme trafiği köprüsü (SC-F8, docs/ai-search-visibility.md "AI
// trafiği köprüsü"): GA ambarındaki sourceMedium dilimleri son 28 gün ve
// önceki 28 gün için okunur ve YALNIZ AN7'nin paylaşılan assistantTotals
// yardımcısıyla toplanır (toplama burada yeniden yazılmaz). Sayılar canlı
// gösterilir; hiçbir yere kaydedilmez, modele ve Telegram'a gitmez. İki
// entegrasyon aynı projede olmalı ve GA akış alan adı kapsamla eşleşmeli ya da
// bilinmemeli; aksi hâlde null.

const WINDOW_DAYS = 28;
const ASSISTANTS_MAX = 8;
// Sağlıksız GA bağları (GA analiz koşucusuyla aynı liste).
const STOPPED_HEALTH: ReadonlySet<string> = new Set([
  "AUTH",
  "NEEDS_PERMISSION",
  "ACCESS_LOST",
  "GONE",
  "API_DISABLED",
]);

function streamHost(streamUri: string | null): string | null {
  if (!streamUri) return null;
  const text = streamUri.trim();
  if (!text) return null;
  try {
    return new URL(text.includes("://") ? text : `https://${text}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

type Scope = NonNullable<
  Awaited<ReturnType<typeof SeoSites.readState>>
>["scope"];

function hostMatches(host: string, scope: NonNullable<Scope>): boolean {
  const candidates = [host, hostTwin(host)];
  return candidates.some(
    (candidate) =>
      candidate === scope.root || inScope(`https://${candidate}/`, scope),
  );
}

function sum(totals: ReturnType<typeof assistantTotals>) {
  let sessions = 0;
  let keyEvents = 0;
  for (const entry of totals.values()) {
    sessions += entry.sessions;
    keyEvents += entry.keyEvents;
  }
  return { sessions, keyEvents };
}

export async function readAiTraffic(
  projectId: string,
): Promise<AiTrafficView | null> {
  // Bayrak kapalıyken okuma yok.
  if (!seoGeoTrafficEnabled()) return null;
  try {
    const link = await primaryGaLink(projectId);
    if (!link || !link.lastDailyDate) return null;
    if (STOPPED_HEALTH.has(link.health)) return null;

    const state = await SeoSites.readState(projectId);
    const scope = state?.scope ?? null;
    if (!scope) return null;
    const host = streamHost(link.streamUri);
    if (host !== null && !hostMatches(host, scope)) return null;

    const to = link.lastDailyDate;
    const from = addDays(to, -(WINDOW_DAYS - 1));
    const previousTo = addDays(from, -1);
    const previousFrom = addDays(previousTo, -(WINDOW_DAYS - 1));
    const options = {
      exclude: new Set<string>(),
      reports: ["sourceMedium"] as const,
    };
    const [current, previous] = await Promise.all([
      loadGaWindowTables(link.id, { from, to }, options),
      loadGaWindowTables(
        link.id,
        { from: previousFrom, to: previousTo },
        options,
      ),
    ]);
    const currentByName = assistantTotals(current);
    const previousByName = assistantTotals(previous);
    const now = sum(currentByName);
    const before = sum(previousByName);

    const names = new Set([...currentByName.keys(), ...previousByName.keys()]);
    const assistants = [...names]
      .map((name) => ({
        name,
        sessions: currentByName.get(name)?.sessions ?? 0,
        previousSessions: previousByName.get(name)?.sessions ?? 0,
      }))
      .sort(
        (a, b) =>
          b.sessions - a.sessions ||
          b.previousSessions - a.previousSessions ||
          (a.name < b.name ? -1 : 1),
      )
      .slice(0, ASSISTANTS_MAX);

    const total = current.totals.sessions;
    return {
      from,
      to,
      sessions: now.sessions,
      previousSessions: before.sessions,
      keyEvents: now.keyEvents,
      sharePct:
        total > 0 ? Math.round((1000 * now.sessions) / total) / 10 : null,
      assistants,
      domainMatch: host === null ? "unknown" : "match",
    };
  } catch (error) {
    console.error(
      "[seo-geo] ai traffic could not be read:",
      error instanceof Error ? error.name : "unknown",
    );
    return null;
  }
}
