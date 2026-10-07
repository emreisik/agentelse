import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { prisma } from "@/lib/prisma";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { SeoSites } from "@/server/seo/site/sites";
import { checkSiteVerification } from "@/server/seo/site/verify";
import { describeIntegration } from "@/test-support/integration-suite";

import {
  connectWordPress,
  disconnectWordPress,
  loadWordPressConnectionView,
  testWordPress,
} from "./connect";
import { mockWpCalls, resetMockWordPress } from "./mock-site";

// WordPress bağlantısı gerçek Postgres'e karşı, bellek içi sahte WordPress'le
// (yalnız CI ve yerel tek kullanımlık veritabanı; mock kipte ağa hiç çıkılmaz).
// Kanıtlanan: bağla -> sına -> kopar; Disconnect kimlik satırını, CmsSite'ı ve
// SeoChange satırlarını siler, Task metnini siler (başlık sabit, açıklama ve
// payload boş) ve SeoSite'a dokunmaz; şifre hiçbir satırda düz yazılmaz.

const runId = randomUUID().slice(0, 8);
const HOST = "example.com";
const PASSWORD = "abcdefghijklmnopqrstuvwx";
const T0 = new Date("2026-10-06T10:00:00Z");
const USER = `wp-int-${runId}`;

let fixture: AgencyFixture | undefined;
const savedEnv = {
  mode: process.env.AGENTELSE_PROVIDER_MODE,
  health: process.env.SEO_HEALTH,
  apply: process.env.SEO_APPLY,
};

describeIntegration("WordPress connector (mock WordPress)", () => {
  beforeAll(async () => {
    process.env.AGENTELSE_PROVIDER_MODE = "mock";
    process.env.SEO_HEALTH = "true";
    process.env.SEO_APPLY = "true";
    resetMockWordPress();
    fixture = await createAgencyFixture(`wp-connect-${runId}`);
    await prisma.project.update({
      where: { id: fixture.projectId },
      data: { domain: HOST, status: "ACTIVE" },
    });
    const verified = await checkSiteVerification(fixture.projectId, {}, T0);
    expect(verified).toEqual({ ok: true, method: "MOCK" });
  });

  afterAll(async () => {
    resetMockWordPress();
    if (fixture) {
      await prisma.cmsSite.deleteMany({ where: { projectId: fixture.projectId } });
      await prisma.integrationCredential.deleteMany({
        where: { projectId: fixture.projectId },
      });
      await prisma.seoApplySetting.deleteMany({
        where: { projectId: fixture.projectId },
      });
      await prisma.seoSite.deleteMany({ where: { projectId: fixture.projectId } });
      await teardownAgencyFixture(fixture.workspaceId);
    }
    process.env.AGENTELSE_PROVIDER_MODE = savedEnv.mode;
    process.env.SEO_HEALTH = savedEnv.health;
    process.env.SEO_APPLY = savedEnv.apply;
  });

  it("connects, tests and disconnects, deleting rows and scrubbing task text", async () => {
    if (!fixture) throw new Error("fixture missing");
    const { projectId, workspaceId, brandId } = fixture;

    const connected = await connectWordPress({
      projectId,
      workspaceId,
      brandId,
      userId: USER,
      siteUrl: `https://${HOST}`,
      username: "agentelse",
      appPassword: PASSWORD,
    });
    expect(connected.ok).toBe(true);

    const credential = await prisma.integrationCredential.findUniqueOrThrow({
      where: { projectId_provider: { projectId, provider: "wordpress_mock" } },
    });
    expect(credential.status).toBe("ACTIVE");
    expect(credential.encryptedSecret).not.toContain(PASSWORD);
    expect(JSON.stringify(credential.metadata)).not.toContain(PASSWORD);
    expect(
      await prisma.integrationCredential.count({
        where: { projectId, provider: "wordpress" },
      }),
    ).toBe(0);

    const site = await prisma.cmsSite.findUniqueOrThrow({
      where: {
        projectId_kind_isMock: { projectId, kind: "WORDPRESS", isMock: true },
      },
    });
    expect(site).toMatchObject({
      origin: `https://${HOST}`,
      health: "OK",
      seoPlugin: "YOAST",
      credentialId: credential.id,
      scopeKey: `VERIFIED_DOMAIN:${HOST}:`,
    });

    const view = await loadWordPressConnectionView(projectId, USER);
    expect(view).toMatchObject({ connected: true, host: HOST, health: "OK" });
    expect(JSON.stringify(view)).not.toContain(PASSWORD);

    const tested = await testWordPress(projectId, { userId: USER, isManager: true });
    expect(tested.ok).toBe(true);

    // Siteye bağlı bir değişiklik ve görevi (metin silinmeli).
    const task = await prisma.task.create({
      data: {
        workspaceId,
        projectId,
        brandId,
        title: "Change a page title and description on WordPress",
        description: "Customer page text",
        payload: { seoApply: { v: 1, changeId: "x", kind: "TITLE_META" }, details: [{ label: "Page", value: "/pricing" }] },
        capability: "WEBSITE_UPDATE",
        status: "WAITING_APPROVAL",
        createdByType: "USER",
      },
    });
    await prisma.seoChange.create({
      data: {
        workspaceId,
        projectId,
        siteId: site.id,
        isMock: true,
        kind: "TITLE_META",
        source: "ACTION",
        title: "Change a page title and description on WordPress",
        params: { kind: "TITLE_META", url: `https://${HOST}/pricing` },
        dedupeKey: "meta:page:101",
        openKey: "meta:page:101",
        proposedByType: "USER",
        proposedByUserId: USER,
        taskId: task.id,
        expiresAt: new Date(Date.now() + 7 * 24 * 3_600_000),
      },
    });

    const seoSiteBefore = await SeoSites.forProject(projectId);
    const disconnected = await disconnectWordPress({ projectId, workspaceId, userId: USER });
    expect(disconnected).toEqual({ ok: true });

    expect(
      await prisma.integrationCredential.count({ where: { projectId } }),
    ).toBe(0);
    expect(await prisma.cmsSite.count({ where: { projectId } })).toBe(0);
    expect(await prisma.seoChange.count({ where: { projectId } })).toBe(0);

    const scrubbed = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(scrubbed.title).toBe("WordPress change");
    expect(scrubbed.description).toBeNull();
    expect(scrubbed.payload).toEqual({});
    expect(scrubbed.status).toBe("CANCELLED");

    // Application Password WordPress tarafında da iptal edilmeye çalışılır.
    expect(
      mockWpCalls().some(
        (call) =>
          call.method === "DELETE" &&
          call.route.startsWith("wp/v2/users/me/application-passwords/"),
      ),
    ).toBe(true);

    // SeoSite'a dokunulmaz.
    const seoSiteAfter = await SeoSites.forProject(projectId);
    expect(seoSiteAfter?.id).toBe(seoSiteBefore?.id);
    expect(seoSiteAfter?.scopeKey).toBe(`VERIFIED_DOMAIN:${HOST}:`);

    const audits = await prisma.auditLog.findMany({
      where: { projectId, action: { startsWith: "integration_credential." } },
      orderBy: { createdAt: "asc" },
    });
    expect(audits.map((row) => row.action)).toEqual([
      "integration_credential.connected",
      "integration_credential.disconnected",
    ]);
    expect(JSON.stringify(audits)).not.toContain(PASSWORD);
  });

  it("returns no view and runs no query when SEO_APPLY is off", async () => {
    if (!fixture) throw new Error("fixture missing");
    process.env.SEO_APPLY = "false";
    try {
      expect(await loadWordPressConnectionView(fixture.projectId, USER)).toBeNull();
    } finally {
      process.env.SEO_APPLY = "true";
    }
  });
});
