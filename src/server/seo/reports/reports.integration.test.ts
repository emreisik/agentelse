import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { brandTermsHash } from "@/lib/seo/brand-terms";
import { addDays, dayKeyToDate, dayRange } from "@/lib/seo/dates";
import { seoReportCommandId } from "@/lib/seo/reports/ids";
import { NARRATIVE_NOTE } from "@/lib/seo/reports/text";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { disconnectGoogleCredential } from "@/server/integrations/google-disconnect";
import { describeIntegration } from "@/test-support/integration-suite";

import { SeoReportRetention } from "./retention";
import { SeoReports } from "./runner";
import { listSeoReports, readSeoReportView } from "./store";

// SEO raporlarının teslimi gerçek Postgres'e karşı (yalnız CI ve yerel tek
// kullanımlık veritabanı; Google'a ve gerçek modele gidilmez; sahte kip, yerel
// DB olduğu için gscGlobalWorkAllowedHere() true): haftalık rapor TEK kez
// yazılır (Work wkseo_<proje>, komut kimliği bağa bağlı, kart rakamsız bir
// gösterge, KPI'lar tohum toplamlarıdır, anlatı yok ve sahte-veri notu var);
// ikinci tur bir şey yazmaz; ambar satırı değişse de saklanan anlık görüntü
// aynı kalır; bağ silinip yenisi kurulunca yeni komut kimliğiyle yeniden
// yazılır; hedef eklenince goalsDay ilerler ve currentValue yazılır;
// Disconnect rapor, durum ve ilerlemeyi siler ve hedef değerini boşaltır;
// saklama 100 günlük nabzı ve archive=false bağında 500 günlük haftalığı siler.

const SITE = "sc-domain:acme-seo-reports.test";
const START = "2026-08-31";
const WEEK = "2026-09-28";
const PREV_WEEK = "2026-09-21";
const FINAL = "2026-10-04";
const NEXT_FINAL = "2026-10-05";
// Çarşamba öğleden sonra (UTC).
const NOW = new Date("2026-10-07T12:00:00.000Z");
const BRAND_DAILY = 30;

const IMPRESSIONS = 1000;

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

describeIntegration("SEO reports delivery", () => {
  const runId = randomUUID().slice(0, 8);
  const saved = {
    sync: process.env.GSC_SYNC,
    reports: process.env.SEO_REPORTS,
    mode: process.env.AGENTELSE_PROVIDER_MODE,
    reasoning: process.env.AGENTELSE_REASONING_MODE,
    health: process.env.SEO_HEALTH,
    insights: process.env.SEO_INSIGHTS,
    rollout: process.env.GSC_ROLLOUT_PROJECTS,
  };
  const days = dayRange(START, FINAL);
  let fixture: AgencyFixture;
  let credentialId: string;
  let linkId: string;
  let firstReportId: string;

  function restore(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  // Bir bağ ve ambarı: 5 hafta kesin gün (ilk gün Pazartesi), son iki hafta
  // için haftalık sorgu ve sayfa özetleri.
  async function seedLink(): Promise<string> {
    const brandHash = brandTermsHash(["acme"]);
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
        lastFinalDate: FINAL,
        lastWeeklyWeek: WEEK,
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
    const base = { linkId: link.id, projectId: fixture.projectId };
    const fetchedAt = new Date();
    await prisma.gscDailyTotal.createMany({
      data: days.map((day, index) => ({
        ...base,
        date: dayKeyToDate(day),
        searchType: "web",
        clicks: 100 + (index % 7),
        impressions: IMPRESSIONS,
        positionWeighted: IMPRESSIONS * 5,
        brandClicks: BRAND_DAILY,
        brandImpressions: 200,
        brandPositionWeighted: 400,
        fresh: false,
        fetchedAt,
      })),
    });
    const query = await prisma.gscQuery.create({
      data: {
        ...base,
        text: "trail shoes",
        textHash: `q-${link.id}`,
        isBrand: false,
        firstSeenWeek: dayKeyToDate(PREV_WEEK),
        lastSeenWeek: dayKeyToDate(WEEK),
      },
    });
    const page = await prisma.gscPage.create({
      data: {
        ...base,
        url: "https://www.acme-seo-reports.test/trail",
        urlHash: `p-${link.id}`,
        path: "/trail",
        firstSeenWeek: dayKeyToDate(PREV_WEEK),
        lastSeenWeek: dayKeyToDate(WEEK),
      },
    });
    for (const [weekStart, clicks] of [
      [PREV_WEEK, 10],
      [WEEK, 40],
    ] as const) {
      const start = dayKeyToDate(weekStart);
      await prisma.gscWeeklyQuery.create({
        data: {
          ...base,
          weekStart: start,
          queryId: query.id,
          clicks,
          impressions: 200,
          positionWeighted: 1200,
        },
      });
      await prisma.gscWeeklyPage.create({
        data: {
          ...base,
          weekStart: start,
          pageId: page.id,
          clicks,
          impressions: 200,
          positionWeighted: 800,
        },
      });
      await prisma.gscPeriodFetch.createMany({
        data: (["query", "page"] as const).map((key) => ({
          ...base,
          grain: "WEEK",
          periodStart: start,
          key,
          rowCount: 1,
          rowClicks: clicks,
          rowImpressions: 0,
          pages: 1,
          fetchedAt,
        })),
      });
    }
    return link.id;
  }

  async function counts(projectId: string) {
    const [reports, states, progress] = await Promise.all([
      prisma.seoReport.count({ where: { projectId } }),
      prisma.seoReportState.count({ where: { projectId } }),
      prisma.seoGoalProgress.count({ where: { projectId } }),
    ]);
    return { reports, states, progress };
  }

  beforeAll(async () => {
    process.env.GSC_SYNC = "true";
    process.env.SEO_REPORTS = "true";
    process.env.AGENTELSE_PROVIDER_MODE = "mock";
    process.env.AGENTELSE_REASONING_MODE = "mock";
    process.env.GSC_ROLLOUT_PROJECTS = "";
    delete process.env.SEO_HEALTH;
    delete process.env.SEO_INSIGHTS;
    fixture = await createAgencyFixture(`seo-reports-${runId}`);
    const credential = await prisma.integrationCredential.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        brandId: fixture.brandId,
        provider: "google_search_console",
        accountLabel: "owner@example.com",
        encryptedSecret: "not-used-in-mock-mode",
        status: "ACTIVE",
        metadata: {},
      },
    });
    credentialId = credential.id;
    linkId = await seedLink();
  }, 60_000);

  afterAll(async () => {
    restore("GSC_SYNC", saved.sync);
    restore("SEO_REPORTS", saved.reports);
    restore("AGENTELSE_PROVIDER_MODE", saved.mode);
    restore("AGENTELSE_REASONING_MODE", saved.reasoning);
    restore("SEO_HEALTH", saved.health);
    restore("SEO_INSIGHTS", saved.insights);
    restore("GSC_ROLLOUT_PROJECTS", saved.rollout);
    if (!fixture) return;
    await prisma.gscSiteLink.deleteMany({
      where: { projectId: fixture.projectId },
    });
    await prisma.command.deleteMany({
      where: { workspaceId: fixture.workspaceId },
    });
    await prisma.work.deleteMany({
      where: { workspaceId: fixture.workspaceId },
    });
    await prisma.projectGoal.deleteMany({
      where: { workspaceId: fixture.workspaceId },
    });
    await prisma.integrationCredential.deleteMany({
      where: { workspaceId: fixture.workspaceId },
    });
    await teardownAgencyFixture(fixture.workspaceId);
  });

  it("posts exactly one weekly report into the Search & SEO chat", async () => {
    const result = await SeoReports.runLink(linkId, {
      now: NOW,
      ignoreTime: true,
    });
    expect(result.status).toBe("ran");
    expect(result.posted).toEqual(["WEEKLY"]);

    const work = await prisma.work.findUniqueOrThrow({
      where: { id: `wkseo_${fixture.projectId}` },
    });
    expect(work).toMatchObject({
      module: "seo",
      title: "Search & SEO",
      projectId: fixture.projectId,
    });

    const commandId = seoReportCommandId("WEEKLY", linkId, `W:${WEEK}`);
    expect(commandId).toBe(`seoweekly_${linkId}_${WEEK}`);
    const command = await prisma.command.findUniqueOrThrow({
      where: { id: commandId },
    });
    expect(command).toMatchObject({
      source: "SYSTEM",
      workId: work.id,
      replyStatus: "ANSWERED",
    });
    const report = await prisma.seoReport.findUniqueOrThrow({
      where: { commandId },
    });
    firstReportId = report.id;
    expect(report).toMatchObject({
      kind: "WEEKLY",
      periodKey: `W:${WEEK}`,
      linkId,
      isMock: true,
      narrative: null,
      narrativeNote: NARRATIVE_NOTE.mock,
    });

    // Kart rakam taşımayan bir göstergedir.
    const card = (command.parsedIntent as { card: Record<string, unknown> })
      .card;
    expect(Object.keys(card).sort()).toEqual([
      "kind",
      "periodLabel",
      "reportId",
      "reportKind",
      "title",
    ]);
    expect(card).toMatchObject({
      kind: "seo-report",
      reportId: report.id,
      reportKind: "WEEKLY",
      title: "Weekly SEO report",
    });
    expect(String(card.title)).not.toMatch(/\d/);

    // KPI'lar tohumlanan günlük toplamların toplamıdır.
    const view = await readSeoReportView(fixture.projectId, report.id);
    const kpis = view?.snapshot.sections[0];
    if (kpis?.type !== "kpis") throw new Error("kpis beklendi");
    const curDays = dayRange(WEEK, FINAL);
    // Günlük tıklama 100 + (gün sırası % 7): aynı hafta günü her hafta aynı
    // değeri alır ve nabız sakin kalır.
    const curClicks = sum(curDays.map((day) => 100 + (days.indexOf(day) % 7)));
    const byKey = Object.fromEntries(kpis.kpis.map((kpi) => [kpi.key, kpi]));
    expect(byKey.clicks?.value).toBe(curClicks);
    expect(byKey.impressions?.value).toBe(IMPRESSIONS * 7);
    expect(byKey.brandClicks?.value).toBe(BRAND_DAILY * 7);
    expect(byKey.nonBrandClicks?.value).toBe(curClicks - BRAND_DAILY * 7);
    expect(view?.narrative).toBeNull();
    expect(view?.narrativeNote).toBe(NARRATIVE_NOTE.mock);
    expect(view?.chatHref).toBe(
      `/projects/${fixture.projectId}?work=wkseo_${fixture.projectId}`,
    );

    const list = await listSeoReports(fixture.projectId, { now: NOW });
    expect(list.map((item) => item.id)).toEqual([report.id]);
  });

  it("posts nothing on a second run", async () => {
    const result = await SeoReports.runLink(linkId, {
      now: NOW,
      ignoreTime: true,
    });
    expect(result.posted).toEqual([]);
    expect(await prisma.seoReport.count({ where: { linkId } })).toBe(1);
    expect(
      await prisma.command.count({
        where: { id: { startsWith: `seoweekly_${linkId}` } },
      }),
    ).toBe(1);
    const state = await prisma.seoReportState.findUniqueOrThrow({
      where: { linkId },
    });
    expect(state).toMatchObject({
      weeklyWeek: WEEK,
      consecutiveFailures: 0,
      lastError: null,
      leaseOwner: null,
    });
  });

  it("keeps the stored snapshot when the warehouse is revised later", async () => {
    const before = await readSeoReportView(fixture.projectId, firstReportId);
    await prisma.gscDailyTotal.updateMany({
      where: { linkId, date: dayKeyToDate(WEEK) },
      data: { clicks: 9_999 },
    });
    const after = await readSeoReportView(fixture.projectId, firstReportId);
    expect(after?.snapshot).toEqual(before?.snapshot);
    expect(after?.snapshot).toBeTruthy();
    // Değişiklik geri alınır: sonraki testler tohum toplamlarına dayanır.
    await prisma.gscDailyTotal.updateMany({
      where: { linkId, date: dayKeyToDate(WEEK) },
      data: { clicks: 100 },
    });
  });

  it("writes again under the new link's command id after the link is replaced", async () => {
    await prisma.gscSiteLink.delete({ where: { id: linkId } });
    // Rapor, durum ve ilerleme bağla birlikte cascade ile gitti.
    expect(await counts(fixture.projectId)).toEqual({
      reports: 0,
      states: 0,
      progress: 0,
    });
    const oldLinkId = linkId;
    linkId = await seedLink();
    expect(linkId).not.toBe(oldLinkId);

    const result = await SeoReports.runLink(linkId, {
      now: NOW,
      ignoreTime: true,
    });
    expect(result.posted).toEqual(["WEEKLY"]);
    expect(
      await prisma.command.count({
        where: { id: `seoweekly_${linkId}_${WEEK}` },
      }),
    ).toBe(1);
    // Eski bağın komutu sohbette kalır; ikisi de aynı Work'te.
    expect(
      await prisma.command.count({
        where: { workId: `wkseo_${fixture.projectId}`, source: "SYSTEM" },
      }),
    ).toBe(2);
    expect(
      await prisma.work.count({ where: { id: `wkseo_${fixture.projectId}` } }),
    ).toBe(1);
    const report = await prisma.seoReport.findFirstOrThrow({
      where: { linkId },
    });
    firstReportId = report.id;
  });

  it("measures an SEO goal once the final day moves on", async () => {
    const goal = await prisma.projectGoal.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        brandId: fixture.brandId,
        title: "Reach 5,000 search clicks a month",
        metricKey: "gsc.clicks",
        targetValue: 5_000,
        status: "ACTIVE",
        isMock: true,
      },
    });
    // Yeni kesin gün: bağ ilerler, günlük satır eklenir.
    await prisma.gscDailyTotal.create({
      data: {
        linkId,
        projectId: fixture.projectId,
        date: dayKeyToDate(NEXT_FINAL),
        searchType: "web",
        clicks: 100,
        impressions: IMPRESSIONS,
        positionWeighted: IMPRESSIONS * 5,
        brandClicks: BRAND_DAILY,
        brandImpressions: 200,
        brandPositionWeighted: 400,
        fresh: false,
        fetchedAt: new Date(),
      },
    });
    await prisma.gscSiteLink.update({
      where: { id: linkId },
      data: { lastFinalDate: NEXT_FINAL },
    });
    const result = await SeoReports.runLink(linkId, { now: NOW });
    expect(result.status).toBe("ran");
    expect(result.goals).toBeGreaterThanOrEqual(1);

    const state = await prisma.seoReportState.findUniqueOrThrow({
      where: { linkId },
    });
    expect(state.goalsDay).toBe(NEXT_FINAL);
    const after = await prisma.projectGoal.findUniqueOrThrow({
      where: { id: goal.id },
    });
    expect(after.currentValue).toBeGreaterThan(0);
    const progress = await prisma.seoGoalProgress.findUniqueOrThrow({
      where: { goalId: goal.id },
    });
    expect(progress).toMatchObject({ linkId, isMock: true });
    expect(progress.value).toBe(after.currentValue);
    expect(progress.measuredThrough).toBe(NEXT_FINAL);
  });

  it("deletes reports, state and progress on Disconnect and nulls the goal value", async () => {
    const before = await counts(fixture.projectId);
    expect(before.reports).toBeGreaterThan(0);
    expect(before.states).toBe(1);
    expect(before.progress).toBe(1);

    const credential = await prisma.integrationCredential.findUniqueOrThrow({
      where: { id: credentialId },
    });
    await disconnectGoogleCredential({ ...credential, metadata: {} });

    expect(await counts(fixture.projectId)).toEqual({
      reports: 0,
      states: 0,
      progress: 0,
    });
    const goal = await prisma.projectGoal.findFirstOrThrow({
      where: { projectId: fixture.projectId, metricKey: "gsc.clicks" },
    });
    expect(goal.currentValue).toBeNull();
  });

  it("retention deletes a 100-day-old pulse and a 500-day-old weekly of an archive=false link", async () => {
    linkId = await seedLink();
    await prisma.gscSiteLink.update({
      where: { id: linkId },
      data: { archive: false },
    });
    const now = new Date();
    const dayMs = 86_400_000;
    const row = (
      kind: "PULSE" | "WEEKLY",
      periodKey: string,
      ageDays: number,
    ) => ({
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      linkId,
      kind,
      periodKey,
      periodStart: dayKeyToDate(addDays(WEEK, -7)),
      periodEnd: dayKeyToDate(WEEK),
      finalThrough: FINAL,
      language: "en",
      title: kind === "PULSE" ? "Search pulse" : "Weekly SEO report",
      snapshot: { v: 1 },
      commandId: `seoretention_${runId}_${periodKey}`,
      isMock: true,
      createdAt: new Date(now.getTime() - ageDays * dayMs),
    });
    await prisma.seoReport.createMany({
      data: [
        row("PULSE", "D:2026-06-01", 100),
        row("PULSE", "D:2026-09-30", 5),
        row("WEEKLY", "W:2025-05-26", 500),
        row("WEEKLY", "W:2026-03-02", 200),
      ],
    });

    await SeoReportRetention.runDue(now);

    const left = await prisma.seoReport.findMany({
      where: { linkId },
      select: { periodKey: true },
      orderBy: { periodKey: "asc" },
    });
    expect(left.map((item) => item.periodKey)).toEqual([
      "D:2026-09-30",
      "W:2026-03-02",
    ]);
  });
});
