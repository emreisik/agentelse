import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { crawlUrlHash } from "@/lib/seo/crawl-url";
import { parseGeoResult } from "@/lib/seo/geo/types";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { describeIntegration } from "@/test-support/integration-suite";

import { loadSeoGeoCounters } from "./counters";
import { SeoGeo } from "./runner";
import {
  forgetGeoAuditForSite,
  readGeoAudit,
  setAcknowledged,
} from "./store";

// GEO/AEO denetimi gerçek Postgres'e karşı (yalnız CI ve yerel tek kullanımlık
// veritabanı; mock modda siteye ve modele hiç gidilmez: ana sayfa ve /llms.txt
// bellek içi mock siteden gelir). Kanıtlanan: SeoSite + SeoPage verisi olan
// site tick'te denetlenir ve satır yazılır; "I decided this" puanı yeni denetim
// olmadan yükseltir ve sonraki denetimde korunur; "Check again" 6 saat arayla;
// kapsam anahtarı değişince satır bayat sayılır; operatör sayaçları yalnız
// sayı verir; satır siteyle (siteId) ve projeyle (projectId kolonu) silinir.

const runId = randomUUID().slice(0, 8);
const HOST = "geo-example.test";
const T0 = new Date("2026-10-07T10:00:00Z");
const HOUR = 3_600_000;
const SCOPE = {
  kind: "VERIFIED_DOMAIN",
  root: HOST,
  prefix: null,
  key: `VERIFIED_DOMAIN:${HOST}:`,
};

let fixture: AgencyFixture | undefined;
let siteId = "";
const savedEnv = {
  mode: process.env.AGENTELSE_PROVIDER_MODE,
  reasoning: process.env.AGENTELSE_REASONING_MODE,
  health: process.env.SEO_HEALTH,
  crawl: process.env.SEO_CRAWL,
  geo: process.env.SEO_GEO,
  dev: process.env.SEO_DEV_PROJECTS,
  rollout: process.env.SEO_ROLLOUT_PROJECTS,
};

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describeIntegration("GEO audit against Postgres (mock site)", () => {
  beforeAll(async () => {
    process.env.AGENTELSE_PROVIDER_MODE = "mock";
    process.env.AGENTELSE_REASONING_MODE = "mock";
    process.env.SEO_HEALTH = "true";
    process.env.SEO_CRAWL = "true";
    process.env.SEO_GEO = "true";
    delete process.env.SEO_DEV_PROJECTS;
    // Yalnız bu testin projesi (paylaşılan veritabanındaki başka siteler yok sayılır).
    fixture = await createAgencyFixture(`geo-${runId}`);
    process.env.SEO_ROLLOUT_PROJECTS = fixture.projectId;

    const site = await prisma.seoSite.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        isMock: true,
        scope: SCOPE,
        scopeKey: SCOPE.key,
        origin: `https://${HOST}`,
        robotsStatus: 200,
        robotsVerdict: "OK",
        robotsBody: "User-agent: PerplexityBot\nDisallow: /\n",
        robotsFetchedAt: T0,
        lastFullCrawlAt: T0,
      },
    });
    siteId = site.id;
    const paths = ["/", "/pricing", "/about", "/blog/a", "/blog/b", "/blog/c"];
    await prisma.seoPage.createMany({
      data: paths.map((path, index) => ({
        siteId,
        workspaceId: fixture!.workspaceId,
        projectId: fixture!.projectId,
        url: `https://${HOST}${path}`,
        urlHash: crawlUrlHash(`https://${HOST}${path}`),
        path,
        discoveredVia: "CRAWL",
        status: 200,
        indexable: true,
        title: path === "/" ? "Geo Example | Things" : `Page ${path}`,
        metaDescription: path === "/" ? "We make things." : null,
        wordCount: 700,
        inlinks: 10 - index,
        schemaTypes: [],
        headings: { h1: ["Title"], h2: index === 0 ? ["Why us?"] : [] },
        firstSeenAt: T0,
      })),
    });
  }, 60_000);

  afterAll(async () => {
    restore("AGENTELSE_PROVIDER_MODE", savedEnv.mode);
    restore("AGENTELSE_REASONING_MODE", savedEnv.reasoning);
    restore("SEO_HEALTH", savedEnv.health);
    restore("SEO_CRAWL", savedEnv.crawl);
    restore("SEO_GEO", savedEnv.geo);
    restore("SEO_DEV_PROJECTS", savedEnv.dev);
    restore("SEO_ROLLOUT_PROJECTS", savedEnv.rollout);
    const projectId = fixture?.projectId;
    if (projectId) {
      await prisma.seoGeoAudit.deleteMany({ where: { projectId } });
      await prisma.seoPage.deleteMany({ where: { projectId } });
      await prisma.seoSite.deleteMany({ where: { projectId } });
    }
    await teardownAgencyFixture(fixture?.workspaceId);
  });

  it("audits a crawled site and saves the row", async () => {
    // Tick adımı: genel tarama kilidi başka bir koşudan kalmış olabilir.
    await prisma.systemHeartbeat.deleteMany({ where: { key: "seo.geo-scan" } });
    expect(await SeoGeo.runDue(5, T0)).toBe(1);

    const row = await readGeoAudit(fixture!.projectId);
    expect(row).not.toBeNull();
    expect(row).toMatchObject({
      siteId,
      projectId: fixture!.projectId,
      workspaceId: fixture!.workspaceId,
      isMock: true,
      scopeKey: SCOPE.key,
      acknowledged: [],
      leaseUntil: null,
    });
    const result = parseGeoResult(row!.result)!;
    expect(result.v).toBe(1);
    expect(result.llms.state).toBe("missing");
    expect(result.checks.find((check) => check.id === "GEO2")?.status).toBe("WARN");
    expect(result.pages.audited).toBe(6);
    expect(row!.score).toBe(result.score);
    expect(row!.nextAuditAt!.getTime()).toBeGreaterThan(T0.getTime() + 7 * 24 * HOUR - 1);
    // Mock kipte öneri sabit metindir.
    expect((row!.recommendations as { source: string }).source).toBe("template");
  }, 60_000);

  it("does not audit the site again before its week is up", async () => {
    expect(await SeoGeo.runDue(5, new Date(T0.getTime() + HOUR))).toBe(0);
  });

  it("lets the owner decide on GEO2, which lifts the score without a new audit", async () => {
    const before = await readGeoAudit(fixture!.projectId);
    const outcome = await setAcknowledged(fixture!.projectId, "GEO2", true);
    expect(outcome.ok).toBe(true);
    const after = await readGeoAudit(fixture!.projectId);
    expect(after!.acknowledged).toEqual(["GEO2"]);
    const result = parseGeoResult(after!.result)!;
    expect(result.checks.find((check) => check.id === "GEO2")?.status).toBe("ACK");
    expect(after!.score!).toBeGreaterThan(before!.score!);
    expect(after!.auditedAt.getTime()).toBe(before!.auditedAt.getTime());
    // GEO3 kabul edilemez.
    expect(await setAcknowledged(fixture!.projectId, "GEO3" as never, true)).toEqual({ ok: false });
  });

  it("refuses Check again within 6 hours and keeps the decision on the next audit", async () => {
    const tooSoon = await SeoGeo.auditNow({
      projectId: fixture!.projectId,
      userId: "user-1",
      now: new Date(T0.getTime() + 2 * HOUR),
    });
    expect(tooSoon).toEqual({ ok: false, message: "You can check again in a few hours." });

    const later = new Date(T0.getTime() + 7 * HOUR);
    expect(
      await SeoGeo.auditNow({ projectId: fixture!.projectId, userId: "user-1", now: later }),
    ).toEqual({ ok: true });
    const row = await readGeoAudit(fixture!.projectId);
    expect(row!.acknowledged).toEqual(["GEO2"]);
    expect(row!.auditedAt.getTime()).toBe(later.getTime());
    expect(row!.previousScore).not.toBeNull();
    expect(
      parseGeoResult(row!.result)!.checks.find((check) => check.id === "GEO2")?.status,
    ).toBe("ACK");
  }, 60_000);

  it("counts the audit in the operator counters without any customer data", async () => {
    const counters = await loadSeoGeoCounters(new Date(T0.getTime() + 8 * HOUR));
    expect(counters).not.toBeNull();
    expect(counters!.sites).toBeGreaterThanOrEqual(1);
    expect(counters!.audited30d).toBeGreaterThanOrEqual(1);
    expect(counters!.llmsPresent).toBeLessThan(counters!.sites);
    const json = JSON.stringify(counters);
    expect(json).not.toContain(HOST);
    expect(json).not.toContain(fixture!.projectId);
  });

  it("treats the row as stale when the site scope changes", async () => {
    await prisma.seoSite.update({ where: { id: siteId }, data: { scopeKey: "VERIFIED_DOMAIN:other.test:" } });
    expect(await readGeoAudit(fixture!.projectId)).toBeNull();
    await prisma.seoSite.update({ where: { id: siteId }, data: { scopeKey: SCOPE.key } });
    expect(await readGeoAudit(fixture!.projectId)).not.toBeNull();
  });

  it("removes the row with the site and with the project column", async () => {
    await forgetGeoAuditForSite(siteId);
    expect(await prisma.seoGeoAudit.count({ where: { siteId } })).toBe(0);

    // Proje silme yolu: projectId kolonu olan satırlar projeyle gider.
    expect(
      await SeoGeo.auditNow({
        projectId: fixture!.projectId,
        userId: "user-1",
        now: new Date(T0.getTime() + 20 * HOUR),
      }),
    ).toEqual({ ok: true });
    expect(await prisma.seoGeoAudit.count({ where: { projectId: fixture!.projectId } })).toBe(1);
    await prisma.seoGeoAudit.deleteMany({ where: { projectId: fixture!.projectId } });
    expect(await prisma.seoGeoAudit.count({ where: { projectId: fixture!.projectId } })).toBe(0);
  }, 60_000);
});
