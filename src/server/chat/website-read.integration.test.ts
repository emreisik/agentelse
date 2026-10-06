import { randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { prisma } from "@/lib/prisma";
import {
  allowedNumbersOf,
  keepSupportedSentences,
} from "@/lib/module-flows/analytics/number-check";
import { addDays, dayKeyToDate } from "@/lib/website-analytics/days";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { describeIntegration } from "@/test-support/integration-suite";

import { explainWebsiteChangeForChat } from "./website-read";

// Kabul: "Why did leads drop last week?" ambarın sayılarıyla ve sayı
// denetiminden geçerek yanıtlanır. Gerçek Postgres'e iki haftalık GaDailyTotal
// ile kanal ve açılış sayfası dilimleri yazılır (geçen hafta key event düşer);
// explain_website_change'in okuyucusu: dönem toplamları veritabanı
// toplamlarına eşit, bileşenler + other + residual toplam farka eşit, ve
// yanıttaki her cümle sonucun kendi sayılarıyla sayı denetiminden geçer.

const NOW = new Date("2026-10-07T08:00:00.000Z");
const PREVIOUS_MONDAY = "2026-09-21";
const CURRENT_MONDAY = "2026-09-28";

const CHANNEL_METRICS = [
  "sessions",
  "engagedSessions",
  "activeUsers",
  "newUsers",
  "keyEvents",
  "totalRevenue",
];
const LANDING_METRICS = [
  "sessions",
  "engagedSessions",
  "keyEvents",
  "totalRevenue",
  "userEngagementDuration",
];

type DayShape = {
  channels: [string, number, number][]; // [kanal, oturum, key event]
  pages: [string, number, number][]; // [sayfa, oturum, key event]
};

// Önceki hafta: Organic 80/8, Direct 50/5, Paid 20/2; geçen hafta Organic
// key event'leri yarıya düşer, Paid biraz büyür.
const PREVIOUS: DayShape = {
  channels: [
    ["Organic Search", 80, 8],
    ["Direct", 50, 5],
    ["Paid Search", 20, 2],
  ],
  pages: [
    ["/pricing", 90, 10],
    ["/blog", 60, 5],
  ],
};
const CURRENT: DayShape = {
  channels: [
    ["Organic Search", 70, 4],
    ["Direct", 50, 5],
    ["Paid Search", 25, 2],
  ],
  pages: [
    ["/pricing", 85, 6],
    ["/blog", 60, 5],
  ],
};

describeIntegration("explain_website_change from the warehouse", () => {
  const runId = randomUUID().slice(0, 8);
  const saved = {
    sync: process.env.GA_SYNC,
    insights: process.env.GA_INSIGHTS,
  };
  let fixture: AgencyFixture;
  let linkId: string;

  beforeAll(async () => {
    process.env.GA_SYNC = "true";
    process.env.GA_INSIGHTS = "on";
    fixture = await createAgencyFixture(`ga-explain-${runId}`);
    const credential = await prisma.integrationCredential.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        brandId: fixture.brandId,
        provider: "google_analytics",
        accountLabel: "owner@example.com",
        encryptedSecret: "not-used",
        status: "ACTIVE",
      },
    });
    const link = await prisma.gaPropertyLink.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        credentialId: credential.id,
        propertyId: `77${runId.replace(/\D/g, "").slice(0, 6) || "1"}`,
        propertyName: "Web",
        timeZone: "Europe/Istanbul",
        currencyCode: "EUR",
        health: "OK",
        lastDailyDate: "2026-10-07",
      },
    });
    linkId = link.id;

    const fetchedAt = new Date("2026-10-06T00:00:00.000Z");
    for (const [monday, shape] of [
      [PREVIOUS_MONDAY, PREVIOUS],
      [CURRENT_MONDAY, CURRENT],
    ] as const) {
      for (let offset = 0; offset < 7; offset += 1) {
        const day = addDays(monday, offset);
        const sessions = shape.channels.reduce((sum, row) => sum + row[1], 0);
        const keyEvents = shape.channels.reduce((sum, row) => sum + row[2], 0);
        await prisma.gaDailyTotal.create({
          data: {
            linkId,
            projectId: fixture.projectId,
            date: dayKeyToDate(day),
            sessions,
            engagedSessions: Math.round(sessions / 2),
            keyEvents,
            isFinal: true,
            fetchedAt,
          },
        });
        await prisma.gaReportSlice.create({
          data: {
            linkId,
            projectId: fixture.projectId,
            reportKey: "channel",
            grain: "DAY",
            periodStart: dayKeyToDate(day),
            specVersion: 1,
            dimensionHeaders: ["sessionDefaultChannelGroup"],
            metricHeaders: CHANNEL_METRICS,
            rows: shape.channels.map(([name, s, ke]) => [
              name,
              s,
              Math.round(s / 2),
              s,
              0,
              ke,
              0,
            ]) as Prisma.InputJsonValue,
            rowCount: shape.channels.length,
            isFinal: true,
            fetchedAt,
          },
        });
        await prisma.gaReportSlice.create({
          data: {
            linkId,
            projectId: fixture.projectId,
            reportKey: "landing_page",
            grain: "DAY",
            periodStart: dayKeyToDate(day),
            specVersion: 1,
            dimensionHeaders: ["landingPage"],
            metricHeaders: LANDING_METRICS,
            rows: shape.pages.map(([path, s, ke]) => [
              path,
              s,
              Math.round(s / 2),
              ke,
              0,
              s * 30,
            ]) as Prisma.InputJsonValue,
            rowCount: shape.pages.length,
            isFinal: true,
            fetchedAt,
          },
        });
      }
    }
  }, 120_000);

  afterAll(async () => {
    if (saved.sync === undefined) delete process.env.GA_SYNC;
    else process.env.GA_SYNC = saved.sync;
    if (saved.insights === undefined) delete process.env.GA_INSIGHTS;
    else process.env.GA_INSIGHTS = saved.insights;
    await prisma.gaPropertyLink.deleteMany({
      where: { projectId: fixture?.projectId },
    });
    await prisma.integrationCredential.deleteMany({
      where: { workspaceId: fixture?.workspaceId },
    });
    await teardownAgencyFixture(fixture?.workspaceId);
  });

  it("answers 'Why did leads drop last week?' from warehouse numbers", async () => {
    const result = await explainWebsiteChangeForChat(
      fixture.projectId,
      { metric: "keyEvents", period: "last_week" },
      NOW,
    );
    expect(result.status).toBe("ok");
    expect(result.metric).toBe("keyEvents");

    const sumOf = async (from: string, to: string) => {
      const aggregate = await prisma.gaDailyTotal.aggregate({
        where: {
          linkId,
          date: { gte: dayKeyToDate(from), lte: dayKeyToDate(to) },
        },
        _sum: { keyEvents: true },
      });
      return aggregate._sum.keyEvents ?? 0;
    };
    const current = result.current as {
      from: string;
      to: string;
      total: number;
    };
    const previous = result.previous as {
      from: string;
      to: string;
      total: number;
    };
    expect(current).toMatchObject({ from: CURRENT_MONDAY, to: "2026-10-04" });
    expect(previous).toMatchObject({ from: PREVIOUS_MONDAY, to: "2026-09-27" });
    expect(current.total).toBe(await sumOf(current.from, current.to));
    expect(previous.total).toBe(await sumOf(previous.from, previous.to));
    expect(result.change).toBe(current.total - previous.total);

    const channels = result.channels as { label: string; total: number }[];
    expect(channels[0]?.label).toBe("Organic Search");
    const other = (result.other as { total: number } | null)?.total ?? 0;
    const sum =
      channels.reduce((total, row) => total + row.total, 0) +
      other +
      Number(result.residual);
    expect(Math.abs(sum - Number(result.change))).toBeLessThan(0.1);

    const answer = String(result.answer);
    expect(answer).toContain("Key events");
    expect(keepSupportedSentences(answer, allowedNumbersOf(result))).toBe(
      answer,
    );
    // Daha sıkı: yanıt metni çıkarılınca da her sayı sonuçtan gelir (işaretsiz).
    const withoutAnswer = allowedNumbersOf({ ...result, answer: null }).map(
      Math.abs,
    );
    expect(keepSupportedSentences(answer, withoutAnswer)).toBe(answer);
  });
});
