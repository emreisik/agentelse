import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { dayKeyToDate } from "@/lib/seo/dates";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { forgetAgencyForCredential } from "@/server/seo/agency/forget";
import { describeIntegration } from "@/test-support/integration-suite";

import { ReportBrandings } from "./branding";
import { ReportShareRetention } from "./retention";
import { shareRendererFor } from "./renderers";
import { ReportShares } from "./store";
import "./register-all";

// Paylaşım gerçek Postgres'e karşı (yalnız CI ve yerel tek kullanımlık
// veritabanı): SeoReport doğrudan eklenir, bağlantı oluşturulur, çözülür,
// iptal edilir, süresi dolar; Disconnect yolu (forgetAgencyForCredential)
// bağlantıyı projeye göre siler ve resolve başarısız olur; SeoReport tek
// başına silinince çizici null verir ve saklama satırı kaldırır; marka
// anlık görüntüsü sonradan değişmez. Oluşturduğu satırları kendisi siler.

const SITE = "sc-domain:share-integration.test";
const DAY = 86_400_000;

describeIntegration("report share (real Postgres)", () => {
  const runId = randomUUID().slice(0, 8);
  const saved = {
    sync: process.env.GSC_SYNC,
    reports: process.env.SEO_REPORTS,
    agency: process.env.GSC_AGENCY,
    mode: process.env.AGENTELSE_PROVIDER_MODE,
    rollout: process.env.GSC_ROLLOUT_PROJECTS,
  };
  let fixture: AgencyFixture;
  let credentialId: string;
  let linkId: string;
  let reportId: string;

  function restore(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  async function insertReport(periodKey: string): Promise<string> {
    const row = await prisma.seoReport.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        linkId,
        kind: "WEEKLY",
        periodKey,
        periodStart: dayKeyToDate("2026-09-28"),
        periodEnd: dayKeyToDate("2026-10-04"),
        finalThrough: "2026-10-04",
        language: "en",
        title: "Weekly report",
        snapshot: {
          v: 1,
          kind: "WEEKLY",
          title: "Weekly report",
          periodKey,
          period: { from: "2026-09-28", to: "2026-10-04", label: "Sep 28 - Oct 4" },
          compare: null,
          yearAgo: null,
          site: { label: "share-integration.test", isMock: true },
          finalThrough: "2026-10-04",
          brandSplit: false,
          anonymousShare: null,
          sections: [],
          notes: [],
        },
        commandId: `seoweekly_${linkId}_${periodKey}`,
        isMock: true,
      },
      select: { id: true },
    });
    return row.id;
  }

  function create(overrides: { reportId?: string; days?: number; now?: Date } = {}) {
    return ReportShares.create({
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      kind: "SEARCH",
      reportId: overrides.reportId ?? reportId,
      days: overrides.days ?? 30,
      userId: "user-integration",
      branding: {
        displayName: "Acme Agency",
        accent: "blue",
        footer: null,
        logoAssetId: null,
      },
      ...(overrides.now ? { now: overrides.now } : {}),
    });
  }

  beforeAll(async () => {
    process.env.GSC_SYNC = "true";
    process.env.SEO_REPORTS = "true";
    process.env.GSC_AGENCY = "true";
    process.env.AGENTELSE_PROVIDER_MODE = "mock";
    process.env.GSC_ROLLOUT_PROJECTS = "";
    fixture = await createAgencyFixture(`share-${runId}`);
    const credential = await prisma.integrationCredential.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        brandId: fixture.brandId,
        provider: "google_search_console",
        accountLabel: "owner@example.com",
        encryptedSecret: "not-used-in-mock-mode",
        status: "ACTIVE",
      },
    });
    credentialId = credential.id;
    const link = await prisma.gscSiteLink.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        credentialId,
        siteUrl: SITE,
        isMock: true,
        propertyType: "DOMAIN",
        permissionLevel: "siteOwner",
        health: "OK",
      },
    });
    linkId = link.id;
    reportId = await insertReport("W:2026-09-28");
  });

  afterAll(async () => {
    await prisma.reportShare.deleteMany({
      where: { workspaceId: fixture.workspaceId },
    });
    await prisma.reportBranding.deleteMany({
      where: { workspaceId: fixture.workspaceId },
    });
    // SeoReport bağa cascade'li.
    await prisma.gscSiteLink.deleteMany({
      where: { projectId: fixture.projectId },
    });
    await prisma.integrationCredential.deleteMany({
      where: { projectId: fixture.projectId },
    });
    await teardownAgencyFixture(fixture.workspaceId);
    restore("GSC_SYNC", saved.sync);
    restore("SEO_REPORTS", saved.reports);
    restore("GSC_AGENCY", saved.agency);
    restore("AGENTELSE_PROVIDER_MODE", saved.mode);
    restore("GSC_ROLLOUT_PROJECTS", saved.rollout);
  });

  it("creates, resolves, counts a view and renders the stored report", async () => {
    const created = await create();
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const row = await prisma.reportShare.findUniqueOrThrow({
      where: { id: created.id },
    });
    // Veritabanında gizli parça yok, yalnız özet.
    expect(created.token).not.toContain(row.tokenHash);
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(created.token.endsWith(row.tokenHash)).toBe(false);

    const resolved = await ReportShares.resolve(created.token);
    expect(resolved.ok).toBe(true);
    const after = await prisma.reportShare.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(after.viewCount).toBe(1);
    // Aynı dakikada ikinci görüntüleme sayacı artırmaz.
    await ReportShares.resolve(created.token);
    const again = await prisma.reportShare.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(again.viewCount).toBe(1);

    const renderer = shareRendererFor("SEARCH");
    const rendered = await renderer?.({
      projectId: fixture.projectId,
      reportId,
      branding: {
        displayName: "Acme Agency",
        accent: "blue",
        footer: null,
        logoAssetId: null,
      },
    });
    expect(rendered?.title).toBe("Weekly report");
    expect(rendered?.periodLabel).toBe("Sep 28 - Oct 4");
  });

  it("revokes, and a wrong secret or revoked link resolves to the same failure", async () => {
    const created = await create();
    if (!created.ok) throw new Error("create failed");
    const [id] = created.token.split(".");
    expect(
      await ReportShares.revoke({
        projectId: "another-project",
        shareId: created.id,
        userId: "u",
      }),
    ).toBe(false);
    expect(
      await ReportShares.revoke({
        projectId: fixture.projectId,
        shareId: created.id,
        userId: "u",
      }),
    ).toBe(true);
    expect(await ReportShares.resolve(created.token)).toEqual({ ok: false });
    const wrong = `${id}.${"A".repeat(43)}`;
    expect(await ReportShares.resolve(wrong)).toEqual({ ok: false });
    const listed = await ReportShares.listForProject(
      fixture.projectId,
      "SEARCH",
      [reportId],
    );
    expect(listed[reportId]?.some((item) => item.status === "REVOKED")).toBe(true);
  });

  it("stops resolving after the expiry", async () => {
    const created = await create({ now: new Date(Date.now() - 31 * DAY) });
    if (!created.ok) throw new Error("create failed");
    expect(await ReportShares.resolve(created.token)).toEqual({ ok: false });
  });

  it("keeps the branding snapshot when the live branding changes", async () => {
    const created = await create();
    if (!created.ok) throw new Error("create failed");
    const saved = await ReportBrandings.save({
      workspaceId: fixture.workspaceId,
      userId: "u",
      value: {
        displayName: "Renamed Agency",
        accent: "rose",
        footer: "New footer",
        logoAssetId: null,
      },
    });
    expect(saved).toEqual({ ok: true });
    expect((await ReportBrandings.get(fixture.workspaceId)).displayName).toBe(
      "Renamed Agency",
    );
    const row = await prisma.reportShare.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(row.branding).toMatchObject({ displayName: "Acme Agency" });
  });

  it("removes the renderer's report and the retention step deletes the orphan share", async () => {
    const orphanReport = await insertReport("W:2026-09-21");
    const created = await create({ reportId: orphanReport });
    if (!created.ok) throw new Error("create failed");
    await prisma.seoReport.delete({ where: { id: orphanReport } });

    const renderer = shareRendererFor("SEARCH");
    expect(
      await renderer?.({
        projectId: fixture.projectId,
        reportId: orphanReport,
        branding: {
          displayName: "Acme",
          accent: "slate",
          footer: null,
          logoAssetId: null,
        },
      }),
    ).toBeNull();

    // Yerel veritabanı: global iş izinli. claimPeriodic'i serbest bırak.
    await prisma.systemHeartbeat.deleteMany({
      where: { key: "report-share.retention" },
    });
    await ReportShareRetention.runDue(new Date());
    expect(
      await prisma.reportShare.findUnique({ where: { id: created.id } }),
    ).toBeNull();
    // Raporu var olan bağlantılara dokunulmadı.
    expect(
      await prisma.reportShare.count({
        where: { projectId: fixture.projectId, reportId },
      }),
    ).toBeGreaterThan(0);
  });

  it("Disconnect (forgetAgencyForCredential) deletes the project's shares", async () => {
    const created = await create();
    if (!created.ok) throw new Error("create failed");
    expect((await ReportShares.resolve(created.token)).ok).toBe(true);
    const result = await forgetAgencyForCredential(credentialId);
    expect(result.shares).toBeGreaterThan(0);
    expect(await ReportShares.resolve(created.token)).toEqual({ ok: false });
    expect(
      await prisma.reportShare.count({
        where: { projectId: fixture.projectId, kind: "SEARCH" },
      }),
    ).toBe(0);
  });
});
