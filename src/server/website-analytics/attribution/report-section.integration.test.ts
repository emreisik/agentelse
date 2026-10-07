import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { addDays } from "@/lib/website-analytics/days";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import {
  cleanupTrackedLinks,
  seedTrackedLink,
} from "@/server/tracked-links/test-support";
import {
  cleanupAttributionSeed,
  seedAttributionGaLink,
  seedCampaignSlices,
} from "@/server/website-analytics/attribution/test-support";
import { cleanupGaReportSeed } from "@/server/website-analytics/reports/test-support";
import { describeIntegration } from "@/test-support/integration-suite";

import { loadAgentelseReportSection } from "./report-section";

// GA-F6 haftalık rapor bölümü gerçek Postgres'e karşı (Google'a hiç gidilmez):
// tohumlanmış bir hafta "From Agentelse" tablosunu verir; GA_UTM kapalıyken
// null döner ve hiçbir sorgu atılmaz.

const WEEK = { from: "2026-09-28", to: "2026-10-04" };
const CODE = "abc123";

describeIntegration("GA-F6 weekly report section", () => {
  const runId = randomUUID().slice(0, 8);
  const saved = { utm: process.env.GA_UTM, sync: process.env.GA_SYNC };
  let fixture: AgencyFixture;

  function restore(name: string, value: string | undefined) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  beforeAll(async () => {
    process.env.GA_UTM = "true";
    process.env.GA_SYNC = "true";
    fixture = await createAgencyFixture(`ga-agx-report-${runId}`);
    const seeded = await seedAttributionGaLink({
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      brandId: fixture.brandId,
      through: WEEK.to,
      days: 28,
      currency: "EUR",
    });
    await seedTrackedLink({
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      entityType: "instagram_bio",
      entityId: "bio",
      channel: "instagram",
      code: CODE,
      utmCampaign: "agx-bio",
      label: "Instagram bio link",
    });
    const days = Array.from({ length: 7 }, (_, index) => ({
      day: addDays(WEEK.from, index),
      rows: [
        {
          campaign: "agx-bio",
          source: "instagram",
          medium: "social",
          content: `agx_${CODE}`,
          sessions: 10,
          engagedSessions: 6,
          keyEvents: 1,
          revenue: 0,
        },
      ],
    }));
    await seedCampaignSlices({
      linkId: seeded.linkId,
      projectId: fixture.projectId,
      days,
    });
  });

  afterAll(async () => {
    restore("GA_UTM", saved.utm);
    restore("GA_SYNC", saved.sync);
    await cleanupAttributionSeed(fixture.projectId);
    await cleanupTrackedLinks(fixture.projectId);
    await cleanupGaReportSeed(fixture.projectId);
    await teardownAgencyFixture(fixture.workspaceId);
  });

  it("builds the section for a seeded week", async () => {
    const section = await loadAgentelseReportSection({
      projectId: fixture.projectId,
      range: WEEK,
      gaCurrency: "EUR",
    });
    expect(section).not.toBeNull();
    expect(section?.tracked?.rows[0]?.label).toContain("Instagram bio link");
    expect(section?.tracked?.rows[0]?.values[0]).toBe(70);
    expect(section?.tracked?.rows[0]?.values[2]).toBe(7);
    expect(section?.notes.length).toBeGreaterThan(0);
  });

  it("returns null without any query when GA_UTM is off", async () => {
    const spies = [
      vi.spyOn(prisma.trackedLink, "findMany"),
      vi.spyOn(prisma.gaPropertyLink, "findFirst"),
    ];
    delete process.env.GA_UTM;
    try {
      const section = await loadAgentelseReportSection({
        projectId: fixture.projectId,
        range: WEEK,
        gaCurrency: "EUR",
      });
      expect(section).toBeNull();
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      process.env.GA_UTM = "true";
      for (const spy of spies) spy.mockRestore();
    }
  });
});
