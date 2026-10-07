import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { prisma } from "@/lib/prisma";
import type { CampaignSliceRow } from "@/lib/website-analytics/attribution/types";
import { addDays } from "@/lib/website-analytics/days";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { seedTrackedLink } from "@/server/tracked-links/test-support";
import { gaDataThrough } from "@/server/website-analytics/store";
import { describeIntegration } from "@/test-support/integration-suite";

import { GaAttributionLearnings } from "./learnings";
import {
  cleanupAttributionSeed,
  seedAttributionGaLink,
  seedCampaignSlices,
} from "./test-support";

// GA-F6 öğrenmeleri gerçek Postgres'e karşı: sitenin geri kalanının 3 katı
// dönüştüren etiketli bir Meta kampanyası tam bir GA4 öğrenmesi yazar, ikinci
// koşu yazmaz; mock bağ, kritik ölçüm sorunu ve şüpheli günlerde çarpan fark
// öğrenme üretmez. Bayrak kapalıyken runDue sorgusuz 0 döner (heartbeat
// dokunulmaz). Proje rotasyonu ve zaman kısıtı birim testinde
// (learnings.test.ts) kanıtlanır.

const THROUGH = "2026-10-05";
const HEARTBEAT_KEY = "ga.attribution.learnings";

describeIntegration("GA attribution learnings (GA-F6)", () => {
  const runId = randomUUID().slice(0, 8);
  const saved = {
    utm: process.env.GA_UTM,
    sync: process.env.GA_SYNC,
    health: process.env.GA_HEALTH,
  };
  let main: AgencyFixture;
  let mock: AgencyFixture;
  let suspect: AgencyFixture;
  let mainLinkId: string;
  let finalThrough: string;
  let days: string[];
  const campaignId = `cmp-${runId}`;

  function restore(name: string, value: string | undefined) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  function row(
    code: string,
    sessions: number,
    keyEvents: number,
  ): CampaignSliceRow {
    return {
      campaign: "agx-spring-sale",
      source: "facebook",
      medium: "paid_social",
      content: `agx_${code}`,
      sessions,
      engagedSessions: Math.round(sessions * 0.6),
      keyEvents,
      revenue: 0,
    };
  }

  // Sitede günde 100 oturum / 8 key event; grup 50 oturum + `keyEvents(day)`.
  async function seedProject(
    fixture: AgencyFixture,
    options: {
      code: string;
      isMock?: boolean;
      keyEvents: (day: string, index: number) => number;
    },
  ): Promise<string> {
    const seeded = await seedAttributionGaLink({
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      brandId: fixture.brandId,
      through: THROUGH,
      days: 60,
      sessionsPerDay: 100,
      keyEventsPerDay: 8,
      isMock: options.isMock,
    });
    await seedTrackedLink({
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      entityType: "meta_ad",
      entityId: `cmd-${runId}:0`,
      channel: "meta_ads",
      code: options.code,
      utmCampaign: "agx-spring-sale",
      label: "Spring Sale",
      campaignExternalId: campaignId,
      adExternalId: `ad-${runId}`,
    });
    await seedCampaignSlices({
      linkId: seeded.linkId,
      projectId: fixture.projectId,
      days: days.map((day, index) => ({
        day,
        rows: [row(options.code, 50, options.keyEvents(day, index))],
      })),
    });
    return seeded.linkId;
  }

  const learnings = (projectId: string) =>
    prisma.brandLearning.findMany({
      where: { projectId, sourceType: "GA4" },
      orderBy: { createdAt: "asc" },
    });

  beforeAll(async () => {
    process.env.GA_UTM = "true";
    process.env.GA_SYNC = "true";
    delete process.env.GA_HEALTH;
    main = await createAgencyFixture(`ga-learn-${runId}`);
    mock = await createAgencyFixture(`ga-learn-m-${runId}`);
    suspect = await createAgencyFixture(`ga-learn-s-${runId}`);

    // Pencere: kesinleşen son 28 gün (tohum son 7 günü kesinleşmemiş sayar).
    mainLinkId = (
      await seedAttributionGaLink({
        workspaceId: main.workspaceId,
        projectId: main.projectId,
        brandId: main.brandId,
        through: THROUGH,
        days: 60,
      })
    ).linkId;
    finalThrough = (await gaDataThrough(mainLinkId)).finalThrough!;
    days = Array.from({ length: 28 }, (_, index) =>
      addDays(finalThrough, index - 27),
    );
    await cleanupAttributionSeed(main.projectId);

    // Sitenin geri kalanı günde 50 oturum / 2 key event (oran 0,04); grup 6
    // key event (oran 0,12) ⇒ 3 kat.
    mainLinkId = await seedProject(main, {
      code: `a${runId.slice(0, 5)}`,
      keyEvents: () => 6,
    });
    await seedProject(mock, {
      code: `b${runId.slice(0, 5)}`,
      isMock: true,
      keyEvents: () => 6,
    });
    // Normal günlerde grup sitenle aynı oranda (4); son 6 gün şüpheli ve
    // grubun payı tüm key event'ler (8): hesaba katılırsa 1,5 kat görünür.
    await seedProject(suspect, {
      code: `c${runId.slice(0, 5)}`,
      keyEvents: (_day, index) => (index >= 22 ? 8 : 4),
    });
  }, 120_000);

  afterAll(async () => {
    restore("GA_UTM", saved.utm);
    restore("GA_SYNC", saved.sync);
    restore("GA_HEALTH", saved.health);
    for (const fixture of [main, mock, suspect]) {
      if (!fixture) continue;
      await prisma.brandLearning.deleteMany({
        where: { projectId: fixture.projectId },
      });
      await cleanupAttributionSeed(fixture.projectId);
      await teardownAgencyFixture(fixture.workspaceId);
    }
  });

  it("writes nothing for a project with a critical measurement problem", async () => {
    process.env.GA_HEALTH = "true";
    await prisma.gaHealthRun.create({
      data: {
        linkId: mainLinkId,
        workspaceId: main.workspaceId,
        projectId: main.projectId,
        evaluatedAt: new Date(),
      },
    });
    await prisma.gaHealthCheck.create({
      data: {
        linkId: mainLinkId,
        projectId: main.projectId,
        checkKey: "MH1",
        status: "FAIL",
        severity: "CRITICAL",
        guideId: "mh1",
        lastCheckedAt: new Date(),
        lastChangedAt: new Date(),
      },
    });
    try {
      expect(await GaAttributionLearnings.runProject(main.projectId, new Date())).toBe(0);
    } finally {
      await prisma.gaHealthCheck.deleteMany({ where: { linkId: mainLinkId } });
      await prisma.gaHealthRun.deleteMany({ where: { linkId: mainLinkId } });
      delete process.env.GA_HEALTH;
    }
    expect(await learnings(main.projectId)).toHaveLength(0);
  });

  it("writes exactly one learning for a group converting 3x the rest, and none the second time", async () => {
    const now = new Date();
    expect(await GaAttributionLearnings.runProject(main.projectId, now)).toBe(1);
    const written = await learnings(main.projectId);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      workspaceId: main.workspaceId,
      brandId: main.brandId,
      sourceType: "GA4",
      sourceRef: `ga-utm:meta:${campaignId}`,
      polarity: "WORKS",
    });
    expect(written[0]?.insight).toContain("clearly more often");
    expect(written[0]?.insight).toMatch(/^[^0-9]*$/);

    expect(await GaAttributionLearnings.runProject(main.projectId, now)).toBe(0);
    expect(await learnings(main.projectId)).toHaveLength(1);
  });

  it("writes nothing for a mock GA link", async () => {
    expect(await GaAttributionLearnings.runProject(mock.projectId, new Date())).toBe(0);
    expect(await learnings(mock.projectId)).toHaveLength(0);
  });

  it("leaves out suspect days, so a lift that exists only there is not learned", async () => {
    const suspectDays: Record<string, string[]> = {};
    for (const day of days.slice(22)) suspectDays[day] = ["MH1"];
    const suspectLinkId = (
      await prisma.gaPropertyLink.findFirstOrThrow({
        where: { projectId: suspect.projectId, isPrimary: true },
        select: { id: true },
      })
    ).id;
    await prisma.gaHealthRun.create({
      data: {
        linkId: suspectLinkId,
        workspaceId: suspect.workspaceId,
        projectId: suspect.projectId,
        suspectDays,
      },
    });
    expect(await GaAttributionLearnings.runProject(suspect.projectId, new Date())).toBe(0);

    // Aynı veri şüpheli gün işaretsiz olsa öğrenme üretirdi.
    await prisma.gaHealthRun.deleteMany({ where: { linkId: suspectLinkId } });
    expect(await GaAttributionLearnings.runProject(suspect.projectId, new Date())).toBe(1);
  });

  it("runDue does nothing and touches no heartbeat when GA_UTM is unset", async () => {
    delete process.env.GA_UTM;
    await prisma.systemHeartbeat.deleteMany({ where: { key: HEARTBEAT_KEY } });
    try {
      expect(await GaAttributionLearnings.runDue(200, new Date())).toBe(0);
    } finally {
      process.env.GA_UTM = "true";
    }
    expect(
      await prisma.systemHeartbeat.findUnique({ where: { key: HEARTBEAT_KEY } }),
    ).toBeNull();
  });

  it("runDue claims the day once and finds the due project", async () => {
    await prisma.brandLearning.deleteMany({
      where: { projectId: main.projectId },
    });
    await prisma.systemHeartbeat.deleteMany({ where: { key: HEARTBEAT_KEY } });
    const now = new Date();
    expect(await GaAttributionLearnings.runDue(1000, now)).toBeGreaterThanOrEqual(1);
    expect(await learnings(main.projectId)).toHaveLength(1);
    // Aynı gün ikinci koşu kilitten geçemez.
    expect(await GaAttributionLearnings.runDue(1000, now)).toBe(0);
  });
});
