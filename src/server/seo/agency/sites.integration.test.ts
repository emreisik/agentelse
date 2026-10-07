import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { prisma } from "@/lib/prisma";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { primaryGscLink } from "@/server/seo/store";
import { deleteGscDataForProject, ensureGscLinkForProject } from "@/server/seo/sync/links";
import { GscSync } from "@/server/seo/sync/runner";
import { describeIntegration } from "@/test-support/integration-suite";

import { GscSites } from "./sites";

// Çok siteli Search Console gerçek Postgres'e karşı (mock Google): ek site
// eklenir, reconcile idempotent çalışır ve silinen bağı yeniden kurar,
// runner ikincil bağı birincillerden sonra senkronlar, "Make primary" iki
// satırı korur ve eski birincilin motor durumunu temizler, "Delete stored
// data" ek siteyi reconcile ile geri getirir. Runner ve primaryGscLink
// satırları integrator'ın paylaşılan düzenlemelerine dayanır.

describeIntegration("GSC multi-site (mock Google)", () => {
  const runId = randomUUID().slice(0, 8);
  const saved = {
    sync: process.env.GSC_SYNC,
    agency: process.env.GSC_AGENCY,
    mode: process.env.AGENTELSE_PROVIDER_MODE,
  };
  const MAIN = "sc-domain:main.example";
  const SECOND = "sc-domain:second.example";
  const THIRD = "sc-domain:third.example";
  let fixture: AgencyFixture;
  let credentialId: string;

  async function secondaryOf(siteUrl: string) {
    return prisma.gscSiteLink.findFirst({
      where: { projectId: fixture.projectId, siteUrl },
    });
  }

  beforeAll(async () => {
    process.env.GSC_SYNC = "true";
    process.env.GSC_AGENCY = "true";
    process.env.AGENTELSE_PROVIDER_MODE = "mock";
    fixture = await createAgencyFixture(`sites-${runId}`);
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
          searchConsoleSites: [
            { siteUrl: MAIN, permissionLevel: "siteOwner" },
            { siteUrl: SECOND, permissionLevel: "siteOwner" },
            { siteUrl: THIRD, permissionLevel: "siteFullUser" },
          ],
          selectedSearchConsoleSite: MAIN,
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
    await prisma.adsAlert.deleteMany({ where });
    await prisma.gscSiteLink.deleteMany({ where });
    await prisma.gscSiteSetting.deleteMany({ where });
    await prisma.gscBqSource.deleteMany({ where });
    await prisma.seoSite.deleteMany({ where });
    await prisma.integrationCredential.deleteMany({
      where: { workspaceId: fixture?.workspaceId },
    });
    await teardownAgencyFixture(fixture?.workspaceId);
  });

  it("adds a secondary site and reconcile is idempotent", async () => {
    const added = await GscSites.add({
      projectId: fixture.projectId,
      siteUrl: SECOND,
      userId: "user-1",
    });
    expect(added.ok).toBe(true);
    const link = await secondaryOf(SECOND);
    expect(link).toMatchObject({
      isPrimary: false,
      isSecondary: true,
      demotedAt: null,
      isMock: true,
      permissionLevel: "siteOwner",
    });
    expect(await GscSites.reconcile(fixture.projectId)).toBe(0);
    expect(
      await GscSites.add({ projectId: fixture.projectId, siteUrl: SECOND, userId: "user-1" }),
    ).toEqual({ ok: false, code: "ALREADY_ADDED" });
    expect(
      await GscSites.add({ projectId: fixture.projectId, siteUrl: MAIN, userId: "user-1" }),
    ).toEqual({ ok: false, code: "IS_PRIMARY" });
  }, 30_000);

  it("reconcile recreates a secondary link that was deleted", async () => {
    await prisma.gscSiteLink.deleteMany({
      where: { projectId: fixture.projectId, siteUrl: SECOND },
    });
    expect(await GscSites.reconcileAll()).toBeGreaterThanOrEqual(1);
    expect(await secondaryOf(SECOND)).toMatchObject({ isSecondary: true, isPrimary: false });
    const list = await GscSites.list(fixture.projectId);
    expect(list.map((site) => site.role)).toEqual(["PRIMARY", "SECONDARY"]);
  }, 30_000);

  it("the runner syncs the secondary (after the primaries)", async () => {
    for (let round = 0; round < 10; round += 1) {
      await GscSync.runDue(3, new Date());
      const link = await secondaryOf(SECOND);
      if (link?.lastMetadataAt) break;
    }
    const secondary = await secondaryOf(SECOND);
    expect(secondary?.lastMetadataAt).not.toBeNull();
    const primary = await primaryGscLink(fixture.projectId);
    expect(primary?.siteUrl).toBe(MAIN);
  }, 120_000);

  it("a retention pass does not delete the secondary", async () => {
    const { GscRetention } = await import("@/server/seo/retention");
    await GscRetention.runDue(new Date());
    expect(await secondaryOf(SECOND)).not.toBeNull();
  }, 60_000);

  it("makePrimary swaps both rows and clears the old primary's engine state", async () => {
    await prisma.adsAlert.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        kind: "gsc_test",
        severity: "WARN",
        dedupeKey: `gsc-test-${runId}`,
        source: "GSC",
        title: "test",
      },
    });
    const before = await primaryGscLink(fixture.projectId);
    const result = await GscSites.makePrimary({
      projectId: fixture.projectId,
      linkId: (await secondaryOf(SECOND))!.id,
      userId: "user-1",
    });
    expect(result).toEqual({ ok: true });

    const [oldRow, newRow] = await Promise.all([secondaryOf(MAIN), secondaryOf(SECOND)]);
    expect(oldRow).toMatchObject({ id: before?.id, isPrimary: false, isSecondary: true, demotedAt: null });
    expect(newRow).toMatchObject({ isPrimary: true, isSecondary: false });
    expect((await primaryGscLink(fixture.projectId))?.siteUrl).toBe(SECOND);

    const credential = await prisma.integrationCredential.findUniqueOrThrow({
      where: { id: credentialId },
    });
    expect((credential.metadata as { selectedSearchConsoleSite?: string }).selectedSearchConsoleSite).toBe(SECOND);
    expect(
      await prisma.adsAlert.count({
        where: { projectId: fixture.projectId, source: "GSC" },
      }),
    ).toBe(0);
    const settings = await prisma.gscSiteSetting.findMany({
      where: { projectId: fixture.projectId },
    });
    expect(settings.find((s) => s.siteUrl === MAIN)?.isExtra).toBe(true);
    expect(settings.find((s) => s.siteUrl === SECOND)?.isExtra).toBe(false);
  }, 60_000);

  it("'Delete stored data' brings the secondary back through reconcile", async () => {
    await deleteGscDataForProject(fixture.projectId);
    expect(await secondaryOf(MAIN)).toBeNull();
    await GscSites.reconcile(fixture.projectId);
    expect(await secondaryOf(MAIN)).toMatchObject({ isSecondary: true, isPrimary: false });
  }, 60_000);

  it("remove deletes only secondary links", async () => {
    const secondary = (await secondaryOf(MAIN))!;
    expect(
      await GscSites.remove({ projectId: fixture.projectId, linkId: secondary.id, userId: "user-1" }),
    ).toEqual({ ok: true });
    expect(await secondaryOf(MAIN)).toBeNull();
    const primary = (await primaryGscLink(fixture.projectId))!;
    expect(
      await GscSites.remove({ projectId: fixture.projectId, linkId: primary.id, userId: "user-1" }),
    ).toMatchObject({ ok: false });
    expect(await GscSites.reconcile(fixture.projectId)).toBe(0);
  }, 30_000);

  it("the runner takes primaries first and at most two secondaries per tick (400 links)", async () => {
    const credential = await prisma.integrationCredential.findUniqueOrThrow({
      where: { id: credentialId },
    });
    await prisma.gscSiteLink.deleteMany({ where: { projectId: fixture.projectId } });
    const rows = (isPrimary: boolean, count: number) =>
      Array.from({ length: count }, (_, at) => ({
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        credentialId: credential.id,
        siteUrl: `sc-domain:${isPrimary ? "p" : "s"}${at}.example`,
        isPrimary,
        isSecondary: !isPrimary,
        isMock: true,
      }));
    await prisma.gscSiteLink.createMany({
      data: [...rows(true, 30), ...rows(false, 370)],
    });
    await GscSync.runDue(3, new Date());
    const touched = await prisma.gscSiteLink.findMany({
      where: { projectId: fixture.projectId, OR: [{ lastMetadataAt: { not: null } }, { lastSyncError: { not: null } }, { syncLeaseUntil: { not: null } }] },
      select: { isPrimary: true, isSecondary: true },
    });
    expect(touched.length).toBeGreaterThan(0);
    expect(touched.filter((link) => link.isPrimary).length).toBe(3);
    expect(touched.filter((link) => link.isSecondary).length).toBeLessThanOrEqual(2);
  }, 120_000);
});
