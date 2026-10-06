import { randomUUID } from "node:crypto";

import { afterEach, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { dayKeyInTimezone } from "@/lib/timezone";
import {
  addonBackfillDone,
  readAddonState,
} from "@/lib/website-analytics/addon-backfill";
import { parseGaApiCounters } from "@/lib/website-analytics/api-counters";
import { serializeGaCatalogState } from "@/lib/website-analytics/catalog-state";
import {
  addDays,
  dateToDayKey,
  dayKeyToDate,
  monthStart,
} from "@/lib/website-analytics/days";
import type { GaSliceRow } from "@/lib/website-analytics/slices";
import { GA_WEEKLY_REPORTS } from "@/lib/website-analytics/weekly";
import {
  isoWeekMonday,
  latestCompleteWeek,
  mondaysBetween,
} from "@/lib/website-analytics/weeks";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { disconnectGoogleCredential } from "@/server/integrations/google-disconnect";
import { describeIntegration } from "@/test-support/integration-suite";

import { deleteExpiredWeekSlices } from "../retention";
import { readMergedSlices } from "../store";
import { ensureGaLinkForProject } from "./links";
import { GaSync } from "./runner";

// GA-F2 bölüm 2 eklentileri gerçek Postgres'e karşı (mock Google): GA_WEEKLY
// kapalıyken haftalık satır yazılmaz; açıkken temel geçmiş bittikten sonra
// haftalık dilimler zemine kadar boşluksuz dolar, arama sözcükleri maskeli
// saklanır, ikinci tur kopya üretmez, birleşik okuma eksiksizdir ve 95 günden
// eski ayın özetinde açılış sayfaları vardır; WEEK saklaması Pazar'a göre
// siler; google_ads günlük ve 400 günlük geçmişiyle gelir; Disconnect hepsini
// siler; tur sonunda API sayaçları "ga.api" satırına yazılır. Her senaryo
// kendi projesini ve bağını kurar.

const TIME_ZONE = "Europe/Istanbul";
const ENV_KEYS = [
  "GA_SYNC",
  "GA_WEEKLY",
  "GA_CATALOG_CHECKS",
  "AGENTELSE_PROVIDER_MODE",
] as const;

type Setup = {
  fixture: AgencyFixture;
  credentialId: string;
  linkId: string;
};

describeIntegration("GA weekly slices and addons (mock Google)", () => {
  const runId = randomUUID().slice(0, 8);
  const saved = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  const created: Setup[] = [];

  function env(values: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
    process.env.GA_SYNC = "true";
    process.env.AGENTELSE_PROVIDER_MODE = "mock";
    process.env.GA_WEEKLY = values.GA_WEEKLY ?? "";
    process.env.GA_CATALOG_CHECKS = values.GA_CATALOG_CHECKS ?? "";
  }

  async function setup(name: string): Promise<Setup> {
    const fixture = await createAgencyFixture(`gaw-${name}-${runId}`);
    const credential = await prisma.integrationCredential.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        brandId: fixture.brandId,
        provider: "google_analytics",
        accountLabel: "owner@example.com",
        encryptedSecret: "not-used-in-mock-mode",
        status: "ACTIVE",
        metadata: {
          ga4Properties: [
            { propertyId: "515151", propertyName: "Web", accountName: "Acme" },
          ],
          selectedGa4PropertyId: "515151",
          selectedGa4PropertyName: "Web",
        },
      },
    });
    await ensureGaLinkForProject(fixture.projectId);
    const link = await prisma.gaPropertyLink.findFirstOrThrow({
      where: { projectId: fixture.projectId },
    });
    const result = { fixture, credentialId: credential.id, linkId: link.id };
    created.push(result);
    return result;
  }

  async function link(linkId: string) {
    return prisma.gaPropertyLink.findUniqueOrThrow({ where: { id: linkId } });
  }

  // Diğer senaryoların bağları runDue adaylarına karışmasın.
  afterEach(async () => {
    for (const setupRow of created.splice(0)) {
      await prisma.gaPropertyLink.deleteMany({
        where: { projectId: setupRow.fixture.projectId },
      });
      await prisma.integrationCredential.deleteMany({
        where: { workspaceId: setupRow.fixture.workspaceId },
      });
      await teardownAgencyFixture(setupRow.fixture.workspaceId);
    }
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("writes no WEEK rows with GA_WEEKLY off", async () => {
    env({});
    const { linkId } = await setup("off");
    await GaSync.runDue(3, new Date());
    expect(
      await prisma.gaReportSlice.count({ where: { linkId, grain: "WEEK" } }),
    ).toBe(0);
    expect((await link(linkId)).lastDailyAt).not.toBeNull();
  }, 120_000);

  it("fills weekly history to the floor after the base history", async () => {
    env({ GA_WEEKLY: "true" });
    const { linkId } = await setup("weekly");
    const weekKeys = GA_WEEKLY_REPORTS.map((spec) => `week:${spec.key}`);
    let done = false;
    for (let round = 0; round < 60 && !done; round += 1) {
      await GaSync.runDue(3, new Date());
      const current = await link(linkId);
      const state = readAddonState(current.backfill);
      done =
        current.backfillDoneAt !== null &&
        weekKeys.every((key) => addonBackfillDone(state, key));
    }
    expect(done).toBe(true);

    const current = await link(linkId);
    expect(current.health).toBe("OK");
    // Temel geri doldurma durumu eklentilerle birlikte korunur.
    expect(current.backfill).toMatchObject({
      v: 1,
      doneAt: expect.any(String),
    });
    const state = readAddonState(current.backfill);
    const today = dayKeyInTimezone(new Date(), TIME_ZONE);
    const floor = state.floor["week:landing_page"]!;
    const landing = await prisma.gaReportSlice.findMany({
      where: { linkId, reportKey: "landing_page", grain: "WEEK" },
      select: { periodStart: true, isFinal: true },
    });
    expect(landing).toHaveLength(
      mondaysBetween(floor, latestCompleteWeek(today, 8)).length,
    );
    for (const row of landing) {
      const monday = dateToDayKey(row.periodStart);
      expect(isoWeekMonday(monday)).toBe(monday);
      expect(row.isFinal).toBe(true);
    }

    const searches = await prisma.gaReportSlice.findMany({
      where: { linkId, reportKey: "site_search", grain: "WEEK" },
      select: { rows: true },
    });
    expect(searches.length).toBeGreaterThan(0);
    const words = searches.flatMap((row) => row.rows as GaSliceRow[]);
    expect(words.length).toBeGreaterThan(0);
    expect(JSON.stringify(words)).not.toContain("@");
    expect(JSON.stringify(words)).toContain("[email]");

    // İkinci tur kopya üretmez.
    const before = await prisma.gaReportSlice.count({
      where: { linkId, grain: "WEEK" },
    });
    await GaSync.runDue(3, new Date());
    expect(
      await prisma.gaReportSlice.count({ where: { linkId, grain: "WEEK" } }),
    ).toBe(before);

    const from = isoWeekMonday(addDays(today, -200));
    const merged = await readMergedSlices(
      linkId,
      "landing_page",
      from,
      addDays(today, -1),
    );
    expect(merged.plan.missingDays).toBe(0);
    expect(merged.plan.weeks.length).toBeGreaterThan(0);
    const chosenWeeks = new Set(merged.plan.weeks);
    for (const day of merged.plan.days) {
      expect(chosenWeeks.has(isoWeekMonday(day))).toBe(false);
    }

    const month = await prisma.gaMonthlySummary.findUnique({
      where: {
        linkId_month: {
          linkId,
          month: dayKeyToDate(monthStart(addDays(today, -150))),
        },
      },
    });
    expect(month).not.toBeNull();
    expect(Array.isArray(month?.topPages)).toBe(true);
    expect((month?.topPages as unknown[]).length).toBeGreaterThan(0);
  }, 600_000);

  it("deletes WEEK slices once their Sunday leaves retention", async () => {
    env({});
    const { fixture, linkId } = await setup("retention");
    const today = new Date().toISOString().slice(0, 10);
    const old = isoWeekMonday(addDays(today, -420));
    const kept = isoWeekMonday(addDays(today, -300));
    for (const monday of [old, kept]) {
      await prisma.gaReportSlice.create({
        data: {
          linkId,
          projectId: fixture.projectId,
          reportKey: "landing_page",
          grain: "WEEK",
          periodStart: dayKeyToDate(monday),
          specVersion: 1,
          dimensionHeaders: ["landingPage"],
          metricHeaders: ["sessions"],
          rows: [["/", 1]],
          isFinal: true,
          fetchedAt: new Date(),
        },
      });
    }
    expect(await deleteExpiredWeekSlices()).toBeGreaterThanOrEqual(1);
    const left = await prisma.gaReportSlice.findMany({
      where: { linkId, grain: "WEEK" },
      select: { periodStart: true },
    });
    expect(left.map((row) => dateToDayKey(row.periodStart))).toEqual([kept]);
  }, 60_000);

  it("syncs google_ads daily and backfills 400 days", async () => {
    env({ GA_CATALOG_CHECKS: "true" });
    const { linkId } = await setup("ads");
    // Denetim taze: bu senaryo yalnız isteğe bağlı raporun akışını sınar.
    const catalog = serializeGaCatalogState({
      v: 2,
      disabled: {},
      check: {
        at: new Date().toISOString(),
        missing: {},
        deprecated: [],
        blocked: [],
      },
      optional: {
        google_ads: {
          enabled: true,
          at: new Date().toISOString(),
          reason: null,
        },
      },
    });
    await prisma.gaPropertyLink.update({
      where: { id: linkId },
      data: {
        catalog: catalog as Prisma.InputJsonValue,
        linkedProducts: { googleAds: 1 },
      },
    });
    let done = false;
    for (let round = 0; round < 40 && !done; round += 1) {
      await GaSync.runDue(3, new Date());
      done = addonBackfillDone(
        readAddonState((await link(linkId)).backfill),
        "day:google_ads",
      );
    }
    expect(done).toBe(true);

    const today = dayKeyInTimezone(new Date(), TIME_ZONE);
    const slices = await prisma.gaReportSlice.findMany({
      where: { linkId, reportKey: "google_ads", grain: "DAY" },
      select: { periodStart: true, rows: true, dimensionHeaders: true },
    });
    const days = slices.map((slice) => dateToDayKey(slice.periodStart));
    expect(days.some((day) => day >= addDays(today, -3))).toBe(true);
    expect(days.some((day) => day < addDays(today, -100))).toBe(true);
    expect(slices[0]?.dimensionHeaders).toEqual([
      "sessionGoogleAdsCampaignName",
    ]);
    for (const slice of slices) {
      for (const row of slice.rows as GaSliceRow[]) {
        expect(row[0]).not.toBe("(not set)");
      }
    }
  }, 600_000);

  it("deletes WEEK and google_ads rows on Disconnect", async () => {
    env({});
    const { fixture, credentialId, linkId } = await setup("disconnect");
    const monday = isoWeekMonday(new Date().toISOString().slice(0, 10));
    for (const [reportKey, grain] of [
      ["landing_page", "WEEK"],
      ["search_console", "WEEK"],
      ["google_ads", "DAY"],
    ] as const) {
      await prisma.gaReportSlice.create({
        data: {
          linkId,
          projectId: fixture.projectId,
          reportKey,
          grain,
          periodStart: dayKeyToDate(monday),
          specVersion: 1,
          dimensionHeaders: [],
          metricHeaders: [],
          rows: [],
          isFinal: true,
          fetchedAt: new Date(),
        },
      });
    }
    const credential = await prisma.integrationCredential.findUniqueOrThrow({
      where: { id: credentialId },
    });
    await disconnectGoogleCredential({ ...credential, metadata: {} });
    expect(
      await prisma.gaReportSlice.count({
        where: { projectId: fixture.projectId },
      }),
    ).toBe(0);
  }, 60_000);

  it("writes the API counters at the end of a sync round", async () => {
    env({});
    await setup("counters");
    await GaSync.runDue(3, new Date());
    const row = await prisma.systemHeartbeat.findUnique({
      where: { key: "ga.api" },
    });
    const data = parseGaApiCounters(row?.data ?? null);
    const calls = Object.values(data?.hours ?? {}).reduce(
      (sum, counts) => sum + (counts.ok ?? 0),
      0,
    );
    expect(calls).toBeGreaterThan(0);
  }, 120_000);
});
