import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { prisma } from "@/lib/prisma";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { disconnectGoogleCredential } from "@/server/integrations/google-disconnect";
import { deleteGscDataForProject, ensureGscLinkForProject } from "@/server/seo/sync/links";
import { describeIntegration } from "@/test-support/integration-suite";

import { GscAgency } from "./jobs";

// SC-F9 verisinin unutulması gerçek Postgres'e karşı: Disconnect ayarları,
// BigQuery kaynaklarını ve paylaşımları siler; "Delete stored data"
// müşteri ayarını korur ama BigQuery mutabakat/kapsam alanlarını temizler;
// ikisi art arda hiçbir şey bırakmaz; yetim süpürme silinmiş projenin
// satırlarını kaldırır. Disconnect/Delete bağlantıları integrator'ın
// paylaşılan düzenlemelerine dayanır.

describeIntegration("GSC agency forgetting", () => {
  const runId = randomUUID().slice(0, 8);
  const saved = {
    sync: process.env.GSC_SYNC,
    agency: process.env.GSC_AGENCY,
    mode: process.env.AGENTELSE_PROVIDER_MODE,
  };
  const SITE = "sc-domain:forget.example";
  let fixture: AgencyFixture;
  let credentialId: string;

  async function seed() {
    await prisma.gscSiteSetting.deleteMany({ where: { projectId: fixture.projectId } });
    await prisma.gscBqSource.deleteMany({ where: { projectId: fixture.projectId } });
    await prisma.gscSiteSetting.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        siteUrl: SITE,
        isMock: true,
        isExtra: true,
        pageGroupRules: { v: 1, rules: [{ id: "r1", group: "/a", match: "PREFIX", pattern: "/a" }] },
        rulesVersion: 2,
        groupsAppliedVersion: 2,
        groupsAppliedWeek: "2026-09-28",
        groupsCursor: "cursor",
      },
    });
    await prisma.gscBqSource.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        siteUrl: SITE,
        isMock: true,
        status: "ACTIVE",
        bqProjectId: "customer-project",
        dataset: "searchconsole",
        exportStart: "2026-01-01",
        exportedThrough: "2026-09-30",
        reconcile: { checkedAt: "2026-10-01", days: 7, clicksDiffPct: 0.1, impressionsDiffPct: 0.2 },
        lastVerifiedAt: new Date(),
        consecutiveFailures: 2,
      },
    });
  }

  beforeAll(async () => {
    process.env.GSC_SYNC = "true";
    process.env.GSC_AGENCY = "true";
    process.env.AGENTELSE_PROVIDER_MODE = "mock";
    fixture = await createAgencyFixture(`forget-${runId}`);
    const credential = await prisma.integrationCredential.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        brandId: fixture.brandId,
        provider: "google_search_console",
        accountLabel: "owner@example.com",
        encryptedSecret: "not-used-in-mock-mode",
        status: "ACTIVE",
        metadata: {
          searchConsoleSites: [{ siteUrl: SITE, permissionLevel: "siteOwner" }],
          selectedSearchConsoleSite: SITE,
        },
      },
    });
    credentialId = credential.id;
    await ensureGscLinkForProject(fixture.projectId);
  }, 60_000);

  afterAll(async () => {
    process.env.GSC_SYNC = saved.sync;
    process.env.GSC_AGENCY = saved.agency;
    process.env.AGENTELSE_PROVIDER_MODE = saved.mode;
    const where = { projectId: fixture?.projectId };
    await prisma.reportShare.deleteMany({ where });
    await prisma.gscSiteSetting.deleteMany({ where });
    await prisma.gscBqSource.deleteMany({ where });
    await prisma.gscSiteLink.deleteMany({ where });
    await prisma.integrationCredential.deleteMany({
      where: { workspaceId: fixture?.workspaceId },
    });
    await teardownAgencyFixture(fixture?.workspaceId);
  });

  async function counts() {
    const where = { projectId: fixture.projectId };
    return {
      settings: await prisma.gscSiteSetting.count({ where }),
      sources: await prisma.gscBqSource.count({ where }),
      shares: await prisma.reportShare.count({ where }),
    };
  }

  it("Disconnect removes settings, BigQuery sources and shares", async () => {
    await seed();
    await prisma.reportShare.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        kind: "SEARCH",
        reportId: "report-1",
        tokenHash: `hash-${runId}-1`,
        branding: {},
        expiresAt: new Date(Date.now() + 86_400_000),
        createdByUserId: "user-1",
      },
    });
    const credential = await prisma.integrationCredential.findUniqueOrThrow({
      where: { id: credentialId },
    });
    await disconnectGoogleCredential({ ...credential, metadata: {} });
    expect(await counts()).toEqual({ settings: 0, sources: 0, shares: 0 });
  }, 60_000);

  it("'Delete stored data' keeps the customer config but clears Google-derived BigQuery fields", async () => {
    await prisma.integrationCredential.update({
      where: { id: credentialId },
      data: {
        status: "ACTIVE",
        encryptedSecret: "not-used-in-mock-mode",
        metadata: {
          searchConsoleSites: [{ siteUrl: SITE, permissionLevel: "siteOwner" }],
          selectedSearchConsoleSite: SITE,
        },
      },
    });
    await ensureGscLinkForProject(fixture.projectId);
    await seed();
    await deleteGscDataForProject(fixture.projectId);

    const setting = await prisma.gscSiteSetting.findFirstOrThrow({ where: { projectId: fixture.projectId } });
    expect(setting).toMatchObject({
      isExtra: true,
      rulesVersion: 2,
      groupsAppliedVersion: 0,
      groupsAppliedWeek: null,
      groupsCursor: null,
    });
    const source = await prisma.gscBqSource.findFirstOrThrow({ where: { projectId: fixture.projectId } });
    expect(source).toMatchObject({
      status: "DRAFT",
      bqProjectId: "customer-project",
      dataset: "searchconsole",
      exportStart: null,
      exportedThrough: null,
      lastVerifiedAt: null,
      consecutiveFailures: 0,
    });
    expect(source.reconcile).toBeNull();
  }, 60_000);

  it("'Delete stored data' followed by Disconnect leaves nothing, although no links remain", async () => {
    await prisma.gscSiteLink.deleteMany({ where: { projectId: fixture.projectId } });
    const credential = await prisma.integrationCredential.findUniqueOrThrow({
      where: { id: credentialId },
    });
    await disconnectGoogleCredential({ ...credential, metadata: {} });
    expect(await counts()).toEqual({ settings: 0, sources: 0, shares: 0 });
  }, 60_000);

  it("the orphan sweep removes rows of a deleted project", async () => {
    const ghost = `ghost-${runId}`;
    await prisma.gscSiteSetting.create({
      data: { workspaceId: fixture.workspaceId, projectId: ghost, siteUrl: "sc-domain:ghost.example", isMock: true },
    });
    await prisma.gscBqSource.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: ghost,
        siteUrl: "sc-domain:ghost.example",
        isMock: true,
        bqProjectId: "ghost-project",
        dataset: "searchconsole",
      },
    });
    // 24 saatlik kilidi sıfırla ki süpürme bu turda koşsun.
    await prisma.systemHeartbeat.deleteMany({ where: { key: "gsc.agency-retention" } });
    await GscAgency.runDue(new Date());
    const where = { projectId: ghost };
    expect(await prisma.gscSiteSetting.count({ where })).toBe(0);
    expect(await prisma.gscBqSource.count({ where })).toBe(0);
  }, 60_000);
});
