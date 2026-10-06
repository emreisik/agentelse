import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

const outputs = vi.hoisted(() => ({
  publish: vi.fn(),
  suggest: vi.fn(),
}));
// P4 çıktıları bu testte sahte: yalnız çağrıldıkları doğrulanır.
vi.mock("./outputs", () => ({
  publishOpportunityOutputs: outputs.publish,
  maybeSuggestBrandTerms: outputs.suggest,
}));

import type { GscSiteLink } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { addDays, addWeeks, dayKeyToDate, dayRange } from "@/lib/seo/dates";
import { textHash } from "@/lib/seo/normalize";
import { SEARCH_OPPORTUNITY_SIGNAL_SOURCE } from "@/lib/seo/opportunity-types";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { disconnectGoogleCredential } from "@/server/integrations/google-disconnect";
import { deleteGscDataForProject } from "@/server/seo/sync/links";
import { describeIntegration } from "@/test-support/integration-suite";

import { setFindingOutputs } from "./findings-store";
import { forgetSearchOpportunitiesForLinks } from "./forget";
import { SeoOpportunities } from "./runner";

// SEO fırsat motoru gerçek Postgres'e karşı (yalnız CI ve yerel tek
// kullanımlık veritabanı; mock kipte Google'a, siteye ya da OpenAI'ye
// gidilmez): 13 haftalık ambar tohumu SO1 (vuruş mesafesi), SO2 (CTR açığı)
// ve SO6 (yükselen sorgu) üretir. Eksik query_page özeti no_data; gölge
// koşu gölge bulgu yazar, sinyal yok; aynı hafta yeniden koşu çoğaltmaz;
// hafta ilerleyince yeni parmak izi, eski satır SUPERSEDED ve fikir bağları
// taşınır; reddedilen konu geri gelmez; "on" kipine geçiş bulguları gölgeden
// çıkarır ve çıktıları çağırır; niyetler ve kümeler yazılır; silme yolları
// motor verisini temizler.

const NOW = new Date("2026-10-07T12:00:00.000Z");
const WEEK = "2026-09-21";
const NEXT_WEEK = addWeeks(WEEK, 1);
// WEEK-11 .. WEEK+1: 13 hafta.
const WEEKS = Array.from({ length: 13 }, (_, index) =>
  addWeeks(WEEK, index - 11),
);
const CURRENT_FROM = addWeeks(WEEK, -3);

type SeedQuery = {
  key: string;
  text: string;
  isBrand: boolean;
  page: string;
  from: string;
  impressions: number;
  position: number;
  clicks: (week: string) => number;
};

const QUERIES: SeedQuery[] = [
  {
    key: "guide",
    text: "running shoes guide",
    isBrand: false,
    page: "/guide",
    from: WEEKS[0]!,
    impressions: 500,
    position: 8,
    clicks: (week) => (week >= CURRENT_FROM ? 1 : 10),
  },
  {
    key: "guides",
    text: "running shoes guides",
    isBrand: false,
    page: "/guide",
    from: WEEKS[0]!,
    impressions: 150,
    position: 9,
    clicks: () => 1,
  },
  {
    key: "shoe",
    text: "running shoe guide",
    isBrand: false,
    page: "/guide",
    from: WEEKS[0]!,
    impressions: 150,
    position: 9,
    clicks: () => 1,
  },
  {
    key: "trail",
    text: "trail sneakers 2026",
    isBrand: false,
    page: "/trail",
    from: CURRENT_FROM,
    impressions: 100,
    position: 15,
    clicks: () => 0,
  },
  {
    key: "brand",
    text: "acme shoes",
    isBrand: true,
    page: "/",
    from: WEEKS[0]!,
    impressions: 200,
    position: 1.5,
    clicks: () => 100,
  },
];

describeIntegration("SEO opportunity engine (mock providers)", () => {
  const runId = randomUUID().slice(0, 8);
  const saved = {
    sync: process.env.GSC_SYNC,
    insights: process.env.SEO_INSIGHTS,
    provider: process.env.AGENTELSE_PROVIDER_MODE,
    reasoning: process.env.AGENTELSE_REASONING_MODE,
    health: process.env.SEO_HEALTH,
  };
  let fixture: AgencyFixture;
  let credentialId: string;
  let link: GscSiteLink;
  const queryIds = new Map<string, string>();
  const pageIds = new Map<string, string>();

  async function seedLink(): Promise<GscSiteLink> {
    const created = await prisma.gscSiteLink.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        credentialId,
        siteUrl: "sc-domain:example.com",
        isPrimary: true,
        isMock: true,
        propertyType: "DOMAIN",
        brandTerms: {
          v: 1,
          auto: [],
          user: ["acme"],
          removed: [],
          updatedAt: null,
        },
        health: "OK",
        lastWeeklyWeek: WEEK,
        lastFinalDate: addDays(NEXT_WEEK, 6),
      },
    });
    const base = {
      linkId: created.id,
      projectId: fixture.projectId,
    };
    for (const path of ["/guide", "/trail", "/"]) {
      const url = `https://example.com${path}`;
      const page = await prisma.gscPage.create({
        data: {
          ...base,
          url,
          urlHash: textHash(url),
          path,
          firstSeenWeek: dayKeyToDate(WEEKS[0]!),
          lastSeenWeek: dayKeyToDate(NEXT_WEEK),
        },
      });
      pageIds.set(path, page.id);
    }
    for (const query of QUERIES) {
      const row = await prisma.gscQuery.create({
        data: {
          ...base,
          text: query.text,
          textHash: textHash(query.text),
          isBrand: query.isBrand,
          firstSeenWeek: dayKeyToDate(query.from),
          lastSeenWeek: dayKeyToDate(NEXT_WEEK),
        },
      });
      queryIds.set(query.key, row.id);
    }

    const weeklyQuery = [];
    const weeklyPair = [];
    const pageTotals = new Map<
      string,
      { clicks: number; impressions: number; positionWeighted: number }
    >();
    for (const week of WEEKS) {
      for (const query of QUERIES) {
        if (week < query.from) continue;
        const metric = {
          clicks: query.clicks(week),
          impressions: query.impressions,
          positionWeighted: query.position * query.impressions,
        };
        const weekStart = dayKeyToDate(week);
        weeklyQuery.push({
          ...base,
          weekStart,
          queryId: queryIds.get(query.key)!,
          ...metric,
        });
        weeklyPair.push({
          ...base,
          weekStart,
          queryId: queryIds.get(query.key)!,
          pageId: pageIds.get(query.page)!,
          ...metric,
        });
        const key = `${week}|${query.page}`;
        const total = pageTotals.get(key) ?? {
          clicks: 0,
          impressions: 0,
          positionWeighted: 0,
        };
        total.clicks += metric.clicks;
        total.impressions += metric.impressions;
        total.positionWeighted += metric.positionWeighted;
        pageTotals.set(key, total);
      }
    }
    await prisma.gscWeeklyQuery.createMany({ data: weeklyQuery });
    await prisma.gscWeeklyQueryPage.createMany({ data: weeklyPair });
    await prisma.gscWeeklyPage.createMany({
      data: [...pageTotals.entries()].map(([key, total]) => {
        const [week, path] = key.split("|") as [string, string];
        return {
          ...base,
          weekStart: dayKeyToDate(week),
          pageId: pageIds.get(path)!,
          ...total,
        };
      }),
    });
    await prisma.gscPeriodFetch.createMany({
      data: WEEKS.flatMap((week) =>
        ["query", "page", "query_page"].map((key) => ({
          ...base,
          grain: "WEEK",
          periodStart: dayKeyToDate(week),
          key,
          fetchedAt: NOW,
        })),
      ),
    });
    await prisma.gscDailyTotal.createMany({
      data: dayRange(WEEKS[0]!, addDays(NEXT_WEEK, 6)).map((day) => ({
        ...base,
        date: dayKeyToDate(day),
        searchType: "web",
        clicks: 10,
        impressions: 200,
        positionWeighted: 1_200,
        fresh: false,
        fetchedAt: NOW,
      })),
    });
    return created;
  }

  async function findings(where: Record<string, unknown> = {}) {
    return prisma.seoFinding.findMany({
      where: { linkId: link.id, ...where },
      orderBy: { createdAt: "asc" },
    });
  }

  beforeAll(async () => {
    process.env.GSC_SYNC = "true";
    process.env.SEO_INSIGHTS = "shadow";
    process.env.AGENTELSE_PROVIDER_MODE = "mock";
    process.env.AGENTELSE_REASONING_MODE = "mock";
    delete process.env.SEO_HEALTH;
    outputs.publish.mockResolvedValue({
      explained: 0,
      signals: 0,
      budgetHit: false,
    });
    outputs.suggest.mockResolvedValue({ ran: false, budgetHit: false });
    fixture = await createAgencyFixture(`seo-opp-${runId}`);
    const credential = await prisma.integrationCredential.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        brandId: fixture.brandId,
        provider: "google_search_console",
        accountLabel: "owner@example.com",
        encryptedSecret: "not-used-in-mock-mode",
        status: "ACTIVE",
        metadata: {
          searchConsoleSites: [
            { siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" },
          ],
          selectedSearchConsoleSite: "sc-domain:example.com",
        },
      },
    });
    credentialId = credential.id;
    link = await seedLink();
  }, 60_000);

  afterAll(async () => {
    process.env.GSC_SYNC = saved.sync;
    process.env.SEO_INSIGHTS = saved.insights;
    process.env.AGENTELSE_PROVIDER_MODE = saved.provider;
    process.env.AGENTELSE_REASONING_MODE = saved.reasoning;
    process.env.SEO_HEALTH = saved.health;
    await prisma.signal.deleteMany({
      where: { workspaceId: fixture?.workspaceId },
    });
    await prisma.idea.deleteMany({
      where: { workspaceId: fixture?.workspaceId },
    });
    await prisma.gscSiteLink.deleteMany({
      where: { projectId: fixture?.projectId },
    });
    await prisma.integrationCredential.deleteMany({
      where: { workspaceId: fixture?.workspaceId },
    });
    await teardownAgencyFixture(fixture?.workspaceId);
  });

  it("returns no_data while a current week lacks the query_page summary", async () => {
    const missing = await prisma.gscPeriodFetch.findFirstOrThrow({
      where: {
        linkId: link.id,
        grain: "WEEK",
        key: "query_page",
        periodStart: dayKeyToDate(addWeeks(WEEK, -1)),
      },
    });
    await prisma.gscPeriodFetch.delete({ where: { id: missing.id } });
    const result = await SeoOpportunities.runLink(link.id, { now: NOW });
    expect(result.status).toBe("no_data");
    const state = await prisma.seoEngineState.findUniqueOrThrow({
      where: { linkId: link.id },
    });
    expect(state.lastWeek).toBeNull();
    expect(await prisma.seoFinding.count({ where: { linkId: link.id } })).toBe(
      0,
    );
    await prisma.gscPeriodFetch.create({
      data: {
        linkId: missing.linkId,
        projectId: missing.projectId,
        grain: missing.grain,
        periodStart: missing.periodStart,
        key: missing.key,
        fetchedAt: missing.fetchedAt,
      },
    });
  }, 60_000);

  it("persists shadow findings without Signals and classifies the queries", async () => {
    const result = await SeoOpportunities.runLink(link.id, { now: NOW });
    expect(result.status).toBe("ran");
    const rows = await findings();
    const rules = new Set(rows.map((row) => row.ruleKey));
    expect(rules.has("SO1_STRIKING_DISTANCE")).toBe(true);
    expect(rules.has("SO2_CTR_GAP")).toBe(true);
    expect(rules.has("SO6_RISING_QUERY")).toBe(true);
    expect(rows.every((row) => row.shadow && row.status === "OPEN")).toBe(true);
    expect(rows.every((row) => row.periodKey === `W:${addDays(WEEK, 6)}`)).toBe(
      true,
    );
    expect(
      await prisma.signal.count({
        where: {
          projectId: fixture.projectId,
          source: SEARCH_OPPORTUNITY_SIGNAL_SOURCE,
        },
      }),
    ).toBe(0);
    expect(outputs.publish).not.toHaveBeenCalled();

    const state = await prisma.seoEngineState.findUniqueOrThrow({
      where: { linkId: link.id },
    });
    expect(state.lastWeek).toBe(WEEK);
    expect(state.curvesWeek).toBe(WEEK);
    expect(state.clustersWeek).toBe(WEEK);
    expect(state.lastRunStats).toMatchObject({ mode: "shadow" });

    const queries = await prisma.gscQuery.findMany({
      where: { linkId: link.id },
    });
    expect(queries.every((query) => query.intent !== null)).toBe(true);
    expect(queries.find((query) => query.text === "acme shoes")?.intent).toBe(
      "navigational",
    );
    expect(
      await prisma.seoQueryEmbedding.count({ where: { linkId: link.id } }),
    ).toBe(4);
    const clusters = await prisma.seoCluster.findMany({
      where: { linkId: link.id, status: "ACTIVE" },
    });
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({
      nameSource: "TOP_QUERY",
      name: "running shoes guide",
      pillarPageId: pageIds.get("/guide"),
      queryCount: 3,
    });
    expect(
      queries.filter((query) => query.clusterId === clusters[0]!.id),
    ).toHaveLength(3);
  }, 120_000);

  it("updates the same rows on a same-week re-run", async () => {
    const before = await findings();
    const result = await SeoOpportunities.runLink(link.id, {
      now: NOW,
      force: true,
    });
    expect(result.status).toBe("ran");
    expect(result.persist?.created).toBe(0);
    const after = await findings();
    expect(after.map((row) => row.id).sort()).toEqual(
      before.map((row) => row.id).sort(),
    );
    expect(await prisma.seoCluster.count({ where: { linkId: link.id } })).toBe(
      1,
    );
  }, 120_000);

  it("supersedes last week's rows, carries idea links and keeps a dismissed subject away", async () => {
    const so1 = (await findings({ ruleKey: "SO1_STRIKING_DISTANCE" }))[0]!;
    const so2 = (await findings({ ruleKey: "SO2_CTR_GAP" }))[0]!;
    await setFindingOutputs(so1.id, { ideaIds: ["idea-carried"] });
    await prisma.seoFinding.update({
      where: { id: so2.id },
      data: { status: "DISMISSED", decidedAt: NOW, dismissReason: "not_now" },
    });
    await prisma.gscSiteLink.update({
      where: { id: link.id },
      data: { lastWeeklyWeek: NEXT_WEEK },
    });

    const result = await SeoOpportunities.runLink(link.id, { now: NOW });
    expect(result.status).toBe("ran");
    const periodKey = `W:${addDays(NEXT_WEEK, 6)}`;
    const old = await prisma.seoFinding.findUniqueOrThrow({
      where: { id: so1.id },
    });
    expect(old.status).toBe("SUPERSEDED");
    const next = await findings({
      ruleKey: "SO1_STRIKING_DISTANCE",
      subject: so1.subject,
      periodKey,
    });
    expect(next).toHaveLength(1);
    expect(next[0]!.fingerprint).not.toBe(so1.fingerprint);
    expect(next[0]!.ideaIds).toEqual(["idea-carried"]);
    expect(next[0]!.status).toBe("OPEN");
    expect(
      await findings({
        ruleKey: "SO2_CTR_GAP",
        subject: so2.subject,
        periodKey,
      }),
    ).toHaveLength(0);
    expect(
      await findings({ ruleKey: "SO6_RISING_QUERY", periodKey }),
    ).toHaveLength(1);
  }, 120_000);

  it("unshadows the current week and publishes outputs after switching to on", async () => {
    process.env.SEO_INSIGHTS = "on";
    link = await prisma.gscSiteLink.findUniqueOrThrow({
      where: { id: link.id },
    });
    const result = await SeoOpportunities.runLink(link.id, { now: NOW });
    expect(result.status).toBe("ran");
    const current = await findings({
      periodKey: `W:${addDays(NEXT_WEEK, 6)}`,
      status: "OPEN",
    });
    expect(current.length).toBeGreaterThan(0);
    expect(current.every((row) => !row.shadow)).toBe(true);
    expect(outputs.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        week: NEXT_WEEK,
        periodKey: `W:${addDays(NEXT_WEEK, 6)}`,
      }),
    );
    expect(outputs.suggest).toHaveBeenCalled();
    const state = await prisma.seoEngineState.findUniqueOrThrow({
      where: { linkId: link.id },
    });
    expect(state.lastRunStats).toMatchObject({ mode: "on" });
  }, 120_000);

  it("forgets engine Signals and pool ideas, and cascades the engine tables on delete", async () => {
    const finding = (await findings({ status: "OPEN" }))[0]!;
    const evidenceUrl = `https://app.example.com/projects/${fixture.projectId}/arama?opportunity=${finding.id}#opportunities`;
    const concept = {
      v: 2,
      module: "seo",
      source: "search",
      evidence: [{ title: "Search Console", url: evidenceUrl }],
      draft: {
        keyword: "running shoes guide",
        intent: "informational",
        title: "Running shoes guide",
        description: "A guide.",
        angle: "An angle.",
      },
    };
    const pool = await prisma.idea.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        brandId: fixture.brandId,
        title: "Pool idea",
        description: "From search",
        concept,
        status: "RAW",
      },
    });
    const approved = await prisma.idea.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        brandId: fixture.brandId,
        title: "Approved idea",
        description: "From search",
        concept,
        status: "APPROVED",
      },
    });
    await prisma.signal.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        brandId: fixture.brandId,
        source: SEARCH_OPPORTUNITY_SIGNAL_SOURCE,
        category: "SEO",
        title: "Search: a page is losing clicks",
        fingerprint: `seo-opp-${runId}`,
        payload: { linkId: link.id, findingId: finding.id },
      },
    });

    const forgotten = await forgetSearchOpportunitiesForLinks([link.id]);
    expect(forgotten.signals).toBe(1);
    expect(await prisma.idea.findUnique({ where: { id: pool.id } })).toBeNull();
    const kept = await prisma.idea.findUniqueOrThrow({
      where: { id: approved.id },
    });
    expect(kept.concept).not.toHaveProperty("evidence");

    // "Delete stored data": bağ ve motor tabloları cascade ile gider.
    await deleteGscDataForProject(fixture.projectId, NOW);
    for (const count of await Promise.all([
      prisma.seoFinding.count({ where: { linkId: link.id } }),
      prisma.seoCluster.count({ where: { linkId: link.id } }),
      prisma.seoQueryEmbedding.count({ where: { linkId: link.id } }),
      prisma.seoEngineState.count({ where: { linkId: link.id } }),
    ])) {
      expect(count).toBe(0);
    }

    // Disconnect: yeni tohumlanan bağın motor verisi de gider.
    await prisma.gscSiteLink.deleteMany({
      where: { projectId: fixture.projectId },
    });
    queryIds.clear();
    pageIds.clear();
    link = await seedLink();
    process.env.SEO_INSIGHTS = "shadow";
    expect((await SeoOpportunities.runLink(link.id, { now: NOW })).status).toBe(
      "ran",
    );
    expect(await prisma.seoFinding.count({ where: { linkId: link.id } })).toBe(
      (await findings()).length,
    );
    expect((await findings()).length).toBeGreaterThan(0);
    const credential = await prisma.integrationCredential.findUniqueOrThrow({
      where: { id: credentialId },
    });
    await disconnectGoogleCredential({ ...credential, metadata: {} });
    for (const count of await Promise.all([
      prisma.seoFinding.count({ where: { projectId: fixture.projectId } }),
      prisma.seoCluster.count({ where: { projectId: fixture.projectId } }),
      prisma.seoQueryEmbedding.count({
        where: { projectId: fixture.projectId },
      }),
      prisma.seoEngineState.count({ where: { projectId: fixture.projectId } }),
    ])) {
      expect(count).toBe(0);
    }
  }, 180_000);
});
