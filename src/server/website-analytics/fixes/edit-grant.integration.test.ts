import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { buildGaEditGrant } from "@/lib/website-analytics/fixes/edit-grant";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { describeIntegration } from "@/test-support/integration-suite";

import {
  clearGaEditGrant,
  loadGaEditAccess,
  markGaEditGranted,
} from "./edit-grant";

// GA-F7 düzenleme izni kaydı gerçek Postgres'e karşı: işaretleme/temizleme
// diğer metadata anahtarlarını (googleHealth) ezmez; yazma izni kaydı yalnız
// ACTIVE ve token'ı olan satırda okunur; mock modda izin verilmiş sayılır;
// yeniden izin verilince değişiklik geçmişi imleci sıfırlanır.

describeIntegration("GA edit grant storage", () => {
  const runId = randomUUID().slice(0, 8);
  let fixture: AgencyFixture;
  let credentialId: string;

  beforeAll(async () => {
    fixture = await createAgencyFixture(`ga-edit-${runId}`);
    const credential = await prisma.integrationCredential.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        brandId: fixture.brandId,
        provider: "google_analytics",
        accountLabel: "owner@example.com",
        encryptedSecret: "not-used",
        status: "ACTIVE",
        metadata: {
          selectedGa4PropertyId: "424242",
          connectedEmail: "owner@example.com",
          googleHealth: { state: "OK", checkedAt: "2026-10-06T00:00:00.000Z" },
        },
      },
    });
    credentialId = credential.id;
  }, 60_000);

  afterAll(async () => {
    await prisma.gaPropertyLink.deleteMany({
      where: { projectId: fixture?.projectId },
    });
    await prisma.integrationCredential.deleteMany({
      where: { workspaceId: fixture?.workspaceId },
    });
    await teardownAgencyFixture(fixture?.workspaceId);
  });

  async function metadata(): Promise<Record<string, unknown>> {
    const row = await prisma.integrationCredential.findUniqueOrThrow({
      where: { id: credentialId },
      select: { metadata: true },
    });
    return row.metadata as Record<string, unknown>;
  }

  it("is not granted until the upgrade writes it", async () => {
    const access = await loadGaEditAccess(fixture.projectId, { mock: false });
    expect(access).toMatchObject({
      credentialId,
      workspaceId: fixture.workspaceId,
      granted: false,
      grantedAt: null,
      grantedByUserId: null,
      connectedEmail: "owner@example.com",
      mock: false,
    });
  });

  it("marks and clears the grant without clobbering other metadata keys", async () => {
    const grant = buildGaEditGrant("user-1", new Date("2026-10-07T10:00:00Z"));
    await markGaEditGranted(credentialId, grant);

    let stored = await metadata();
    expect(stored.gaEdit).toEqual(grant);
    expect(stored.googleHealth).toMatchObject({ state: "OK" });
    expect(stored.selectedGa4PropertyId).toBe("424242");

    const access = await loadGaEditAccess(fixture.projectId, { mock: false });
    expect(access).toMatchObject({
      granted: true,
      grantedAt: "2026-10-07T10:00:00.000Z",
      grantedByUserId: "user-1",
    });

    await clearGaEditGrant(credentialId);
    stored = await metadata();
    expect(stored).not.toHaveProperty("gaEdit");
    expect(stored.googleHealth).toMatchObject({ state: "OK" });
    expect(
      (await loadGaEditAccess(fixture.projectId, { mock: false }))?.granted,
    ).toBe(false);
  });

  it("resets the change-history cursor of the credential's links when granted again", async () => {
    const link = await prisma.gaPropertyLink.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        credentialId,
        propertyId: "424242",
        isMock: true,
      },
    });
    await prisma.gaChangeWatch.create({
      data: {
        linkId: link.id,
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        cursorAt: new Date("2026-10-06T00:00:00Z"),
      },
    });

    await markGaEditGranted(credentialId, buildGaEditGrant("user-1"));
    const watch = await prisma.gaChangeWatch.findUniqueOrThrow({
      where: { linkId: link.id },
    });
    expect(watch.cursorAt).toBeNull();
  });

  it("treats mock mode as granted", async () => {
    await clearGaEditGrant(credentialId);
    const access = await loadGaEditAccess(fixture.projectId, { mock: true });
    expect(access).toMatchObject({ granted: true, mock: true });
  });

  it("returns null for a revoked row or an empty token", async () => {
    await prisma.integrationCredential.update({
      where: { id: credentialId },
      data: { status: "REVOKED" },
    });
    expect(
      await loadGaEditAccess(fixture.projectId, { mock: false }),
    ).toBeNull();

    await prisma.integrationCredential.update({
      where: { id: credentialId },
      data: { status: "ACTIVE", encryptedSecret: "" },
    });
    expect(
      await loadGaEditAccess(fixture.projectId, { mock: false }),
    ).toBeNull();
    expect(await loadGaEditAccess(fixture.projectId, { mock: true })).toBeNull();
  });

  it("returns null when the project has no Analytics connection", async () => {
    expect(await loadGaEditAccess("no-such-project")).toBeNull();
  });
});
