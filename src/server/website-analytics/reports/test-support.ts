import "server-only";

import { prisma } from "@/lib/prisma";
import { WEBSITE_GOAL_KEYS } from "@/lib/website-analytics/analysis/types";
import { addDays, dayKeyToDate } from "@/lib/website-analytics/days";
import {
  WEBSITE_REPORT_COMMAND_PREFIX,
  websiteWorkId,
} from "@/lib/website-analytics/reports/ids";

// Yalnız *.integration.test.ts dosyaları için: GA-F5 testlerinin ambar
// tohumu. Günlük toplamlar ve DAY dilimleri (channel, landing_page, events,
// source_medium) catalog.ts başlıklarıyla aynı biçimde yazılır; toplamlar
// kanallara / sayfalara eşit bölünür.

const CHANNEL_HEADERS = {
  dimensions: ["sessionDefaultChannelGroup"],
  metrics: [
    "sessions",
    "engagedSessions",
    "activeUsers",
    "newUsers",
    "keyEvents",
    "totalRevenue",
  ],
};
const LANDING_HEADERS = {
  dimensions: ["landingPage"],
  metrics: [
    "sessions",
    "engagedSessions",
    "keyEvents",
    "totalRevenue",
    "userEngagementDuration",
  ],
};
const EVENT_HEADERS = {
  dimensions: ["eventName", "isKeyEvent"],
  metrics: ["eventCount", "keyEvents", "totalUsers"],
};
const SOURCE_MEDIUM_HEADERS = {
  dimensions: ["sessionSource", "sessionMedium"],
  metrics: ["sessions", "engagedSessions", "keyEvents", "totalRevenue"],
};

// Tam sayıyı n parçaya böler; artan ilk parçaya gider (toplam tutar).
function splitEvenly(value: number, count: number): number[] {
  const base = Math.floor(value / count);
  const parts = Array.from({ length: count }, () => base);
  parts[0] = (parts[0] ?? 0) + (value - base * count);
  return parts;
}

type DayFigures = {
  sessions: number;
  engagedSessions: number;
  newUsers: number;
  activeUsers: number;
  keyEvents: number;
  revenue: number;
};

export async function seedGaReportLink(input: {
  workspaceId: string;
  projectId: string;
  brandId: string;
  through: string;
  days: number;
  sessions: (day: string, index: number) => number;
  keyEventRate?: number;
  revenuePerKeyEvent?: number;
  timeZone?: string;
  currency?: string | null;
  channels?: readonly string[];
  landingPages?: readonly string[];
  isMock?: boolean;
}): Promise<{ linkId: string; credentialId: string }> {
  const rate = input.keyEventRate ?? 0.05;
  const revenuePerKeyEvent = input.revenuePerKeyEvent ?? 0;
  const channels = input.channels ?? ["Organic Search", "Direct"];
  const landingPages = input.landingPages ?? ["/", "/pricing"];
  const propertyId = String(
    100_000_000 + Math.floor(Math.random() * 800_000_000),
  );
  const credential = await prisma.integrationCredential.create({
    data: {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      brandId: input.brandId,
      provider: "google_analytics",
      accountLabel: "owner@example.com",
      encryptedSecret: "x",
      status: "ACTIVE",
      metadata: {
        ga4Properties: [
          { propertyId, propertyName: "Web", accountName: "Acme" },
        ],
        selectedGa4PropertyId: propertyId,
        selectedGa4PropertyName: "Web",
      },
    },
  });
  const link = await prisma.gaPropertyLink.create({
    data: {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      credentialId: credential.id,
      propertyId,
      isPrimary: true,
      isMock: input.isMock ?? false,
      propertyName: "Web",
      timeZone: input.timeZone ?? "Europe/Istanbul",
      currencyCode: input.currency === undefined ? "EUR" : input.currency,
      health: "OK",
      lastDailyDate: addDays(input.through, 1),
      lastDailyAt: new Date(),
    },
  });

  const start = addDays(input.through, -(input.days - 1));
  const fetchedAt = new Date();
  const totals: {
    linkId: string;
    projectId: string;
    date: Date;
    activeUsers: number;
    newUsers: number;
    sessions: number;
    engagedSessions: number;
    engagementSec: number;
    keyEvents: number;
    revenueMicros: bigint;
    isFinal: boolean;
    fetchedAt: Date;
  }[] = [];
  const slices: {
    linkId: string;
    projectId: string;
    reportKey: string;
    grain: string;
    periodStart: Date;
    specVersion: number;
    dimensionHeaders: string[];
    metricHeaders: string[];
    rows: (string | number)[][];
    rowCount: number;
    truncated: boolean;
    quality: Record<string, never>;
    isFinal: boolean;
    fetchedAt: Date;
  }[] = [];
  for (let index = 0; index < input.days; index += 1) {
    const day = addDays(start, index);
    const sessions = Math.max(0, Math.round(input.sessions(day, index)));
    const keyEvents = Math.round(sessions * rate);
    const figures: DayFigures = {
      sessions,
      engagedSessions: Math.round(0.6 * sessions),
      newUsers: Math.round(0.4 * sessions),
      activeUsers: Math.round(0.8 * sessions),
      keyEvents,
      revenue: Math.round(keyEvents * revenuePerKeyEvent * 100) / 100,
    };
    const isFinal = day <= addDays(input.through, -7);
    totals.push({
      linkId: link.id,
      projectId: input.projectId,
      date: dayKeyToDate(day),
      activeUsers: figures.activeUsers,
      newUsers: figures.newUsers,
      sessions,
      engagedSessions: figures.engagedSessions,
      engagementSec: 60 * sessions,
      keyEvents,
      revenueMicros: BigInt(Math.round(figures.revenue * 1e6)),
      isFinal,
      fetchedAt,
    });
    const slice = (
      reportKey: string,
      headers: { dimensions: string[]; metrics: string[] },
      rows: (string | number)[][],
    ) =>
      slices.push({
        linkId: link.id,
        projectId: input.projectId,
        reportKey,
        grain: "DAY",
        periodStart: dayKeyToDate(day),
        specVersion: 1,
        dimensionHeaders: headers.dimensions,
        metricHeaders: headers.metrics,
        rows,
        rowCount: rows.length,
        truncated: false,
        quality: {},
        isFinal,
        fetchedAt,
      });

    const count = channels.length;
    const channelSessions = splitEvenly(sessions, count);
    const channelEngaged = splitEvenly(figures.engagedSessions, count);
    const channelActive = splitEvenly(figures.activeUsers, count);
    const channelNew = splitEvenly(figures.newUsers, count);
    const channelKeyEvents = splitEvenly(keyEvents, count);
    slice(
      "channel",
      CHANNEL_HEADERS,
      channels.map((name, at) => [
        name,
        channelSessions[at] ?? 0,
        channelEngaged[at] ?? 0,
        channelActive[at] ?? 0,
        channelNew[at] ?? 0,
        channelKeyEvents[at] ?? 0,
        figures.revenue / count,
      ]),
    );

    const pageCount = landingPages.length;
    const pageSessions = splitEvenly(sessions, pageCount);
    const pageEngaged = splitEvenly(figures.engagedSessions, pageCount);
    const pageKeyEvents = splitEvenly(keyEvents, pageCount);
    slice(
      "landing_page",
      LANDING_HEADERS,
      landingPages.map((page, at) => [
        page,
        pageSessions[at] ?? 0,
        pageEngaged[at] ?? 0,
        pageKeyEvents[at] ?? 0,
        figures.revenue / pageCount,
        (60 * sessions) / pageCount,
      ]),
    );

    slice("events", EVENT_HEADERS, [
      ["generate_lead", "true", keyEvents, keyEvents, keyEvents],
      ["page_view", "false", sessions * 3, 0, sessions],
    ]);

    slice(
      "source_medium",
      SOURCE_MEDIUM_HEADERS,
      channels.map((name, at) => [
        name.toLowerCase().replaceAll(" ", "-"),
        "organic",
        channelSessions[at] ?? 0,
        channelEngaged[at] ?? 0,
        channelKeyEvents[at] ?? 0,
        figures.revenue / count,
      ]),
    );
  }
  await prisma.gaDailyTotal.createMany({ data: totals });
  await prisma.gaReportSlice.createMany({ data: slices });
  return { linkId: link.id, credentialId: credential.id };
}

// Tohumu ve testin yazdığı GA-F5 satırlarını siler (garep_ komutları, Work,
// ayarlar, hedefler, bağ cascade ile ve kimlikler).
export async function cleanupGaReportSeed(projectId: string): Promise<void> {
  const workId = websiteWorkId(projectId);
  await prisma.command.deleteMany({
    where: {
      projectId,
      OR: [
        { id: { startsWith: WEBSITE_REPORT_COMMAND_PREFIX } },
        { workId },
      ],
    },
  });
  await prisma.work.deleteMany({ where: { id: workId } });
  await prisma.gaReportSettings.deleteMany({ where: { projectId } });
  await prisma.projectGoal.deleteMany({
    where: { projectId, metricKey: { in: [...WEBSITE_GOAL_KEYS] } },
  });
  await prisma.adsAlert.deleteMany({ where: { projectId, source: "GA4" } });
  await prisma.gaPropertyLink.deleteMany({ where: { projectId } });
  await prisma.integrationCredential.deleteMany({
    where: { projectId, provider: "google_analytics" },
  });
}
