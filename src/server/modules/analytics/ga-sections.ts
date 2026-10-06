import "server-only";

import type {
  ReportChannel,
  ReportKeyEvent,
  ReportLandingPage,
} from "@/lib/module-flows/analytics/report";
import { buildGaModuleLists } from "@/lib/website-analytics/breakdowns";
import { gaDisabledReports } from "@/lib/website-analytics/catalog-state";
import { GaFlags } from "@/lib/website-analytics/flags";
import type { GaStoredSlice } from "@/lib/website-analytics/slices";
import type { GaWindow } from "@/server/website-analytics/readers";
import { primaryGaLink, readSlices } from "@/server/website-analytics/store";

// Analytics modülünün GA bölümüne kanal, açılış sayfası ve key event
// listeleri (GA_MODULE_SECTIONS; docs/website-analytics.md "Analytics
// modülü"). Yalnız ambar penceresi yolundan çağrılır (collectGa4): canlı
// yedek yolun dilimi yoktur, listeleri hiç doldurmaz. Her liste yalnız
// raporu kapalı değilse ve DAY dilimleri pencerenin her gününü kapsıyorsa
// gelir; eksik kapsama yanlış pay göstermesin. Hiç hata fırlatmaz.

export type GaModuleLists = {
  channels?: ReportChannel[];
  landingPages?: ReportLandingPage[];
  keyEvents?: ReportKeyEvent[];
};

const REPORTS = {
  channel: "channel",
  landing: "landing_page",
  events: "events",
} as const;

export async function readGaModuleSections(input: {
  projectId: string;
  propertyId: string;
  window: GaWindow;
}): Promise<GaModuleLists> {
  // Bayrak kapalıyken hiçbir sorgu yapılmaz.
  if (!(GaFlags.sync() && GaFlags.moduleSections())) return {};
  try {
    const link = await primaryGaLink(input.projectId);
    if (!link || link.propertyId !== input.propertyId) return {};
    const disabled = gaDisabledReports(link.catalog);
    const { window } = input;
    const [channel, landing, events] = await Promise.all([
      readSlices(link.id, REPORTS.channel, window.from, window.to),
      readSlices(link.id, REPORTS.landing, window.from, window.to),
      readSlices(link.id, REPORTS.events, window.from, window.to),
    ]);
    // Kapalı rapor ya da eksik gün: o liste atlanır, diğerleri kalır.
    const usable = (key: string, slices: GaStoredSlice[]) =>
      !disabled.has(key) && slices.length === window.days ? slices : null;
    return buildGaModuleLists({
      channel: usable(REPORTS.channel, channel),
      landing: usable(REPORTS.landing, landing),
      events: usable(REPORTS.events, events),
      totalSessions: window.totals.sessions,
    });
  } catch (error) {
    console.error(
      "[analytics] ga sections read failed:",
      error instanceof Error ? error.message : error,
    );
    return {};
  }
}
