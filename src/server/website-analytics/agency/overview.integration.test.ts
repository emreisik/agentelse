import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { prisma } from "@/lib/prisma";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { describeIntegration } from "@/test-support/integration-suite";

import { loadWebsitesOverview } from "./overview";

// KABUL TESTİ (GA-F8, /websites, mock kip, ağ yok): 20 projenin her birinde
// senkronlanmış bir ana mülk, bir projede iki ekstra mülk -> tek çağrıda 22
// satır; 7 günlük toplamlar, bulgu ve uyarı sayıları doğru; başka workspace'in
// ve mock olmayan bağlar görünmez; eski veri rakamsız; etkin WEBSITE müşteri
// bağlantısı yalnız ana satırda.

const NOW = new Date("2026-10-07T12:00:00.000Z");

function dayKey(offset: number): string {
  return new Date(NOW.getTime() - offset * 86_400_000).toISOString().slice(0, 10);
}

describeIntegration("Websites overview (mock Google)", () => {
  const runId = randomUUID().slice(0, 8);
  const saved = {
    agency: process.env.GA_AGENCY,
    sync: process.env.GA_SYNC,
    mode: process.env.AGENTELSE_PROVIDER_MODE,
  };
  let fixture: AgencyFixture;
  let other: AgencyFixture;
  const projectIds: string[] = [];
  const mainLinkIds: string[] = [];
  const extraLinkIds: string[] = [];
  let staleLinkId = "";
  let credentialId = "";

  async function createLink(input: {
    projectId: string;
    propertyId: string;
    isPrimary: boolean;
    lastDailyDate: string | null;
    isMock?: boolean;
    workspaceId?: string;
  }) {
    return prisma.gaPropertyLink.create({
      data: {
        workspaceId: input.workspaceId ?? fixture.workspaceId,
        projectId: input.projectId,
        credentialId,
        propertyId: input.propertyId,
        isPrimary: input.isPrimary,
        isSecondary: !input.isPrimary,
        isMock: input.isMock ?? true,
        propertyName: `Property ${input.propertyId}`,
        currencyCode: "USD",
        serviceLevel: "GOOGLE_ANALYTICS_STANDARD",
        health: "OK",
        healthScore: 88,
        lastDailyDate: input.lastDailyDate,
      },
    });
  }

  async function addDays(linkId: string, projectId: string, through: string, sessions: number) {
    const end = new Date(`${through}T00:00:00.000Z`).getTime();
    await prisma.gaDailyTotal.createMany({
      data: Array.from({ length: 14 }, (_, i) => ({
        linkId,
        projectId,
        date: new Date(end - i * 86_400_000),
        sessions,
        keyEvents: 2,
        revenueMicros: BigInt(1_500_000),
        fetchedAt: NOW,
      })),
    });
  }

  beforeAll(async () => {
    process.env.GA_AGENCY = "true";
    process.env.GA_SYNC = "true";
    process.env.AGENTELSE_PROVIDER_MODE = "mock";
    fixture = await createAgencyFixture(`ov-${runId}`);
    other = await createAgencyFixture(`ov-other-${runId}`);

    const credential = await prisma.integrationCredential.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        brandId: fixture.brandId,
        provider: "google_analytics",
        encryptedSecret: "not-used-in-mock-mode",
        status: "ACTIVE",
        metadata: {},
      },
    });
    credentialId = credential.id;

    projectIds.push(fixture.projectId);
    for (let i = 1; i < 20; i += 1) {
      const project = await prisma.project.create({
        data: {
          workspaceId: fixture.workspaceId,
          name: `Overview ${runId} ${String(i).padStart(2, "0")}`,
          slug: `overview-${runId}-${i}`,
          brands: {
            create: {
              workspaceId: fixture.workspaceId,
              name: `Brand ${i}`,
              slug: "default",
              isDefault: true,
            },
          },
        },
      });
      projectIds.push(project.id);
    }

    for (const [index, projectId] of projectIds.entries()) {
      const stale = index === 19;
      const link = await createLink({
        projectId,
        propertyId: `1000${index}`,
        isPrimary: true,
        lastDailyDate: stale ? "2026-07-01" : dayKey(1),
      });
      mainLinkIds.push(link.id);
      if (stale) {
        staleLinkId = link.id;
        await addDays(link.id, projectId, "2026-07-01", 50);
      } else {
        await addDays(link.id, projectId, dayKey(1), 100 + index);
      }
    }
    // İlk projede iki ekstra mülk.
    for (const suffix of ["a", "b"]) {
      const extra = await createLink({
        projectId: fixture.projectId,
        propertyId: `2000${suffix}`,
        isPrimary: false,
        lastDailyDate: dayKey(1),
      });
      extraLinkIds.push(extra.id);
      await addDays(extra.id, fixture.projectId, dayKey(1), 10);
    }

    // Başka workspace'in bağı ve aynı workspace'te mock olmayan bağ görünmez.
    await createLink({
      projectId: other.projectId,
      propertyId: "30001",
      isPrimary: true,
      lastDailyDate: dayKey(1),
      workspaceId: other.workspaceId,
    });
    const realProject = await prisma.project.create({
      data: {
        workspaceId: fixture.workspaceId,
        name: `Overview real ${runId}`,
        slug: `overview-real-${runId}`,
        brands: {
          create: {
            workspaceId: fixture.workspaceId,
            name: "Real",
            slug: "default",
            isDefault: true,
          },
        },
      },
    });
    await createLink({
      projectId: realProject.id,
      propertyId: "40001",
      isPrimary: true,
      lastDailyDate: dayKey(1),
      isMock: false,
    });

    // Açık bulgu (ilk ana mülkte) ve uyarılar.
    const first = mainLinkIds[0] ?? "";
    await prisma.gaFinding.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        linkId: first,
        ruleKey: "AN1",
        ruleVersion: 1,
        kind: "ANOMALY",
        subject: "site",
        subjectKey: `subj-${runId}`,
        periodGrain: "DAY",
        periodKey: dayKey(1),
        periodStart: new Date(`${dayKey(1)}T00:00:00.000Z`),
        periodEnd: new Date(`${dayKey(1)}T00:00:00.000Z`),
        severity: "WARN",
        confidence: "SIGNIFICANT",
        status: "OPEN",
        mode: "live",
        evidence: {},
        fingerprint: `fp-${runId}`,
      },
    });
    await prisma.adsAlert.createMany({
      data: [
        {
          workspaceId: fixture.workspaceId,
          projectId: fixture.projectId,
          kind: "GA_MH24",
          severity: "CRITICAL",
          source: "GA4",
          dedupeKey: `ga4:${first}:MH24`,
          title: "Test critical",
        },
        {
          workspaceId: fixture.workspaceId,
          projectId: fixture.projectId,
          kind: "GA_MH1",
          severity: "WARN",
          source: "GA4",
          dedupeKey: `ga4:${first}:MH1`,
          title: "Test warn",
        },
      ],
    });
    // Etkin WEBSITE müşteri bağlantısı (ilk projede) ve süresi dolmuş bir tane.
    await prisma.reportShare.createMany({
      data: [
        {
          workspaceId: fixture.workspaceId,
          projectId: fixture.projectId,
          kind: "WEBSITE",
          reportId: `garep_weekly_${runId}_1`,
          tokenHash: `hash-a-${runId}`,
          branding: {},
          expiresAt: new Date(NOW.getTime() + 5 * 86_400_000),
          createdByUserId: "user-test",
        },
        {
          workspaceId: fixture.workspaceId,
          projectId: fixture.projectId,
          kind: "WEBSITE",
          reportId: `garep_weekly_${runId}_2`,
          tokenHash: `hash-b-${runId}`,
          branding: {},
          expiresAt: new Date(NOW.getTime() - 86_400_000),
          createdByUserId: "user-test",
        },
      ],
    });
  }, 180_000);

  afterAll(async () => {
    process.env.GA_AGENCY = saved.agency;
    process.env.GA_SYNC = saved.sync;
    process.env.AGENTELSE_PROVIDER_MODE = saved.mode;
    for (const workspaceId of [fixture?.workspaceId, other?.workspaceId]) {
      if (!workspaceId) continue;
      await prisma.reportShare.deleteMany({ where: { workspaceId } });
      await prisma.adsAlert.deleteMany({ where: { workspaceId } });
      await prisma.gaPropertyLink.deleteMany({ where: { workspaceId } });
      await prisma.integrationCredential.deleteMany({ where: { workspaceId } });
      await teardownAgencyFixture(workspaceId);
    }
  });

  it("returns every property of the workspace in one call", async () => {
    const { rows, truncated } = await loadWebsitesOverview(fixture.workspaceId, NOW);
    expect(truncated).toBe(false);
    // 20 ana + 2 ekstra; başka workspace ve mock olmayan bağ yok.
    expect(rows).toHaveLength(22);
    expect(rows.filter((row) => row.role === "extra")).toHaveLength(2);
    expect(rows.every((row) => row.isMock)).toBe(true);
    const ids = new Set(rows.map((row) => row.propertyId));
    expect(ids.has("30001")).toBe(false);
    expect(ids.has("40001")).toBe(false);
  });

  it("computes the 7-day totals, findings and alert counts", async () => {
    const { rows } = await loadWebsitesOverview(fixture.workspaceId, NOW);
    const first = rows.find((row) => row.linkId === mainLinkIds[0]);
    expect(first).toMatchObject({
      role: "main",
      sessions7d: 700,
      sessionsChangePct: 0,
      keyEvents7d: 14,
      revenue7d: 10.5,
      currency: "USD",
      measurementScore: 88,
      openFindings: 1,
      alertsCritical: 1,
      alertsWarn: 1,
      connection: "ok",
      bigQuery: "off",
      agentelseChanges: 0,
    });
    const extra = rows.find((row) => row.linkId === extraLinkIds[0]);
    expect(extra).toMatchObject({ role: "extra", sessions7d: 70, openFindings: 0 });
    // Bu mülklerin kimlik bilgisi gerçek: "ok"; diğerleri aynı kimlik bilgisini paylaşır.
    expect(extra?.connection).toBe("ok");
  });

  it("gives a stale link no numbers", async () => {
    const { rows } = await loadWebsitesOverview(fixture.workspaceId, NOW);
    const stale = rows.find((row) => row.linkId === staleLinkId);
    expect(stale).toMatchObject({
      sessions7d: null,
      keyEvents7d: null,
      revenue7d: null,
      sessionsChangePct: null,
    });
  });

  it("counts an active WEBSITE client link on the main row only", async () => {
    const { rows } = await loadWebsitesOverview(fixture.workspaceId, NOW);
    const ofProject = rows.filter((row) => row.projectId === fixture.projectId);
    expect(ofProject.find((row) => row.role === "main")?.activeShares).toBe(1);
    expect(ofProject.filter((row) => row.role === "extra").map((row) => row.activeShares)).toEqual([0, 0]);
    expect(
      rows.filter((row) => row.projectId !== fixture.projectId).every((row) => row.activeShares === 0),
    ).toBe(true);
  });

  it("is empty for a workspace with no links and when the flag is off", async () => {
    expect((await loadWebsitesOverview("no-such-workspace", NOW)).rows).toEqual([]);
    process.env.GA_AGENCY = "";
    expect(await loadWebsitesOverview(fixture.workspaceId, NOW)).toEqual({
      rows: [],
      truncated: false,
    });
    process.env.GA_AGENCY = "true";
  });
});
