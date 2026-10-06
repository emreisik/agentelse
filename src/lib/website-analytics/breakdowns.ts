import {
  MAX_CHANNELS,
  MAX_KEY_EVENTS,
  MAX_LANDING_PAGES,
  type ReportChannel,
  type ReportKeyEvent,
  type ReportLandingPage,
} from "@/lib/module-flows/analytics/report";

import { aggregateSlices, type GaStoredSlice } from "./slices";

// Analytics modülünün Google Analytics listeleri (GA_MODULE_SECTIONS):
// kanallar, açılış sayfaları ve key event'ler ambarın DAY dilimlerinden
// toplanır. Etiketler ambarda zaten maskeli; cleanWorksText uygulanmaz
// (Search Console'un topSearches yolu gibi), yalnız boşluk toplanıp
// kırpılır. Saf.

const CHANNEL_MAX = 80;
const PAGE_MAX = 200;
const EVENT_MAX = 80;

export type GaModuleListsInput = {
  // null: rapor kapalı ya da pencereyi eksiksiz kapsamıyor; liste atlanır.
  channel: GaStoredSlice[] | null;
  landing: GaStoredSlice[] | null;
  events: GaStoredSlice[] | null;
  // Pencerenin toplam oturumu (günlük toplamlardan); pay bunun yüzdesi.
  totalSessions: number;
};

export type GaModuleListsResult = {
  channels?: ReportChannel[];
  landingPages?: ReportLandingPage[];
  keyEvents?: ReportKeyEvent[];
};

function label(raw: string | undefined, max: number): string {
  return (raw ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function percentOf(part: number, whole: number): number | null {
  return whole > 0 ? (part / whole) * 100 : null;
}

function channelsOf(
  slices: GaStoredSlice[],
  totalSessions: number,
): ReportChannel[] {
  const rows = aggregateSlices(
    slices,
    ["sessionDefaultChannelGroup"],
    ["sessions", "engagedSessions", "keyEvents"],
  );
  const out: ReportChannel[] = [];
  for (const row of rows) {
    const channel = label(row.key[0], CHANNEL_MAX);
    if (!channel) continue;
    const [sessions = 0, engaged = 0, keyEvents = 0] = row.values;
    const share = percentOf(Math.round(sessions), totalSessions);
    out.push({
      channel,
      sessions: Math.round(sessions),
      share: share === null ? null : round1(share),
      engagementRate: percentOf(engaged, sessions),
      keyEvents: Math.round(keyEvents),
    });
    if (out.length >= MAX_CHANNELS) break;
  }
  return out;
}

function landingPagesOf(slices: GaStoredSlice[]): ReportLandingPage[] {
  const rows = aggregateSlices(
    slices,
    ["landingPage"],
    ["sessions", "engagedSessions", "keyEvents"],
  );
  const out: ReportLandingPage[] = [];
  for (const row of rows) {
    const page = label(row.key[0], PAGE_MAX);
    // "(not set)": GA'nın açılış sayfası bilinmeyen oturumları; sayfa değil.
    if (!page || page === "(not set)") continue;
    const [sessions = 0, engaged = 0, keyEvents = 0] = row.values;
    out.push({
      page,
      sessions: Math.round(sessions),
      engagementRate: percentOf(engaged, sessions),
      keyEvents: Math.round(keyEvents),
    });
    if (out.length >= MAX_LANDING_PAGES) break;
  }
  return out;
}

function keyEventsOf(slices: GaStoredSlice[]): ReportKeyEvent[] {
  const rows = aggregateSlices(
    slices,
    ["eventName", "isKeyEvent"],
    ["keyEvents"],
  );
  const out: ReportKeyEvent[] = [];
  for (const row of rows) {
    if (row.key[1] !== "true") continue;
    const name = label(row.key[0], EVENT_MAX);
    const count = Math.round(row.values[0] ?? 0);
    if (!name || count <= 0) continue;
    out.push({ name, count });
    if (out.length >= MAX_KEY_EVENTS) break;
  }
  return out;
}

// Her liste yalnız dilimi verildiyse ve boş değilse döner; böylece modül
// raporu listeler yokken bugünkü biçimini birebir korur.
export function buildGaModuleLists(
  input: GaModuleListsInput,
): GaModuleListsResult {
  const channels = input.channel
    ? channelsOf(input.channel, input.totalSessions)
    : [];
  const landingPages = input.landing ? landingPagesOf(input.landing) : [];
  const keyEvents = input.events ? keyEventsOf(input.events) : [];
  return {
    ...(channels.length > 0 ? { channels } : {}),
    ...(landingPages.length > 0 ? { landingPages } : {}),
    ...(keyEvents.length > 0 ? { keyEvents } : {}),
  };
}
