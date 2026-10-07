import { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { evaluateGeo, type GeoInput } from "@/lib/seo/geo/evaluate";

// Bu dosyanın kanıtladığı (SC-F8 GEO koşucusu): bayrak kapalıyken hiçbir
// sorgu yok (SEO_GEO tek başına yetmez, SEO_CRAWL de gerekir); geliştirme
// süreci izinsiz hiçbir şeye dokunmaz ve genel kilit almaz; izinli projeler
// WHERE'de; kilit CAS ile alınır (sayı 0 = atla) ve satırsız site kilitli
// satırla oluşturulur (P2002 = atla); ilk denetim yalnız sayfa verisi olan
// sitelere sorulur ve tarama verisi yoksa sonuç yazılmaz; hata yalnız adıyla
// loglanır; "Check again" 6 saat aralık ve bayrak/kilit/tarama mesajları.

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  updateMany: vi.fn(),
  create: vi.fn(),
  findUnique: vi.fn(),
  siteFindUnique: vi.fn(),
  brandFindFirst: vi.fn(),
  queryRaw: vi.fn(),
  claimPeriodic: vi.fn(),
  collect: vi.fn(),
  save: vi.fn(),
  write: vi.fn(),
  template: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    seoGeoAudit: {
      findMany: mocks.findMany,
      updateMany: mocks.updateMany,
      create: mocks.create,
      findUnique: mocks.findUnique,
    },
    seoSite: { findUnique: mocks.siteFindUnique },
    brand: { findFirst: mocks.brandFindFirst },
    $queryRaw: mocks.queryRaw,
  },
}));
vi.mock("@/server/observability/periodic", () => ({
  claimPeriodic: mocks.claimPeriodic,
}));
vi.mock("./collect", () => ({ collectGeoInput: mocks.collect }));
vi.mock("./recommend", () => ({
  writeGeoRecommendations: mocks.write,
  templateRecommendations: mocks.template,
}));
vi.mock("./store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./store")>()),
  saveGeoAudit: mocks.save,
}));

import { SeoGeo } from "./runner";

const NOW = new Date("2026-10-07T10:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function input(overrides: Partial<GeoInput> = {}): GeoInput {
  return {
    robots: null,
    robotsVerdict: "MISSING",
    llms: { state: "missing", text: null },
    home: null,
    pages: [],
    brandName: "Acme",
    connectedHandles: [],
    acknowledged: [],
    now: NOW,
    ...overrides,
  };
}

const COLLECTED = {
  ok: true as const,
  siteId: "site-1",
  scopeKey: "VERIFIED_DOMAIN:acme.test:",
  isMock: true,
  input: input(),
};

function auditRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "a1",
    siteId: "site-1",
    projectId: "p1",
    workspaceId: "w1",
    isMock: true,
    nextAuditAt: new Date(NOW.getTime() - HOUR),
    acknowledged: ["GEO2", "GEO3"],
    leaseUntil: null,
    auditedAt: new Date(NOW.getTime() - 8 * DAY),
    result: evaluateGeo(input()),
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubEnv("AGENTELSE_PROVIDER_MODE", "mock");
  vi.stubEnv("SEO_HEALTH", "true");
  vi.stubEnv("SEO_CRAWL", "true");
  vi.stubEnv("SEO_GEO", "true");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("SEO_DEV_PROJECTS", "");
  vi.stubEnv("SEO_ROLLOUT_PROJECTS", "");
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.findMany.mockResolvedValue([]);
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.create.mockResolvedValue({});
  mocks.queryRaw.mockResolvedValue([]);
  mocks.claimPeriodic.mockResolvedValue(true);
  mocks.collect.mockResolvedValue(COLLECTED);
  mocks.brandFindFirst.mockResolvedValue({ id: "b1" });
  mocks.write.mockResolvedValue({ source: "ai", language: "en", items: [{ checkId: "GEO1", text: "Add it." }] });
  mocks.template.mockReturnValue({ source: "template", language: null, items: [] });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function nothingTouched() {
  expect(mocks.findMany).not.toHaveBeenCalled();
  expect(mocks.queryRaw).not.toHaveBeenCalled();
  expect(mocks.updateMany).not.toHaveBeenCalled();
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.claimPeriodic).not.toHaveBeenCalled();
  expect(mocks.collect).not.toHaveBeenCalled();
}

describe("SeoGeo.runDue gates", () => {
  it("returns 0 before any DB call when SEO_GEO is off", async () => {
    vi.stubEnv("SEO_GEO", "false");
    expect(await SeoGeo.runDue(2, NOW)).toBe(0);
    nothingTouched();
  });

  it("needs the crawler flag too", async () => {
    vi.stubEnv("SEO_CRAWL", "false");
    expect(await SeoGeo.runDue(2, NOW)).toBe(0);
    nothingTouched();
    vi.stubEnv("SEO_CRAWL", "true");
    vi.stubEnv("SEO_HEALTH", "false");
    expect(await SeoGeo.runDue(2, NOW)).toBe(0);
    nothingTouched();
  });

  it("claims nothing in a dev process without allow-listed projects", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "postgresql://user:pw@db.example.com/live");
    expect(await SeoGeo.runDue(2, NOW)).toBe(0);
    nothingTouched();
  });

  it("only handles allow-listed projects in a dev process and takes no global lock", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "postgresql://user:pw@db.example.com/live");
    vi.stubEnv("SEO_DEV_PROJECTS", "p1");
    mocks.findMany.mockResolvedValue([auditRow()]);
    expect(await SeoGeo.runDue(2, NOW)).toBe(1);
    expect(mocks.claimPeriodic).not.toHaveBeenCalled();
    expect(mocks.findMany.mock.calls[0]![0].where.projectId).toEqual({ in: ["p1"] });
    const sql = mocks.queryRaw.mock.calls;
    // Yeni site sorgusu da izin listesini taşır (kalan kontenjan yok: 1 < 2).
    expect(sql).toHaveLength(1);
    expect(JSON.stringify(sql[0]!.slice(1))).toContain("p1");
  });

  it("throttles the global scan with claimPeriodic", async () => {
    mocks.claimPeriodic.mockResolvedValue(false);
    expect(await SeoGeo.runDue(2, NOW)).toBe(0);
    expect(mocks.claimPeriodic).toHaveBeenCalledWith("seo.geo-scan", expect.any(Number), NOW);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("puts mode, due date, lease and rollout list in the WHERE", async () => {
    vi.stubEnv("SEO_ROLLOUT_PROJECTS", "p1,p2");
    await SeoGeo.runDue(2, NOW);
    const where = mocks.findMany.mock.calls[0]![0].where;
    expect(where.isMock).toBe(true);
    expect(where.nextAuditAt).toEqual({ not: null, lte: NOW });
    expect(where.OR).toEqual([{ leaseUntil: null }, { leaseUntil: { lte: NOW } }]);
    expect(where.projectId).toEqual({ in: ["p1", "p2"] });
  });
});

describe("SeoGeo.runDue audits", () => {
  it("claims the row with a CAS, evaluates and saves with a weekly schedule", async () => {
    const row = auditRow();
    mocks.findMany.mockResolvedValue([row]);
    expect(await SeoGeo.runDue(2, NOW)).toBe(1);
    const claim = mocks.updateMany.mock.calls[0]![0];
    expect(claim.where).toMatchObject({ id: "a1", nextAuditAt: row.nextAuditAt });
    expect(claim.where.OR).toEqual([{ leaseUntil: null }, { leaseUntil: { lte: NOW } }]);
    expect(claim.data.leaseUntil.getTime()).toBeGreaterThan(NOW.getTime());
    expect(mocks.collect).toHaveBeenCalledWith("p1", { now: NOW });
    const saved = mocks.save.mock.calls[0]![0];
    expect(saved).toMatchObject({
      siteId: "site-1",
      workspaceId: "w1",
      projectId: "p1",
      scopeKey: COLLECTED.scopeKey,
      isMock: true,
      acknowledged: ["GEO2"],
      lastError: null,
    });
    expect(saved.result.v).toBe(1);
    expect(saved.recommendations).toMatchObject({ source: "ai", items: [{ checkId: "GEO1", text: "Add it." }] });
    const delta = saved.nextAuditAt.getTime() - NOW.getTime();
    expect(delta).toBeGreaterThanOrEqual(7 * DAY);
    expect(delta).toBeLessThan(7 * DAY + 6 * HOUR);
  });

  it("skips a row whose lease another process holds (CAS count 0)", async () => {
    mocks.findMany.mockResolvedValue([auditRow()]);
    mocks.updateMany.mockResolvedValue({ count: 0 });
    expect(await SeoGeo.runDue(2, NOW)).toBe(0);
    expect(mocks.collect).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("respects the limit", async () => {
    mocks.findMany.mockResolvedValue([
      auditRow({ id: "a1", siteId: "s1", projectId: "p1" }),
      auditRow({ id: "a2", siteId: "s2", projectId: "p2" }),
      auditRow({ id: "a3", siteId: "s3", projectId: "p3" }),
    ]);
    mocks.collect.mockImplementation(async (projectId: string) => ({
      ...COLLECTED,
      siteId: `s${projectId.slice(1)}`,
    }));
    expect(await SeoGeo.runDue(2, NOW)).toBe(2);
    expect(mocks.save).toHaveBeenCalledTimes(2);
    // Limit doldu: yeni site sorgusu yapılmaz.
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });

  it("uses template text without a default brand", async () => {
    mocks.findMany.mockResolvedValue([auditRow()]);
    mocks.brandFindFirst.mockResolvedValue(null);
    mocks.template.mockReturnValue({
      source: "template",
      language: null,
      items: [{ checkId: "GEO1", text: "Fixed." }],
    });
    await SeoGeo.runDue(2, NOW);
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.save.mock.calls[0]![0].recommendations).toMatchObject({ source: "template" });
  });

  it("records fetch_failed when neither live read worked but still saves", async () => {
    mocks.findMany.mockResolvedValue([auditRow()]);
    mocks.collect.mockResolvedValue({
      ...COLLECTED,
      input: input({ llms: { state: "unknown", text: null }, home: null }),
    });
    await SeoGeo.runDue(2, NOW);
    expect(mocks.save.mock.calls[0]![0].lastError).toBe("fetch_failed");
  });

  it("logs only the error name and releases the lease with a retry", async () => {
    mocks.findMany.mockResolvedValue([auditRow()]);
    mocks.collect.mockRejectedValue(new TypeError("secret page text"));
    expect(await SeoGeo.runDue(2, NOW)).toBe(1);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("secret");
    const release = mocks.updateMany.mock.calls.at(-1)![0];
    expect(release.data).toMatchObject({ leaseUntil: null, leaseOwner: null, lastError: "unknown" });
    expect(release.data.nextAuditAt.getTime()).toBeGreaterThan(NOW.getTime());
    expect(mocks.save).not.toHaveBeenCalled();
  });
});

describe("SeoGeo.runDue first audits", () => {
  const SITE = { id: "site-1", projectId: "p1", workspaceId: "w1" };

  it("asks only for crawled sites with page data and no audit yet", async () => {
    await SeoGeo.runDue(2, NOW);
    const strings = (mocks.queryRaw.mock.calls[0]![0] as readonly string[]).join(" ");
    expect(strings).toContain('"SeoPage"');
    expect(strings).toMatch(/EXISTS\s*\(\s*SELECT 1 FROM "SeoPage"/);
    expect(strings).toMatch(/NOT EXISTS\s*\(\s*SELECT 1 FROM "SeoGeoAudit"/);
    expect(strings).toContain('"lastFullCrawlAt" IS NOT NULL');
  });

  it("creates the locked row for a new site and audits it", async () => {
    mocks.queryRaw.mockResolvedValue([SITE]);
    expect(await SeoGeo.runDue(2, NOW)).toBe(1);
    const created = mocks.create.mock.calls[0]![0].data;
    expect(created).toMatchObject({ siteId: "site-1", projectId: "p1", workspaceId: "w1", isMock: true, result: { v: 0 }, leaseOwner: expect.any(String) });
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.save.mock.calls[0]![0].acknowledged).toEqual([]);
  });

  it("skips a site another process already created (unique violation)", async () => {
    mocks.queryRaw.mockResolvedValue([SITE]);
    mocks.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "x" }),
    );
    expect(await SeoGeo.runDue(2, NOW)).toBe(0);
    expect(mocks.collect).not.toHaveBeenCalled();
  });

  it("writes no result when the crawl data is not there yet", async () => {
    mocks.queryRaw.mockResolvedValue([SITE]);
    mocks.collect.mockResolvedValue({ ok: false, reason: "no_crawl" });
    await SeoGeo.runDue(2, NOW);
    expect(mocks.save).not.toHaveBeenCalled();
    const release = mocks.updateMany.mock.calls.at(-1)![0];
    expect(release.data).toMatchObject({ leaseUntil: null, lastError: "crawl_missing" });
  });
});

describe("SeoGeo.auditNow", () => {
  const SITE = { id: "site-1", workspaceId: "w1", scopeKey: "K", origin: "https://acme.test" };

  beforeEach(() => {
    mocks.siteFindUnique.mockResolvedValue(SITE);
    mocks.findUnique.mockResolvedValue(auditRow({ auditedAt: new Date(NOW.getTime() - 7 * HOUR) }));
  });

  it("refuses without a flag and without touching the DB", async () => {
    vi.stubEnv("SEO_GEO", "false");
    const outcome = await SeoGeo.auditNow({ projectId: "p1", userId: "u1", now: NOW });
    expect(outcome).toMatchObject({ ok: false });
    expect(mocks.siteFindUnique).not.toHaveBeenCalled();
  });

  it("refuses a project that is not allow-listed", async () => {
    vi.stubEnv("SEO_ROLLOUT_PROJECTS", "someone-else");
    expect(await SeoGeo.auditNow({ projectId: "p1", userId: "u1", now: NOW })).toMatchObject({ ok: false });
    expect(mocks.siteFindUnique).not.toHaveBeenCalled();
  });

  it("asks for a verified site first", async () => {
    mocks.siteFindUnique.mockResolvedValue({ ...SITE, scopeKey: null });
    expect(await SeoGeo.auditNow({ projectId: "p1", userId: "u1", now: NOW })).toEqual({
      ok: false,
      message: "Verify your site on the Search page first.",
    });
    mocks.siteFindUnique.mockResolvedValue(null);
    expect(await SeoGeo.auditNow({ projectId: "p1", userId: "u1", now: NOW })).toMatchObject({ ok: false });
  });

  it("refuses within 6 hours of the last check and allows after", async () => {
    mocks.findUnique.mockResolvedValue(auditRow({ auditedAt: new Date(NOW.getTime() - 5 * HOUR) }));
    expect(await SeoGeo.auditNow({ projectId: "p1", userId: "u1", now: NOW })).toEqual({
      ok: false,
      message: "You can check again in a few hours.",
    });
    expect(mocks.collect).not.toHaveBeenCalled();
    mocks.findUnique.mockResolvedValue(auditRow({ auditedAt: new Date(NOW.getTime() - 6 * HOUR) }));
    expect(await SeoGeo.auditNow({ projectId: "p1", userId: "u1", now: NOW })).toEqual({ ok: true });
    expect(mocks.save).toHaveBeenCalledTimes(1);
  });

  it("ignores the gap for a placeholder row without a result", async () => {
    mocks.findUnique.mockResolvedValue(auditRow({ auditedAt: NOW, result: { v: 0 } }));
    expect(await SeoGeo.auditNow({ projectId: "p1", userId: "u1", now: NOW })).toEqual({ ok: true });
  });

  it("creates the row for a site without any audit", async () => {
    mocks.findUnique.mockResolvedValue(null);
    expect(await SeoGeo.auditNow({ projectId: "p1", userId: "u1", now: NOW })).toEqual({ ok: true });
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it("says so when the lock is held and when the crawl is missing", async () => {
    mocks.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await SeoGeo.auditNow({ projectId: "p1", userId: "u1", now: NOW })).toEqual({
      ok: false,
      message: "A check is already running. Try again in a minute.",
    });
    mocks.collect.mockResolvedValue({ ok: false, reason: "no_crawl" });
    expect(await SeoGeo.auditNow({ projectId: "p1", userId: "u1", now: NOW })).toEqual({
      ok: false,
      message: "Run the site audit first, then check again.",
    });
  });
});
