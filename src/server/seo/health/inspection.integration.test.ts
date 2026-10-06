import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import type { GscSiteLink, SeoSite } from "@prisma/client";

import {
  crawlUrlHash,
  normalizeCrawlUrl,
  scopeFromGscSite,
} from "@/lib/seo/crawl-url";
import { nextPacificMidnight } from "@/lib/seo/governor";
import type { ParsedInspection } from "@/lib/seo/inspection";
import { prisma } from "@/lib/prisma";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { GoogleApiError } from "@/server/integrations/google/errors";
import {
  appendInspectQueue,
  parseInspectQueue,
} from "@/server/seo/site/inspect-queue";
import { describeIntegration } from "@/test-support/integration-suite";

import { GscSitemaps } from "./gsc-sitemaps";
import { reserveInspection, SeoInspection } from "./inspection";
import { SearchUpdates } from "./updates";

// URL Inspection örnekleyicisi gerçek Postgres'e karşı (mock Google; yalnız
// CI ve yerel tek kullanımlık veritabanı): bütçe CAS'ı PT günü içinde tam
// sınırda durur ve PT gece yarısında sıfırlanır; tur ≤ 10 inceler ve ikinci
// turda previous/verdictChangedAt yazar; 60 sn içindeki ikinci tur kilidi
// alamaz; günlük kota 429'u PT gece yarısına kadar duraklatır; P1 kuyruğu
// atomik boşalır (tur sırasında eklenen kalır); ≥ 20 P6 örneğinde haftalık
// kapsam satırı yazılır; GSC sitemaps okuması ekler ve siler; bağ silinince
// inceleme, sitemap ve kapsam satırları cascade'le gider.

describeIntegration("URL Inspection sampler (mock Google)", () => {
  const runId = randomUUID().slice(0, 8);
  const saved = {
    sync: process.env.GSC_SYNC,
    health: process.env.SEO_HEALTH,
    mode: process.env.AGENTELSE_PROVIDER_MODE,
  };
  const BASE = new Date("2026-10-06T18:00:00.000Z");
  const PAGES = 30;
  let fixture: AgencyFixture;
  let link: GscSiteLink;
  let site: SeoSite;

  function pageUrl(index: number): string {
    return `https://www.example.com/page-${runId}-${index}`;
  }

  function result(verdict: ParsedInspection["verdict"]): ParsedInspection {
    return {
      verdict,
      coverageState:
        verdict === "PASS"
          ? "Submitted and indexed"
          : "Crawled - currently not indexed",
      indexingState: "INDEXING_ALLOWED",
      robotsTxtState: "ALLOWED",
      pageFetchState: "SUCCESSFUL",
      googleCanonical: null,
      userCanonical: null,
      lastCrawlTime: null,
      crawledAs: "MOBILE",
      sitemaps: [],
      referringUrls: [],
      richResults: null,
    };
  }

  async function resetSite(now: Date): Promise<void> {
    await prisma.seoSite.update({
      where: { id: site.id },
      data: {
        inspectDay: null,
        inspectCount: 0,
        inspectBudget: 200,
        inspectNextAt: now,
        inspectLastRunAt: null,
        inspectPausedUntil: null,
        inspectQueue: [],
      },
    });
  }

  async function reload(): Promise<SeoSite> {
    return prisma.seoSite.findUniqueOrThrow({ where: { id: site.id } });
  }

  beforeAll(async () => {
    process.env.GSC_SYNC = "true";
    process.env.SEO_HEALTH = "true";
    process.env.AGENTELSE_PROVIDER_MODE = "mock";
    fixture = await createAgencyFixture(`inspect-${runId}`);
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
    link = await prisma.gscSiteLink.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        credentialId: credential.id,
        siteUrl: "sc-domain:example.com",
        isPrimary: true,
        isMock: true,
        health: "OK",
      },
    });
    const scope = scopeFromGscSite(link.siteUrl)!;
    site = await prisma.seoSite.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        isMock: true,
        scope,
        scopeKey: scope.key,
        origin: "https://www.example.com",
        inspectNextAt: BASE,
      },
    });
    await prisma.seoPage.createMany({
      data: Array.from({ length: PAGES }, (_, index) => {
        const url = normalizeCrawlUrl(pageUrl(index))!;
        return {
          siteId: site.id,
          workspaceId: fixture.workspaceId,
          projectId: fixture.projectId,
          url,
          urlHash: crawlUrlHash(url),
          path: new URL(url).pathname,
          discoveredVia: "SITEMAP",
          inSitemap: true,
          firstSeenAt: BASE,
        };
      }),
    });
  }, 60_000);

  beforeEach(async () => {
    await prisma.gscUrlInspection.deleteMany({ where: { linkId: link.id } });
    await prisma.gscCoverageWeek.deleteMany({ where: { linkId: link.id } });
    await resetSite(BASE);
  });

  afterAll(async () => {
    process.env.GSC_SYNC = saved.sync;
    process.env.SEO_HEALTH = saved.health;
    process.env.AGENTELSE_PROVIDER_MODE = saved.mode;
    await prisma.searchUpdate.deleteMany({
      where: {
        OR: [
          { externalId: { startsWith: `test-${runId}` } },
          { name: { startsWith: `test-${runId}` } },
        ],
      },
    });
    if (fixture) {
      await prisma.seoSite.deleteMany({
        where: { projectId: fixture.projectId },
      });
      await prisma.gscSiteLink.deleteMany({
        where: { projectId: fixture.projectId },
      });
      await prisma.integrationCredential.deleteMany({
        where: { workspaceId: fixture.workspaceId },
      });
    }
    await teardownAgencyFixture(fixture?.workspaceId);
  });

  it("stops the budget exactly at inspectBudget and resets after PT midnight", async () => {
    await prisma.seoSite.update({
      where: { id: site.id },
      data: { inspectBudget: 3 },
    });
    const lastMinute = new Date("2026-10-07T06:59:00.000Z");
    const nextDay = new Date("2026-10-07T07:01:00.000Z");
    const taken: boolean[] = [];
    for (let i = 0; i < 5; i += 1) {
      taken.push(await reserveInspection(site.id, lastMinute));
    }
    expect(taken).toEqual([true, true, true, false, false]);
    expect(await reserveInspection(site.id, nextDay)).toBe(true);
    const row = await reload();
    expect(row.inspectDay).toBe("2026-10-07");
    expect(row.inspectCount).toBe(1);
  });

  it("inspects at most 10 per run and records verdict changes on a later run", async () => {
    const first = await SeoInspection.runSite(site.id, {
      now: BASE,
      inspect: async () => result("PASS"),
    });
    expect(first.inspected).toBe(10);
    expect(
      await prisma.gscUrlInspection.count({ where: { linkId: link.id } }),
    ).toBe(10);
    const target = await prisma.gscUrlInspection.findFirstOrThrow({
      where: { linkId: link.id },
    });
    expect(target.sampleWeek).toBe("2026-10-05");
    expect(target.previous).toBeNull();

    const later = new Date(BASE.getTime() + 61_000);
    await appendInspectQueue(
      site.id,
      { url: target.url, urlHash: target.urlHash, by: "user" },
      later,
    );
    const second = await SeoInspection.runSite(site.id, {
      now: later,
      perRun: 1,
      inspect: async () => result("NEUTRAL"),
    });
    expect(second.inspected).toBe(1);
    const changed = await prisma.gscUrlInspection.findUniqueOrThrow({
      where: { id: target.id },
    });
    expect(changed).toMatchObject({
      verdict: "NEUTRAL",
      inspectCount: 2,
      reason: "P1",
      sampleWeek: "2026-10-05",
    });
    expect(changed.verdictChangedAt).toEqual(later);
    expect(changed.previous).toMatchObject({ verdict: "PASS" });
    expect((await reload()).healthDueAt).not.toBeNull();

    // Aynı kararla yeniden inceleme değişiklik öncesi hâli korur (SH7 açık kalır).
    const third = new Date(later.getTime() + 61_000);
    await appendInspectQueue(
      site.id,
      { url: target.url, urlHash: target.urlHash, by: "user" },
      third,
    );
    await SeoInspection.runSite(site.id, {
      now: third,
      perRun: 1,
      inspect: async () => result("NEUTRAL"),
    });
    const unchanged = await prisma.gscUrlInspection.findUniqueOrThrow({
      where: { id: target.id },
    });
    expect(unchanged.inspectCount).toBe(3);
    expect(unchanged.verdictChangedAt).toEqual(later);
    expect(unchanged.previous).toMatchObject({ verdict: "PASS" });
  });

  it("does not claim a second run within 60 seconds", async () => {
    const inspect = vi.fn(async () => result("PASS"));
    await SeoInspection.runSite(site.id, { now: BASE, inspect, perRun: 1 });
    await prisma.seoSite.update({
      where: { id: site.id },
      data: { inspectNextAt: BASE },
    });
    inspect.mockClear();
    const again = await SeoInspection.runSite(site.id, {
      now: new Date(BASE.getTime() + 30_000),
      inspect,
    });
    expect(again).toEqual({ inspected: 0, stopped: null });
    expect(inspect).not.toHaveBeenCalled();
    expect((await reload()).inspectLastRunAt).toEqual(BASE);
  });

  it("pauses until the next Pacific midnight on a daily quota 429", async () => {
    const outcome = await SeoInspection.runSite(site.id, {
      now: BASE,
      inspect: async () => {
        throw new GoogleApiError(
          "Quota exceeded for quota metric 'Inspection requests' and limit 'Inspection requests per day per site'.",
          "RESOURCE_EXHAUSTED",
          { httpStatus: 429 },
        );
      },
    });
    expect(outcome).toEqual({ inspected: 0, stopped: "quota" });
    const row = await reload();
    expect(row.inspectPausedUntil).toEqual(nextPacificMidnight(BASE));
    expect(row.inspectNextAt).toEqual(nextPacificMidnight(BASE));
  });

  it("drains the P1 queue atomically", async () => {
    for (const index of [0, 1, 2]) {
      const url = normalizeCrawlUrl(pageUrl(index))!;
      await appendInspectQueue(
        site.id,
        { url, urlHash: crawlUrlHash(url), by: "user" },
        BASE,
      );
    }
    const lateUrl = normalizeCrawlUrl(pageUrl(29))!;
    let appended = false;
    const outcome = await SeoInspection.runSite(site.id, {
      now: BASE,
      perRun: 3,
      inspect: async () => {
        // Tur sürerken bekçi yeni bir adres ekler: kaybolmamalı.
        if (!appended) {
          appended = true;
          await appendInspectQueue(
            site.id,
            { url: lateUrl, urlHash: crawlUrlHash(lateUrl), by: "watchdog" },
            BASE,
          );
        }
        return result("PASS");
      },
    });
    expect(outcome.inspected).toBe(3);
    const queue = parseInspectQueue((await reload()).inspectQueue);
    expect(queue.map((entry) => entry.url)).toEqual([lateUrl]);
    const reasons = await prisma.gscUrlInspection.findMany({
      where: { linkId: link.id },
      select: { reason: true },
    });
    expect(reasons.every((row) => row.reason === "P1")).toBe(true);
  });

  it("writes the coverage week once at least 20 P6 samples exist", async () => {
    // İlk tur 10 örnek: kapsam için yetersiz.
    await SeoInspection.runSite(site.id, {
      now: BASE,
      inspect: async () => result("PASS"),
    });
    expect(
      await prisma.gscCoverageWeek.count({ where: { linkId: link.id } }),
    ).toBe(0);
    // İkinci tur (60 sn sonra) 20'ye tamamlar: haftalık satır yazılır.
    await SeoInspection.runSite(site.id, {
      now: new Date(BASE.getTime() + 61_000),
      inspect: async (_token, _siteUrl, url) =>
        result(url.endsWith("-0") ? "NEUTRAL" : "PASS"),
    });
    const sampled = await prisma.gscUrlInspection.count({
      where: { linkId: link.id, sampleWeek: "2026-10-05" },
    });
    expect(sampled).toBe(20);
    const week = await prisma.gscCoverageWeek.findFirstOrThrow({
      where: { linkId: link.id },
    });
    expect(week.weekStart.toISOString().slice(0, 10)).toBe("2026-10-05");
    expect(week.sampled).toBe(20);
    expect(week.population).toBe(PAGES);
    expect(week.low).toBeLessThanOrEqual(week.point);
    expect(week.high).toBeGreaterThanOrEqual(week.point);
  });

  it("queues user requests only inside the Search Console property", async () => {
    await expect(
      SeoInspection.requestInspection({
        projectId: fixture.projectId,
        url: "https://other.example.org/x",
        by: "user",
        now: BASE,
      }),
    ).resolves.toBe("out_of_scope");
    await expect(
      SeoInspection.requestInspection({
        projectId: fixture.projectId,
        url: "https://www.example.com/pricing?utm_source=x",
        by: "user",
        now: BASE,
      }),
    ).resolves.toBe("queued");
    const queue = parseInspectQueue((await reload()).inspectQueue);
    expect(queue.map((entry) => entry.url)).toEqual([
      "https://www.example.com/pricing",
    ]);
  });

  it("syncs Search Console sitemaps with upserts and deletes", async () => {
    await prisma.gscSitemap.create({
      data: {
        linkId: link.id,
        projectId: fixture.projectId,
        path: "https://www.example.com/old-sitemap.xml",
        checkedAt: BASE,
      },
    });
    await expect(GscSitemaps.syncLink(link.id, BASE)).resolves.toBe(1);
    const rows = await prisma.gscSitemap.findMany({
      where: { linkId: link.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ submittedCount: 42, errors: 0 });
    expect(rows[0]!.path).toMatch(/\/sitemap\.xml$/);
    const row = await reload();
    expect(row.gscSitemapsAt).toEqual(BASE);
    expect(row.gscSitemapsNextAt).toEqual(
      new Date(BASE.getTime() + 24 * 3_600_000),
    );
  });

  it("removes only hand-added Google updates", async () => {
    await prisma.searchUpdate.create({
      data: {
        externalId: `test-${runId}-feed`,
        name: `test-${runId} feed`,
        kind: "CORE",
        source: "STATUS_DASHBOARD",
        startedAt: BASE,
      },
    });
    const manual = await SearchUpdates.addManual({
      name: `test-${runId} manual`,
      kind: "SPAM",
      startedAt: BASE,
      endedAt: null,
      url: null,
      userId: "operator",
    });
    const feed = await prisma.searchUpdate.findUniqueOrThrow({
      where: { externalId: `test-${runId}-feed` },
    });
    await expect(SearchUpdates.removeManual(feed.id)).resolves.toBe(false);
    await expect(SearchUpdates.removeManual(manual.id)).resolves.toBe(true);
    const recent = await SearchUpdates.recent(BASE, 30);
    expect(recent.some((row) => row.id === feed.id)).toBe(true);
    expect(recent.some((row) => row.id === manual.id)).toBe(false);
  });

  it("cascades inspections, sitemaps and coverage when the link is deleted", async () => {
    let now = BASE;
    for (let round = 0; round < 3; round += 1) {
      await SeoInspection.runSite(site.id, {
        now,
        inspect: async () => result("PASS"),
      });
      now = new Date(now.getTime() + 61_000);
    }
    await GscSitemaps.syncLink(link.id, BASE);
    expect(
      await prisma.gscUrlInspection.count({ where: { linkId: link.id } }),
    ).toBeGreaterThan(0);
    expect(await prisma.gscSitemap.count({ where: { linkId: link.id } })).toBe(
      1,
    );
    expect(
      await prisma.gscCoverageWeek.count({ where: { linkId: link.id } }),
    ).toBe(1);

    await prisma.gscSiteLink.delete({ where: { id: link.id } });
    const where = { projectId: fixture.projectId };
    expect(await prisma.gscUrlInspection.count({ where })).toBe(0);
    expect(await prisma.gscSitemap.count({ where })).toBe(0);
    expect(await prisma.gscCoverageWeek.count({ where })).toBe(0);
  });
});
