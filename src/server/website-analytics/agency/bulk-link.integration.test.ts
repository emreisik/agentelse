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

import { BULK_LINK_MAX, bulkLinkGoogleAccount } from "./bulk-link";

// KABUL TESTİ (GA-F8, toplu bağlama, mock kip, ağ yok): bir Google hesabı tek
// işlemde 20 projeye bağlanır; 20 ACTIVE bağlantı AYNI şifreli token'ı taşır
// (yeni token yok), bağlar oluşur ve 21 proje reddedilir.

describeIntegration("GA bulk link (mock Google)", () => {
  const runId = randomUUID().slice(0, 8);
  const saved = {
    agency: process.env.GA_AGENCY,
    sync: process.env.GA_SYNC,
    mode: process.env.AGENTELSE_PROVIDER_MODE,
  };
  const PROPERTIES = [
    { propertyId: "424242", propertyName: "Web", accountName: "Agency" },
  ];
  let fixture: AgencyFixture;
  let sourceId: string;
  const targetIds: string[] = [];

  beforeAll(async () => {
    process.env.GA_AGENCY = "true";
    process.env.GA_SYNC = "true";
    process.env.AGENTELSE_PROVIDER_MODE = "mock";
    fixture = await createAgencyFixture(`bulk-${runId}`);
    const source = await prisma.integrationCredential.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        brandId: fixture.brandId,
        provider: "google_analytics",
        accountLabel: "boss@agency.test",
        encryptedSecret: `cipher-${runId}`,
        status: "ACTIVE",
        metadata: {
          connectedEmail: "boss@agency.test",
          googleSub: `sub-${runId}`,
          ga4Properties: PROPERTIES,
          selectedGa4PropertyId: "424242",
          selectedGa4PropertyName: "Web",
        },
      },
    });
    sourceId = source.id;
    // 21 hedef proje; her birinde süresi dolmuş, eski mülk seçimini taşıyan bağlantı.
    for (let i = 0; i < BULK_LINK_MAX + 1; i += 1) {
      const project = await prisma.project.create({
        data: {
          workspaceId: fixture.workspaceId,
          name: `Bulk Target ${runId} ${i}`,
          slug: `bulk-target-${runId}-${i}`,
          brands: {
            create: {
              workspaceId: fixture.workspaceId,
              name: `Bulk Brand ${i}`,
              slug: "default",
              isDefault: true,
            },
          },
        },
      });
      targetIds.push(project.id);
      await prisma.integrationCredential.create({
        data: {
          workspaceId: fixture.workspaceId,
          projectId: project.id,
          brandId: (await prisma.brand.findFirstOrThrow({ where: { projectId: project.id } })).id,
          provider: "google_analytics",
          encryptedSecret: "",
          status: "REVOKED",
          metadata: {
            selectedGa4PropertyId: "424242",
            selectedGa4PropertyName: "Web",
          },
        },
      });
    }
  }, 120_000);

  afterAll(async () => {
    process.env.GA_AGENCY = saved.agency;
    process.env.GA_SYNC = saved.sync;
    process.env.AGENTELSE_PROVIDER_MODE = saved.mode;
    if (!fixture) return;
    await prisma.gaPropertyLink.deleteMany({
      where: { workspaceId: fixture.workspaceId },
    });
    await prisma.integrationCredential.deleteMany({
      where: { workspaceId: fixture.workspaceId },
    });
    await teardownAgencyFixture(fixture.workspaceId);
  });

  it("refuses 21 projects without touching anything", async () => {
    const result = await bulkLinkGoogleAccount({
      workspaceId: fixture.workspaceId,
      userId: "user-test",
      sourceCredentialId: sourceId,
      projectIds: targetIds,
      autoProperty: false,
    });
    expect(result).toEqual({ ok: false, reason: "too_many" });
    expect(
      await prisma.integrationCredential.count({
        where: { workspaceId: fixture.workspaceId, status: "ACTIVE" },
      }),
    ).toBe(1);
  });

  it("links one Google account to 20 projects with the same token and no network", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("network must not be used");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const ids = targetIds.slice(0, BULK_LINK_MAX);
    let result: Awaited<ReturnType<typeof bulkLinkGoogleAccount>>;
    try {
      result = await bulkLinkGoogleAccount({
        workspaceId: fixture.workspaceId,
        userId: "user-test",
        sourceCredentialId: sourceId,
        projectIds: ids,
        autoProperty: false,
      });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(result.ok && result.linked).toBe(BULK_LINK_MAX);
    expect(fetchSpy).not.toHaveBeenCalled();

    const credentials = await prisma.integrationCredential.findMany({
      where: { projectId: { in: ids }, provider: "google_analytics" },
    });
    expect(credentials).toHaveLength(BULK_LINK_MAX);
    expect(credentials.every((row) => row.status === "ACTIVE")).toBe(true);
    // Yeni token yok: hepsi kaynağın aynı şifreli refresh token'ı.
    expect(new Set(credentials.map((row) => row.encryptedSecret))).toEqual(
      new Set([`cipher-${runId}`]),
    );
    // Projenin önceki mülk seçimi korundu, bağlar oluştu.
    const links = await prisma.gaPropertyLink.findMany({
      where: { projectId: { in: ids } },
    });
    expect(links).toHaveLength(BULK_LINK_MAX);
    expect(links.every((link) => link.propertyId === "424242" && link.isPrimary)).toBe(true);
    // Proje başına bir denetim satırı (bulk true).
    const audits = await prisma.auditLog.findMany({
      where: {
        workspaceId: fixture.workspaceId,
        action: "integration_credential.connected",
      },
    });
    expect(audits).toHaveLength(BULK_LINK_MAX);
    expect(audits.every((row) => (row.metadata as { bulk?: boolean }).bulk === true)).toBe(true);
  });

  it("skips a project that is already connected and never touches its credential", async () => {
    const [connected] = targetIds;
    const before = await prisma.integrationCredential.findFirstOrThrow({
      where: { projectId: connected, provider: "google_analytics" },
    });
    const result = await bulkLinkGoogleAccount({
      workspaceId: fixture.workspaceId,
      userId: "user-test",
      sourceCredentialId: sourceId,
      projectIds: [connected ?? ""],
      autoProperty: false,
    });
    expect(result.ok && result.rows[0]).toMatchObject({
      status: "skipped",
      reason: "already_connected",
    });
    const after = await prisma.integrationCredential.findFirstOrThrow({
      where: { projectId: connected, provider: "google_analytics" },
    });
    expect(after.updatedAt).toEqual(before.updatedAt);
  });
});
