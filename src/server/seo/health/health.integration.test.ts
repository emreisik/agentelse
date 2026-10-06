import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ notifyProject: vi.fn() }));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/server/notifications/project-telegram-notifier", () => ({
  notifyProjectTelegram: mocks.notifyProject,
}));
vi.mock("@/lib/app-url", () => ({
  appUrl: (path: string) => new URL(path, "https://app.example"),
}));

import { prisma } from "@/lib/prisma";
import { crawlUrlHash, normalizeCrawlUrl } from "@/lib/seo/crawl-url";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { describeIntegration } from "@/test-support/integration-suite";

import { deleteSearchConsoleAlerts, muteSearchAlert } from "./alerts";
import { SeoHealth } from "./runner";

// Arama sağlığı motoru gerçek Postgres'e ve gerçek SiteAlerts'e karşı (mock
// kip). GA-F3 birleşmesinden SONRA koşar: SiteAlerts, AdsAlert.source ve
// kardeş paketlerin (B2 SeoSites/keyPagesFor/readAuditSummary, C okuyucuları)
// gerçek kodu gerekir. Ana sayfada noindex + taze bekçi kontrolü CRITICAL
// "seo:SEO_KEY_PAGE_NOINDEX" uyarısı açar ve puanı 40'ın altında tutar;
// sayfa düzelince uyarı kapanır; Search Console uyarılarının silinmesi
// SEO_HEALTH kapalıyken de yalnız source "GSC" satırlarını siler; susturma
// Ads uyarısını reddeder.

describeIntegration("SeoHealth (real SiteAlerts, mock mode)", () => {
  const runId = randomUUID().slice(0, 8);
  const credentialId = `cred-${runId}`;
  const homeUrl = normalizeCrawlUrl("https://example.com/")!;
  const homeHash = crawlUrlHash(homeUrl);
  let fixture: AgencyFixture;
  let siteId = "";

  beforeAll(async () => {
    vi.stubEnv("AGENTELSE_PROVIDER_MODE", "mock");
    vi.stubEnv("SEO_HEALTH", "true");
    vi.stubEnv("SEO_CRAWL", "true");
    vi.stubEnv("SEO_ROLLOUT_PROJECTS", "");
    fixture = await createAgencyFixture(`seo-health-${runId}`);
    const now = new Date();
    await prisma.project.update({
      where: { id: fixture.projectId },
      data: { domain: "example.com", status: "ACTIVE" },
    });
    const site = await prisma.seoSite.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        isMock: true,
        scope: {
          kind: "GSC_DOMAIN",
          root: "example.com",
          prefix: null,
          key: "GSC_DOMAIN:example.com:",
        },
        scopeKey: "GSC_DOMAIN:example.com:",
        origin: "https://example.com",
        settings: { v: 1, crawlEnabled: true, pageLimit: 500 },
        lastRegressionAt: now,
        healthDueAt: now,
      },
    });
    siteId = site.id;
    await prisma.seoPage.create({
      data: {
        siteId,
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        url: homeUrl,
        urlHash: homeHash,
        path: "/",
        discoveredVia: "SEED",
        status: 200,
        contentType: "text/html",
        noindex: true,
        robotsMeta: "noindex, follow",
        indexable: false,
        lastCrawledAt: now,
        firstSeenAt: now,
      },
    });
    const link = await prisma.gscSiteLink.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        credentialId,
        siteUrl: "sc-domain:example.com",
        isMock: true,
        health: "OK",
        domainMatch: true,
      },
    });
    await prisma.gscUrlInspection.create({
      data: {
        linkId: link.id,
        projectId: fixture.projectId,
        url: homeUrl,
        urlHash: homeHash,
        reason: "P1",
        inspectedAt: now,
        verdict: "PASS",
      },
    });
  });

  afterAll(async () => {
    if (fixture) {
      await prisma.adsAlert.deleteMany({
        where: { projectId: fixture.projectId },
      });
      await prisma.seoSite.deleteMany({
        where: { projectId: fixture.projectId },
      });
      await prisma.gscSiteLink.deleteMany({
        where: { projectId: fixture.projectId },
      });
      await teardownAgencyFixture(fixture.workspaceId);
    }
    vi.unstubAllEnvs();
  });

  it("raises a CRITICAL SEO noindex alert and caps the stored score", async () => {
    const result = await SeoHealth.evaluateProject(
      fixture.projectId,
      new Date(),
    );
    expect(result?.drafts.map((draft) => draft.kind)).toContain(
      "SEO_KEY_PAGE_NOINDEX",
    );
    const alert = await prisma.adsAlert.findUnique({
      where: {
        projectId_dedupeKey: {
          projectId: fixture.projectId,
          dedupeKey: "seo:SEO_KEY_PAGE_NOINDEX",
        },
      },
    });
    expect(alert).toMatchObject({
      source: "SEO",
      kind: "SEO_KEY_PAGE_NOINDEX",
      severity: "CRITICAL",
      status: "OPEN",
      title: "Your homepage is set to noindex",
    });
    const site = await prisma.seoSite.findUniqueOrThrow({
      where: { id: siteId },
    });
    expect(site.healthScore).not.toBeNull();
    expect(site.healthScore!).toBeLessThanOrEqual(40);
    expect(site.healthComputedAt).not.toBeNull();
  });

  it("resolves the alert after the page is fixed", async () => {
    await prisma.seoPage.update({
      where: { siteId_urlHash: { siteId, urlHash: homeHash } },
      data: {
        noindex: false,
        robotsMeta: null,
        indexable: true,
        lastCrawledAt: new Date(),
      },
    });
    await SeoHealth.evaluateProject(fixture.projectId, new Date());
    const alert = await prisma.adsAlert.findUniqueOrThrow({
      where: {
        projectId_dedupeKey: {
          projectId: fixture.projectId,
          dedupeKey: "seo:SEO_KEY_PAGE_NOINDEX",
        },
      },
    });
    expect(alert.status).toBe("RESOLVED");
  });

  it("deletes only GSC alerts, even with SEO_HEALTH off", async () => {
    await prisma.adsAlert.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        source: "GSC",
        kind: "GSC_SEARCH_DROP",
        severity: "WARN",
        dedupeKey: "gsc:GSC_SEARCH_DROP",
        title: "Clicks from Google dropped",
      },
    });
    await prisma.adsAlert.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        source: "SEO",
        kind: "SEO_HTTPS",
        severity: "WARN",
        dedupeKey: "seo:SEO_HTTPS",
        title: "Some pages are not fully secure",
      },
    });
    vi.stubEnv("SEO_HEALTH", "false");
    try {
      const result = await deleteSearchConsoleAlerts(credentialId);
      expect(result.projectIds).toEqual([fixture.projectId]);
      expect(result.deleted).toBe(1);
    } finally {
      vi.stubEnv("SEO_HEALTH", "true");
    }
    const left = await prisma.adsAlert.findMany({
      where: { projectId: fixture.projectId },
      select: { source: true },
    });
    expect(left.map((row) => row.source)).not.toContain("GSC");
    expect(left.map((row) => row.source)).toContain("SEO");
  });

  it("refuses to mute an Ads alert", async () => {
    const ads = await prisma.adsAlert.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        kind: "TRACKING_STALE",
        severity: "WARN",
        dedupeKey: `ads-${runId}`,
        title: "Ads row",
      },
    });
    expect(await muteSearchAlert(ads.id, fixture.projectId)).toBe(false);
    const row = await prisma.adsAlert.findUniqueOrThrow({
      where: { id: ads.id },
    });
    expect(row.status).toBe("OPEN");
  });
});
