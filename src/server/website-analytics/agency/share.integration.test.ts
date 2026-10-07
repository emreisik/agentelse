import { randomUUID } from "node:crypto";

import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

// KABUL TESTİ (GA-F8 white-label): gerçek Postgres'e karşı müşteri bağlantısı ve
// Markdown dışa aktarma. Mock modda Google'a gidilmez. İntegratörün paylaşılan
// düzenlemelerinden sonra koşar (reports/cleanup.ts forget çağrısı, register-all).

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

const hoisted = vi.hoisted(() => ({
  renderers: {} as Record<string, unknown>,
  userId: "user-share-it",
}));

// Kayıt defteri adı bilinmeden çizici yakalanır: kayıt gerçekten de yapılır.
vi.mock("@/server/report-share/renderers", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/server/report-share/renderers")>();
  return {
    ...actual,
    registerShareRenderer: (
      kind: Parameters<typeof actual.registerShareRenderer>[0],
      renderer: Parameters<typeof actual.registerShareRenderer>[1],
    ) => {
      hoisted.renderers[kind] = renderer;
      actual.registerShareRenderer(kind, renderer);
    },
  };
});
vi.mock("@/server/security/tenant-context", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/server/security/tenant-context")>();
  return {
    ...actual,
    requireUser: async () => ({ userId: hoisted.userId }),
    requireProjectAccess: async (_userId: string, projectId: string) => {
      const { prisma } = await import("@/lib/prisma");
      const project = await prisma.project.findUniqueOrThrow({
        where: { id: projectId },
        select: { workspaceId: true },
      });
      return {
        workspaceId: project.workspaceId,
        projectId,
        defaultBrandId: "unused",
      };
    },
    isWorkspaceManager: async () => true,
  };
});

import { prisma } from "@/lib/prisma";
import {
  sampleWeeklyCard,
} from "@/lib/website-analytics/reports/test-fixtures";
import { websiteWorkId } from "@/lib/website-analytics/reports/ids";
import { GET as exportGet } from "@/app/api/projects/[projectId]/client-report/route";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { ReportBrandings } from "@/server/report-share/branding";
import { ReportShares } from "@/server/report-share/store";
import { deleteGaReportData } from "@/server/website-analytics/reports/cleanup";
import { describeIntegration } from "@/test-support/integration-suite";

import {
  createWebsiteReportShare,
  listWebsiteReportShares,
  revokeWebsiteReportShare,
} from "./share";
import {
  forgetWebsiteSharesForProject,
  sweepOrphanWebsiteShares,
} from "./share-forget";

await import("./share-renderer");

type Renderer = (share: {
  projectId: string;
  reportId: string;
  branding: Awaited<ReturnType<typeof ReportBrandings.get>>;
}) => Promise<{
  title: string;
  periodLabel: string | null;
  node: React.ReactNode;
} | null>;

// resolve'un dönüş biçimi SC-F9'a ait: null/false/{ok:false} çözülmedi sayılır.
function resolved(value: unknown): boolean {
  if (!value) return false;
  if (typeof value === "object" && (value as { ok?: unknown }).ok === false) {
    return false;
  }
  return true;
}

describeIntegration("GA white-label export and share (mock Google)", () => {
  const runId = randomUUID().slice(0, 8);
  const keys = [
    "GA_AGENCY",
    "GA_SYNC",
    "GA_REPORTS",
    "AGENTELSE_PROVIDER_MODE",
  ] as const;
  const saved: Record<string, string | undefined> = {};
  let fixture: AgencyFixture;
  let primaryLinkId: string;
  let extraLinkId: string;

  const primaryId = () => `garep_weekly_${fixture.projectId}_2026-09-28`;
  const extraId = () =>
    `garep_weekly_${fixture.projectId}_s_${extraLinkId}_2026-09-28`;
  const thirdId = () => `garep_weekly_${fixture.projectId}_2026-09-21`;

  async function seedCard(id: string, linkId: string, propertyName: string) {
    await prisma.command.create({
      data: {
        id,
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        workId: websiteWorkId(fixture.projectId),
        source: "SYSTEM",
        rawText: "",
        replyText: "Weekly website report",
        parsedIntent: {
          card: sampleWeeklyCard({
            projectId: fixture.projectId,
            linkId,
            propertyName,
            title: "Agentelse weekly report",
            isMock: true,
          }),
        } as never,
      },
    });
  }

  async function brandingNow() {
    return ReportBrandings.get(fixture.workspaceId);
  }

  async function shareFor(commandId: string) {
    const result = await createWebsiteReportShare({
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      userId: hoisted.userId,
      commandId,
      days: 30,
      confirmPublic: true,
    });
    if (!result.ok) throw new Error(`share failed: ${result.reason}`);
    return result;
  }

  beforeAll(async () => {
    for (const key of keys) saved[key] = process.env[key];
    process.env.GA_AGENCY = "true";
    process.env.GA_SYNC = "true";
    process.env.GA_REPORTS = "true";
    process.env.AGENTELSE_PROVIDER_MODE = "mock";
    fixture = await createAgencyFixture(`ga-share-${runId}`);
    const credential = await prisma.integrationCredential.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        brandId: fixture.brandId,
        provider: "google_analytics",
        accountLabel: "owner@example.com",
        encryptedSecret: "not-used-in-mock-mode",
        status: "ACTIVE",
        metadata: {},
      },
    });
    const primary = await prisma.gaPropertyLink.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        credentialId: credential.id,
        propertyId: "111111",
        isPrimary: true,
        isMock: true,
        propertyName: "Primary Site",
        health: "OK",
      },
    });
    const extra = await prisma.gaPropertyLink.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        credentialId: credential.id,
        propertyId: "222222",
        isPrimary: false,
        isSecondary: true,
        isMock: true,
        propertyName: "Second Site",
        health: "OK",
      },
    });
    primaryLinkId = primary.id;
    extraLinkId = extra.id;
    await prisma.work.create({
      data: {
        id: websiteWorkId(fixture.projectId),
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        title: "Website analytics",
        module: "analytics",
      },
    });
    await seedCard(primaryId(), primaryLinkId, "Primary Site");
    await seedCard(extraId(), extraLinkId, "Second Site");
    await seedCard(thirdId(), primaryLinkId, "Primary Site");
  }, 60_000);

  afterAll(async () => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    const projectId = fixture?.projectId;
    await prisma.reportShare.deleteMany({ where: { projectId } });
    await prisma.command.deleteMany({ where: { projectId } });
    await prisma.work.deleteMany({ where: { projectId } });
    await prisma.gaPropertyLink.deleteMany({ where: { projectId } });
    await prisma.integrationCredential.deleteMany({
      where: { workspaceId: fixture?.workspaceId },
    });
    await prisma.auditLog.deleteMany({
      where: { workspaceId: fixture?.workspaceId },
    });
    await teardownAgencyFixture(fixture?.workspaceId);
  });

  it("creates a WEBSITE share and the registered renderer returns only that link's document", async () => {
    const renderer = hoisted.renderers.WEBSITE as Renderer | undefined;
    expect(renderer).toBeTypeOf("function");
    const branding = await brandingNow();

    const created = await shareFor(primaryId());
    expect(created.url).toMatch(/\/r\/[A-Za-z0-9._-]+$/);

    const primary = await renderer?.({
      projectId: fixture.projectId,
      reportId: primaryId(),
      branding,
    });
    expect(primary).toBeTruthy();
    const primaryHtml = renderToStaticMarkup(
      primary?.node as React.ReactElement,
    );
    expect(primaryHtml).toContain("Primary Site");
    expect(primaryHtml).not.toContain("Second Site");
    expect(primaryHtml.toLowerCase()).not.toContain("agentelse");
    expect(primary?.title.toLowerCase()).not.toContain("agentelse");

    const extra = await renderer?.({
      projectId: fixture.projectId,
      reportId: extraId(),
      branding,
    });
    const extraHtml = renderToStaticMarkup(extra?.node as React.ReactElement);
    expect(extraHtml).toContain("Second Site");
    expect(extraHtml).not.toContain("Primary Site");

    // Başka projenin kimliği ya da plan kimliği çizilmez.
    expect(
      await renderer?.({ projectId: "other", reportId: primaryId(), branding }),
    ).toBeNull();
    expect(
      await renderer?.({
        projectId: fixture.projectId,
        reportId: `garep_plan_${fixture.projectId}_2026-10`,
        branding,
      }),
    ).toBeNull();
  });

  it("resolves the returned token and stops after revoke", async () => {
    const created = await shareFor(extraId());
    const token = created.url.split("/r/")[1] ?? "";
    expect(resolved(await ReportShares.resolve(token))).toBe(true);

    const listed = await listWebsiteReportShares(fixture.projectId, [extraId()]);
    const rows = listed[extraId()] ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "WEBSITE", status: "ACTIVE" });

    expect(
      await revokeWebsiteReportShare({
        projectId: fixture.projectId,
        shareId: rows[0]?.id ?? "",
        userId: hoisted.userId,
      }),
    ).toBe(true);
    expect(resolved(await ReportShares.resolve(token))).toBe(false);
  });

  it("exports an attachment .md with the agency name and without Agentelse", async () => {
    const branding = await brandingNow();
    const response = await exportGet(
      new Request(
        `https://app.example.com/api/projects/${fixture.projectId}/client-report?command=${primaryId()}&format=md`,
      ),
      { params: Promise.resolve({ projectId: fixture.projectId }) },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Disposition")).toMatch(
      /^attachment; filename="[a-z0-9-]+\.md"$/,
    );
    const text = await response.text();
    expect(text).toContain(`Prepared by ${branding.displayName}`);
    expect(text.toLowerCase()).not.toContain("agentelse");
    expect(
      await prisma.auditLog.count({
        where: {
          projectId: fixture.projectId,
          action: "ga_client_report.exported",
        },
      }),
    ).toBe(1);
  });

  it("sweeps shares whose Command is gone and keeps the others (real table names)", async () => {
    const keep = await shareFor(primaryId());
    const orphan = await shareFor(thirdId());
    expect(keep.ok && orphan.ok).toBe(true);
    await prisma.command.delete({ where: { id: thirdId() } });

    const removed = await sweepOrphanWebsiteShares();
    expect(removed).toBeGreaterThanOrEqual(1);

    const remaining = await prisma.reportShare.findMany({
      where: { projectId: fixture.projectId, kind: "WEBSITE" },
      select: { reportId: true },
    });
    const ids = remaining.map((row) => row.reportId);
    expect(ids).not.toContain(thirdId());
    expect(ids).toContain(primaryId());
    // Var olan karta dokunulmaz: ikinci süpürme bu proje için hiçbir şey silmez.
    await sweepOrphanWebsiteShares();
    expect(
      await prisma.reportShare.count({
        where: {
          projectId: fixture.projectId,
          kind: "WEBSITE",
          reportId: primaryId(),
        },
      }),
    ).toBeGreaterThan(0);
  });

  it("removes the WEBSITE share rows when the report data is deleted", async () => {
    await shareFor(primaryId());
    expect(
      await prisma.reportShare.count({
        where: { projectId: fixture.projectId, kind: "WEBSITE" },
      }),
    ).toBeGreaterThan(0);
    // reports/cleanup.ts paylaşılan düzenlemesi (forgetWebsiteSharesForProject).
    await deleteGaReportData(fixture.projectId);
    expect(
      await prisma.reportShare.count({
        where: { projectId: fixture.projectId, kind: "WEBSITE" },
      }),
    ).toBe(0);
    // Doğrudan çağrı da güvenlidir ve bir şey kalmamışken 0 döner.
    expect(await forgetWebsiteSharesForProject(fixture.projectId)).toBe(0);
  });
});
