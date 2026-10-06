import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { brandTermsHash } from "@/lib/seo/brand-terms";
import { addDays, dayKeyToDate, dayRange } from "@/lib/seo/dates";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { describeIntegration } from "@/test-support/integration-suite";

import {
  readActions,
  readContentPlan,
  readFinalWindow,
  readRankedDeltas,
  reportContextFor,
} from "./inputs";

// SEO rapor okuyucuları gerçek Postgres'e karşı (yalnız CI ve yerel tek
// kullanımlık veritabanı; mock kipte Google'a hiç gidilmez): ambar doğrudan
// tohumlanır. Sıralı delta sorgusu yalnız önceki dönemde görünen satırı sıfır
// güncel değerle getirir, en büyük tıklamaya göre sıralar ve markasız süzgeci
// uygular; son pencere taze günle "tam" sayılmaz ve toplamlar tohumla aynıdır;
// içerik planı yalnız ayın dışlanmamış, reddedilmemiş SEO makalelerini getirir;
// bir ay önce karar verilmiş ama bu hafta değerlendirilmiş bulgu sayılır.

const FINAL = "2026-10-01";
const PREVIOUS_WEEK = "2026-09-14";
const CURRENT_WEEK = "2026-09-21";

describeIntegration("SEO report readers", () => {
  const runId = randomUUID().slice(0, 8);
  const saved = {
    sync: process.env.GSC_SYNC,
    mode: process.env.AGENTELSE_PROVIDER_MODE,
    insights: process.env.SEO_INSIGHTS,
  };
  let fixture: AgencyFixture;
  let linkId: string;

  beforeAll(async () => {
    process.env.GSC_SYNC = "true";
    process.env.AGENTELSE_PROVIDER_MODE = "mock";
    process.env.SEO_INSIGHTS = "on";
    fixture = await createAgencyFixture(`seo-inputs-${runId}`);
    const brandHash = brandTermsHash(["acme"]);
    const link = await prisma.gscSiteLink.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        credentialId: `cred-${runId}`,
        siteUrl: "sc-domain:acme-test.com",
        isMock: true,
        health: "OK",
        lastFinalDate: FINAL,
        backfillDoneAt: new Date(),
        brandTerms: {
          v: 1,
          auto: [],
          user: ["acme"],
          removed: [],
          updatedAt: null,
        },
        brandSeriesHash: brandHash,
        brandClassifiedHash: brandHash,
      },
    });
    linkId = link.id;
    const base = { linkId, projectId: fixture.projectId };
    const fetchedAt = new Date();

    // 20 kesinleşmiş gün (günde 100 tık, 30'u marka) ve FINAL'dan sonra taze gün.
    await prisma.gscDailyTotal.createMany({
      data: [
        ...dayRange(addDays(FINAL, -19), FINAL).map((day) => ({
          ...base,
          date: dayKeyToDate(day),
          searchType: "web",
          clicks: 100,
          impressions: 1000,
          positionWeighted: 5000,
          brandClicks: 30,
          brandImpressions: 200,
          brandPositionWeighted: 400,
          fresh: false,
          fetchedAt,
        })),
        {
          ...base,
          date: dayKeyToDate(addDays(FINAL, 1)),
          searchType: "web",
          clicks: 50,
          impressions: 600,
          positionWeighted: 3000,
          fresh: true,
          fetchedAt,
        },
      ],
    });

    const firstSeen = dayKeyToDate("2026-06-01");
    const dictionary = [
      { text: "running shoes", isBrand: false },
      { text: "old gone query", isBrand: false },
      { text: "acme pricing", isBrand: true },
    ];
    const queries = await Promise.all(
      dictionary.map((query, index) =>
        prisma.gscQuery.create({
          data: {
            ...base,
            text: query.text,
            textHash: `q${index}-${runId}`,
            isBrand: query.isBrand,
            firstSeenWeek: firstSeen,
            lastSeenWeek: dayKeyToDate(CURRENT_WEEK),
          },
        }),
      ),
    );
    const weekly = (
      queryIndex: number,
      week: string,
      clicks: number,
      impressions: number,
    ) => ({
      ...base,
      weekStart: dayKeyToDate(week),
      queryId: queries[queryIndex]!.id,
      clicks,
      impressions,
      positionWeighted: impressions * 5,
    });
    await prisma.gscWeeklyQuery.createMany({
      data: [
        weekly(0, CURRENT_WEEK, 30, 600),
        weekly(0, PREVIOUS_WEEK, 5, 400),
        // Yalnız önceki dönemde görünen sorgu.
        weekly(1, PREVIOUS_WEEK, 50, 900),
        weekly(2, CURRENT_WEEK, 100, 300),
        weekly(2, PREVIOUS_WEEK, 90, 280),
      ],
    });

    // İçerik planı için SEO makaleleri.
    const creative = (
      formatKey: string,
      scheduledFor: string,
      extra: Record<string, unknown> = {},
    ) => ({
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      brandId: fixture.brandId,
      type: "SOCIAL_POST" as const,
      formatKey,
      scheduledFor: new Date(scheduledFor),
      ...extra,
    });
    await prisma.creative.createMany({
      data: [
        creative("seo.article", "2026-10-12T09:00:00Z", {
          title: "Running shoe guide",
          status: "APPROVED",
        }),
        creative("seo.article", "2026-10-20T09:00:00Z", {
          title: "Archived article",
          status: "ARCHIVED",
        }),
        creative("seo.article", "2026-10-21T09:00:00Z", {
          title: "Rejected article",
          status: "REJECTED",
        }),
        creative("seo.article", "2026-10-22T09:00:00Z", {
          title: "Excluded article",
          status: "DRAFT",
          excludedAt: new Date("2026-10-01T00:00:00Z"),
        }),
        creative("instagram.carousel", "2026-10-13T09:00:00Z", {
          title: "Carousel",
          status: "DRAFT",
        }),
        creative("seo.article", "2026-11-03T09:00:00Z", {
          title: "November article",
          status: "DRAFT",
        }),
      ],
    });

    // Bir ay önce kabul edilmiş, bu hafta değerlendirilmiş bulgu ve bu hafta
    // kabul edilmiş bir başkası.
    const finding = (
      key: string,
      data: Record<string, unknown>,
    ): Parameters<typeof prisma.seoFinding.create>[0]["data"] => ({
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      linkId,
      ruleKey: "SO1_STRIKING_DISTANCE",
      ruleVersion: 1,
      kind: "OPPORTUNITY",
      subject: `page:${key}`,
      periodStart: dayKeyToDate(PREVIOUS_WEEK),
      periodEnd: dayKeyToDate(CURRENT_WEEK),
      periodKey: `W:${PREVIOUS_WEEK}`,
      severity: "INFO",
      confidence: "SIGNIFICANT",
      effort: "S",
      actionKind: "TITLE_META",
      title: `Finding ${key}`,
      summary: "Summary",
      evidence: {},
      fingerprint: `fp-${key}-${runId}`,
      lastSeenAt: new Date("2026-10-06T00:00:00Z"),
      ...data,
    });
    await prisma.seoFinding.create({
      data: finding("evaluated", {
        status: "EVALUATED",
        decidedAt: new Date("2026-09-03T10:00:00Z"),
        evaluatedAt: new Date("2026-10-05T10:00:00Z"),
        outcome: "Clicks rose after the change",
      }),
    });
    await prisma.seoFinding.create({
      data: finding("accepted", {
        status: "ACCEPTED",
        decidedAt: new Date("2026-10-06T10:00:00Z"),
      }),
    });
    await prisma.seoFinding.create({
      data: finding("shadow", {
        status: "ACCEPTED",
        shadow: true,
        decidedAt: new Date("2026-10-06T11:00:00Z"),
      }),
    });
  }, 60_000);

  afterAll(async () => {
    process.env.GSC_SYNC = saved.sync;
    process.env.AGENTELSE_PROVIDER_MODE = saved.mode;
    process.env.SEO_INSIGHTS = saved.insights;
    await prisma.gscSiteLink.deleteMany({
      where: { projectId: fixture?.projectId },
    });
    await prisma.creative.deleteMany({
      where: { projectId: fixture?.projectId },
    });
    await teardownAgencyFixture(fixture?.workspaceId);
  });

  it("builds the report context from the link, the default brand and the project language", async () => {
    const ctx = await reportContextFor(fixture.projectId);
    expect(ctx).toMatchObject({
      projectId: fixture.projectId,
      brandId: fixture.brandId,
      finalThrough: FINAL,
      brandSplitReady: true,
      siteLabel: "acme-test.com",
    });
    // Proje dili "en" (şema varsayılanı); boş olsaydı "tr" olurdu.
    expect(ctx?.language).toBe("en");
  });

  it("returns a previous-only query with zero current values, ordered by the greatest clicks", async () => {
    const rows = await readRankedDeltas({
      linkId,
      dimension: "query",
      grain: "WEEK",
      current: { from: CURRENT_WEEK, to: CURRENT_WEEK },
      previous: { from: PREVIOUS_WEEK, to: PREVIOUS_WEEK },
    });
    expect(rows.map((row) => row.label)).toEqual([
      "acme pricing",
      "old gone query",
      "running shoes",
    ]);
    const gone = rows.find((row) => row.label === "old gone query")!;
    expect(gone.current).toEqual({
      clicks: 0,
      impressions: 0,
      positionWeighted: 0,
    });
    expect(gone.previous).toEqual({
      clicks: 50,
      impressions: 900,
      positionWeighted: 4500,
    });
    expect(gone).toMatchObject({ isBrand: false, firstSeen: "2026-06-01" });
    const shoes = rows.find((row) => row.label === "running shoes")!;
    expect(shoes.current.clicks).toBe(30);
    expect(shoes.previous.clicks).toBe(5);
  });

  it("excludes brand queries with nonBrandOnly and honours the limit", async () => {
    const rows = await readRankedDeltas({
      linkId,
      dimension: "query",
      grain: "WEEK",
      current: { from: CURRENT_WEEK, to: CURRENT_WEEK },
      previous: { from: PREVIOUS_WEEK, to: PREVIOUS_WEEK },
      nonBrandOnly: true,
    });
    expect(rows.map((row) => row.label)).toEqual([
      "old gone query",
      "running shoes",
    ]);
    const limited = await readRankedDeltas({
      linkId,
      dimension: "query",
      grain: "WEEK",
      current: { from: CURRENT_WEEK, to: CURRENT_WEEK },
      previous: { from: PREVIOUS_WEEK, to: PREVIOUS_WEEK },
      limit: 1,
    });
    expect(limited).toHaveLength(1);
  });

  it("is not complete with a fresh day, and the split sums equal the seeded final rows", async () => {
    const window = await readFinalWindow(linkId, {
      from: addDays(FINAL, -2),
      to: addDays(FINAL, 1),
    });
    expect(window.complete).toBe(false);
    expect(window.freshDays).toBe(1);
    expect(window.missingDays).toBe(0);
    expect(window.days).toHaveLength(4);
    expect(window.split.total.clicks).toBe(300);
    expect(window.split.brand?.clicks).toBe(90);
    expect(window.split.nonBrand?.clicks).toBe(210);

    const complete = await readFinalWindow(linkId, {
      from: addDays(FINAL, -9),
      to: FINAL,
    });
    expect(complete).toMatchObject({
      complete: true,
      freshDays: 0,
      missingDays: 0,
    });
    expect(complete.split.total.clicks).toBe(1000);

    const missing = await readFinalWindow(linkId, {
      from: addDays(FINAL, -25),
      to: FINAL,
    });
    expect(missing.complete).toBe(false);
    expect(missing.missingDays).toBe(6);
  });

  it("returns only the month's non-excluded, non-rejected seo.article creatives", async () => {
    const items = await readContentPlan(fixture.projectId, "2026-10-01", "UTC");
    expect(items).toEqual([
      { title: "Running shoe guide", date: "2026-10-12", status: "APPROVED" },
    ]);
  });

  it("counts a finding evaluated this week but decided a month ago", async () => {
    const actions = await readActions(fixture.projectId, {
      from: new Date("2026-10-05T00:00:00Z"),
      to: new Date("2026-10-12T00:00:00Z"),
    });
    expect(actions).toMatchObject({ accepted: 1, done: 0, evaluated: 1 });
    expect(actions?.items[0]).toEqual({
      title: "Finding evaluated",
      status: "EVALUATED",
      outcome: "Clicks rose after the change",
    });
    // Gölge bulgu sayılmaz.
    expect(actions?.items.map((item) => item.title)).not.toContain(
      "Finding shadow",
    );
    const quiet = await readActions(fixture.projectId, {
      from: new Date("2026-08-01T00:00:00Z"),
      to: new Date("2026-08-08T00:00:00Z"),
    });
    expect(quiet).toBeNull();
  });
});
