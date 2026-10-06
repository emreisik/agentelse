import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { crawlUrlHash } from "@/lib/seo/crawl-url";
import { prisma } from "@/lib/prisma";
import type { GuardedTransport } from "@/server/security/guarded-transport";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { parseInspectQueue } from "@/server/seo/site/inspect-queue";
import { SeoSites } from "@/server/seo/site/sites";
import { checkSiteVerification } from "@/server/seo/site/verify";
import { describeIntegration } from "@/test-support/integration-suite";

import { SeoCrawler } from "./crawler";
import type { HostPacer } from "./pacer";
import {
  mockSiteTransport,
  setMockSiteOverrides,
  type MockPageOverride,
  type MockRequestLog,
} from "./mock-site";

// Site tarayıcısı gerçek Postgres'e karşı, bellek içi mock siteyle (yalnız CI
// ve yerel tek kullanımlık veritabanı; paralel paketler birleştikten SONRA
// koşar: B1 fetcher/mock-site ve A ayrıştırıcıları gerekir). Kanıtlanan:
// birkaç koşuya yayılan tam tarama bütçe içinde biter, robots'un yasakladığı
// ve eş alan adındaki sayfalar hiç istenmez; durum kodları, zincirler, link
// grafiği ve TA sorunları yazılır; sitemap envanterinin taban çizgisi; ikinci
// tarama 304 alır; bekçi noindex'i tek koşuda görür ve yalnız GSC bağı varken
// kuyruğa ekler; robots 5xx'i ancak iki denemede sayılır; 'Disallow: /'
// robots'u OK'dir; alan adı kalkınca tarama verisi silinir.

const runId = randomUUID().slice(0, 8);
const HOST = "example.com";
const HOME = `https://${HOST}/`;
const T0 = new Date("2026-10-06T10:00:00Z");
const HOUR = 3_600_000;

let fixture: AgencyFixture | undefined;
let siteId = "";
const log: MockRequestLog = [];
let overrides: Record<string, MockPageOverride> = {};
const savedEnv = {
  mode: process.env.AGENTELSE_PROVIDER_MODE,
  health: process.env.SEO_HEALTH,
  crawl: process.env.SEO_CRAWL,
};

// Override'lar hem modül düzeyinde (siteTransport) hem testin taşıyıcısında.
function setOverrides(next: Record<string, MockPageOverride>) {
  overrides = next;
  setMockSiteOverrides(Object.keys(next).length ? next : null);
}

const transport: GuardedTransport = (url, request) =>
  mockSiteTransport({ overrides, log })(url, request);
const pacer: HostPacer = {
  wait: () => new Promise<void>((resolve) => setTimeout(resolve, 20)),
};
const noSleep = () => Promise.resolve();

async function run(now: Date, budgetMs = 400) {
  return SeoCrawler.runSite(siteId, {
    now,
    budgetMs,
    deps: { transport, pacer },
    sleep: noSleep,
  });
}

async function page(path: string) {
  return prisma.seoPage.findUnique({
    where: {
      siteId_urlHash: {
        siteId,
        urlHash: crawlUrlHash(`https://${HOST}${path}`),
      },
    },
  });
}

async function crawlUntilDone(
  now: Date,
  budgetMs = 400,
  maxRuns = 60,
): Promise<number> {
  for (let runs = 1; runs <= maxRuns; runs += 1) {
    await run(now, budgetMs);
    // Tarama ilk koşuda başlamamış olabilir (robots, sitemap ve bekçi önce).
    const finished = await prisma.seoCrawl.count({
      where: {
        siteId,
        kind: "FULL",
        startedAt: now,
        status: { in: ["DONE", "PARTIAL"] },
      },
    });
    if (finished > 0) return runs;
  }
  throw new Error("full crawl did not finish");
}

describeIntegration("SeoCrawler against the mock site", () => {
  beforeAll(async () => {
    process.env.AGENTELSE_PROVIDER_MODE = "mock";
    process.env.SEO_HEALTH = "true";
    process.env.SEO_CRAWL = "true";
    fixture = await createAgencyFixture(`seo-crawl-${runId}`);
    await prisma.project.update({
      where: { id: fixture.projectId },
      data: { domain: HOST, status: "ACTIVE" },
    });
    const verified = await checkSiteVerification(fixture.projectId, {}, T0);
    expect(verified).toEqual({ ok: true, method: "MOCK" });
    const site = await SeoSites.forProject(fixture.projectId);
    if (!site) throw new Error("SeoSite missing");
    siteId = site.id;
  });

  afterAll(async () => {
    setMockSiteOverrides(null);
    if (fixture) {
      await prisma.gscSiteLink.deleteMany({
        where: { projectId: fixture.projectId },
      });
      await prisma.seoSite.deleteMany({
        where: { projectId: fixture.projectId },
      });
      await teardownAgencyFixture(fixture.workspaceId);
    }
    process.env.AGENTELSE_PROVIDER_MODE = savedEnv.mode;
    process.env.SEO_HEALTH = savedEnv.health;
    process.env.SEO_CRAWL = savedEnv.crawl;
  });

  it("verifies the domain as MOCK and arms the crawl on a mock row", async () => {
    const site = await prisma.seoSite.findUniqueOrThrow({
      where: { id: siteId },
    });
    expect(site.isMock).toBe(true);
    expect(site.verifyMethod).toBe("MOCK");
    expect(site.scopeKey).toBe("VERIFIED_DOMAIN:example.com:");
    expect(site.crawlNextAt).not.toBeNull();
  });

  it("finishes a full crawl over several runs without forbidden requests", async () => {
    const runs = await crawlUntilDone(T0);
    expect(runs).toBeGreaterThan(1);
    const done = await prisma.seoCrawl.findFirstOrThrow({
      where: { siteId, kind: "FULL" },
      orderBy: { startedAt: "desc" },
    });
    expect(done.status).toBe("DONE");
    expect(done.pagesFetched).toBeLessThanOrEqual(done.budget);
    const urls = log.map((entry) => new URL(entry.url));
    expect(urls.some((url) => url.pathname.startsWith("/private/"))).toBe(
      false,
    );
    expect(
      urls.some(
        (url) => url.hostname === `www.${HOST}` && url.pathname === "/about",
      ),
    ).toBe(false);
    const site = await prisma.seoSite.findUniqueOrThrow({
      where: { id: siteId },
    });
    expect(site.lastFullCrawlAt).toEqual(T0);
    expect(site.fullCrawlDueAt!.getTime()).toBeGreaterThanOrEqual(
      T0.getTime() + 7 * 24 * HOUR,
    );
    expect(site.crawlNextAt!.getTime()).toBeGreaterThan(T0.getTime());
  });

  it("stores statuses, redirect chains, the link graph and inlinks", async () => {
    expect((await page("/missing"))?.status).toBe(404);
    expect((await page("/noindex-page"))?.noindex).toBe(true);
    const chain = await page("/chain-1");
    const hops = (chain?.redirectChain as { status: number }[] | null) ?? [];
    expect(
      hops.filter((hop) => hop.status >= 300 && hop.status < 400),
    ).toHaveLength(3);
    const home = await page("/");
    expect(home?.outlinks ?? 0).toBeGreaterThan(5);
    expect((await page("/pricing"))?.inlinks ?? 0).toBeGreaterThanOrEqual(1);
    expect(home?.depth).toBe(0);
    expect(await page("/private/secret")).toMatchObject({
      robotsBlocked: true,
    });
  });

  it("writes the technical audit issues", async () => {
    const rows = await prisma.seoPage.findMany({
      where: { siteId },
      select: { issues: true },
    });
    const codes = new Set(
      rows.flatMap((row) =>
        Array.isArray(row.issues)
          ? row.issues.map((issue) => (issue as { code: string }).code)
          : [],
      ),
    );
    for (const code of ["TA7", "TA11", "TA12", "TA16", "TA19", "TA21"]) {
      expect(codes.has(code)).toBe(true);
    }
  });

  it("builds the sitemap inventory with a baseline pass", async () => {
    const post = await page("/blog/post-1");
    expect(post?.inSitemap).toBe(true);
    const site = await prisma.seoSite.findUniqueOrThrow({
      where: { id: siteId },
    });
    expect(site.sitemapBaselineAt).toEqual(T0);
    expect(
      await prisma.seoPage.count({
        where: { siteId, sitemapFirstSeenAt: { not: null } },
      }),
    ).toBe(0);

    // Taban çizgisinden sonra eklenen adres tarih alır.
    const original = await mockSiteTransport()(
      new URL(`${HOME}sitemap-pages.xml`),
      {
        userAgent: "test",
        accept: "*/*",
        maxBytes: 1_000_000,
        timeoutMs: 1_000,
      },
    );
    const xml = original.body
      .toString("utf8")
      .replace("</urlset>", `<url><loc>${HOME}new-page</loc></url></urlset>`);
    setOverrides({
      "/sitemap-pages.xml": {
        html: xml,
        headers: { "content-type": "application/xml; charset=utf-8" },
      },
    });
    const t1 = new Date(T0.getTime() + 25 * HOUR);
    await run(t1, 5_000);
    const added = await page("/new-page");
    expect(added?.inSitemap).toBe(true);
    expect(added?.sitemapFirstSeenAt).toEqual(t1);
  });

  it("gets 304s on the second full crawl", async () => {
    // 23:00Z = 02:00 Istanbul (gece penceresi); tarama vadesi geçmişe çekilir.
    const t2 = new Date("2026-10-07T23:00:00Z");
    await prisma.seoSite.update({
      where: { id: siteId },
      data: { fullCrawlDueAt: new Date(t2.getTime() - HOUR) },
    });
    await crawlUntilDone(t2, 5_000);
    const second = await prisma.seoCrawl.findFirstOrThrow({
      where: { siteId, kind: "FULL" },
      orderBy: { startedAt: "desc" },
    });
    expect(second.startedAt).toEqual(t2);
    expect(second.notModified).toBeGreaterThan(0);
  });

  it("sees a homepage noindex in one watchdog run and queues it only with a GSC link", async () => {
    const t3 = new Date("2026-10-08T06:00:00Z");
    setOverrides({
      "/": {
        html: '<html><head><title>Home</title><meta name="robots" content="noindex"></head><body><a href="/pricing">Pricing</a></body></html>',
      },
    });
    const result = await run(t3, 5_000);
    expect(result.regression).toBe(true);
    expect((await page("/"))?.noindex).toBe(true);
    // Bekçi tam taramanın "getirildi" işaretine dokunmaz.
    const lastFull = await prisma.seoCrawl.findFirstOrThrow({
      where: { siteId, kind: "FULL" },
      orderBy: { startedAt: "desc" },
    });
    expect((await page("/"))?.lastCrawlId).toBe(lastFull.id);
    expect((await page("/"))?.lastCrawledAt).toEqual(t3);
    let site = await prisma.seoSite.findUniqueOrThrow({
      where: { id: siteId },
    });
    expect(parseInspectQueue(site.inspectQueue)).toHaveLength(0);
    expect(site.healthDueAt).not.toBeNull();

    // GSC bağıyla kapsam değişir (sıfırlama); bekçi önce temiz ana sayfayı
    // görür, sonra noindex'i görünce P1 kuyruğuna ekler.
    setOverrides({});
    await prisma.gscSiteLink.create({
      data: {
        workspaceId: fixture!.workspaceId,
        projectId: fixture!.projectId,
        credentialId: `cred-${runId}`,
        siteUrl: HOME,
        isPrimary: true,
        isMock: true,
        health: "OK",
      },
    });
    const t4 = new Date(t3.getTime() + HOUR);
    expect((await run(t4, 5_000)).stopped).toBe("scope_changed");
    await run(t4, 5_000);
    expect((await page("/"))?.noindex).toBe(false);
    setOverrides({
      "/": {
        html: '<html><head><title>Home</title><meta name="robots" content="noindex"></head><body></body></html>',
      },
    });
    await run(new Date(t4.getTime() + 7 * HOUR), 5_000);
    site = await prisma.seoSite.findUniqueOrThrow({ where: { id: siteId } });
    expect(
      parseInspectQueue(site.inspectQueue).map((entry) => entry.urlHash),
    ).toContain(crawlUrlHash(HOME));
    setOverrides({});
  });

  it("counts a robots 5xx only after the retry also fails", async () => {
    const base = new Date("2026-10-09T12:00:00Z");
    await prisma.seoSite.update({
      where: { id: siteId },
      data: {
        robotsFetchedAt: new Date(base.getTime() - 2 * 24 * HOUR),
        robotsRetryAt: null,
      },
    });
    setOverrides({ "/robots.txt": { status: 500, html: "error" } });

    // Yeniden denemeye süre yok: hiçbir şey sayılmaz, 2 dk sonra tekrar.
    const single = await run(base, 1_000);
    expect(single.stopped).toBe("robots");
    let site = await prisma.seoSite.findUniqueOrThrow({
      where: { id: siteId },
    });
    expect(site.robotsFailures).toBe(0);
    expect(site.robotsRetryAt).toEqual(new Date(base.getTime() + 2 * 60_000));

    // Süre var: iki deneme de başarısız → bir hata, gelecekte geri çekilme.
    const later = new Date(base.getTime() + 3 * 60_000);
    await run(later, 60_000);
    site = await prisma.seoSite.findUniqueOrThrow({ where: { id: siteId } });
    expect(site.robotsFailures).toBe(1);
    expect(site.robotsVerdict).toBe("SERVER_ERROR");
    expect(site.robotsRetryAt!.getTime()).toBeGreaterThan(later.getTime());

    // 'Disallow: /' geçerli bir robots.txt'dir (OK).
    setOverrides({
      "/robots.txt": {
        html: "User-agent: *\nDisallow: /\n",
        headers: { "content-type": "text/plain" },
      },
    });
    await run(new Date(site.robotsRetryAt!.getTime() + 60_000), 5_000);
    site = await prisma.seoSite.findUniqueOrThrow({ where: { id: siteId } });
    expect(site.robotsVerdict).toBe("OK");
    expect(site.robotsFailures).toBe(0);
    setOverrides({});
  });

  it("deletes the crawl data and idles the site when the domain is removed", async () => {
    await prisma.gscSiteLink.deleteMany({
      where: { projectId: fixture!.projectId },
    });
    await prisma.project.update({
      where: { id: fixture!.projectId },
      data: { domain: null },
    });
    const result = await run(new Date("2026-10-10T12:00:00Z"));
    expect(result.stopped).toBe("no_scope");
    expect(await prisma.seoPage.count({ where: { siteId } })).toBe(0);
    const site = await prisma.seoSite.findUniqueOrThrow({
      where: { id: siteId },
    });
    expect(site.crawlNextAt).toBeNull();
    expect(site.scopeKey).toBeNull();
  });
});
