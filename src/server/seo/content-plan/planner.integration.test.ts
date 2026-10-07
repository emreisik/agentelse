import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

const w3 = vi.hoisted(() => ({ snapshot: vi.fn() }));
// W3 motoru bu testte sahte: gerçek veritabanı yalnız plan, fikir, parça ve
// sınır tarafında çalışır (anlık görüntü elle kurulmuş bir RuleSnapshot'tır).
vi.mock("@/server/works/flag", () => ({ isModulesEnabled: () => true }));
vi.mock("@/server/seo/opportunities/snapshot", () => ({
  loadRuleSnapshot: w3.snapshot,
}));
vi.mock("@/server/seo/opportunities/state", () => ({
  readEngineState: async () => ({
    lastWeek: "2026-09-28",
    clustersWeek: "2026-09-28",
    curves: null,
  }),
  parseSeoCurves: () => ({ nonBrand: {}, brand: {} }),
}));
vi.mock("@/server/seo/opportunities/clusters", () => ({
  readClusters: async () => [],
}));
vi.mock("@/server/seo/opportunities/findings-store", () => ({
  listProjectFindings: async () => [],
}));

import type { GscSiteLink } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { parseContentPlanData } from "@/lib/seo/content-plan/types";
import { creativeFieldsOfPlanItem } from "@/lib/works/plan-item-fields";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { describeIntegration } from "@/test-support/integration-suite";

import {
  createMonthlyPlan,
  moveSlot,
  regenerateContentPlan,
  skipSlot,
} from "./planner";

// Aylık SEO içerik planlayıcısı gerçek Postgres'e karşı (yalnız CI ve yerel
// tek kullanımlık veritabanı; mock kipte Google'a, siteye ya da OpenAI'ye
// gidilmez): plan N <= sınır slot yazar, her slotun fikri (PLANNING, seo,
// search), Post'u (planId yok) ve DRAFT Creative'i (sürümsüz) vardır; hiçbir
// şey APPROVED olmaz. İkinci çağrı çoğaltmaz, eşzamanlı iki çağrı tek plan
// yazar, elle yazılmış makale kapasiteyi düşürür, Skip/Replace sınırı aşmaz,
// Refresh yazılmış slota dokunmaz.

const NOW = new Date("2026-10-07T09:00:00.000Z");
const MONTH = "2026-10";
const TIMEZONE = "Europe/Istanbul";
const WEEK = "2026-09-28";

const FIRST = ["zar", "mon", "vel", "qui", "dro", "bax", "lin", "tor", "fen", "gal"];
const SECOND = ["ix", "ox", "ur", "an"];

// 40 birbirinden ayrışık sahte sözcük (Jaccard 0, anlamlı sözcük, yer adı değil).
function word(index: number): string {
  return `${FIRST[index % 10]}${SECOND[Math.floor(index / 10)]}ra`;
}

// 10 küme: her birinde güçlü ana sayfa (ilk 10'da sorgu A) ve sayfası olmayan bir
// alt konu sorgusu B (NO_PAGE adayı).
function snapshot() {
  const queries = [];
  const pairs = [];
  const pages = [];
  const clusters = [];
  for (let i = 0; i < 10; i += 1) {
    const aText = `${word(i * 4)} ${word(i * 4 + 1)}`;
    const bText = `${word(i * 4 + 2)} ${word(i * 4 + 3)} faq`;
    const base = {
      isBrand: false,
      intent: null,
      language: null,
      clusterId: `cl-${i}`,
      firstSeenWeek: "2025-01-06",
      clicks: 10,
    };
    queries.push(
      { ...base, queryId: `qa-${i}`, text: aText, impressions: 3000, positionWeighted: 3000 * 5 },
      { ...base, queryId: `qb-${i}`, text: bText, impressions: 800 - i * 10, positionWeighted: (800 - i * 10) * 30 },
    );
    pairs.push({ queryId: `qa-${i}`, pageId: `pg-${i}`, clicks: 10, impressions: 3000, positionWeighted: 3000 * 5 });
    pages.push({
      pageId: `pg-${i}`,
      url: `https://example.com/p${i}`,
      path: `/p${i}`,
      pageGroup: null,
      firstSeenWeek: "2025-01-06",
      clicks: 10,
      impressions: 3000,
      positionWeighted: 3000 * 5,
    });
    clusters.push({ clusterId: `cl-${i}`, name: `Cluster ${i}`, queryIds: [`qa-${i}`, `qb-${i}`], pillarPageId: `pg-${i}` });
  }
  return {
    week: WEEK,
    projectLanguage: "en",
    previousComplete: false,
    previousQueries: [],
    totals: { clicks: 100, impressions: 50_000, nonBrandClicks: null, nonBrandImpressions: 45_000 },
    brandTerms: ["acme"],
    queries,
    pairs,
    pages,
    clusters,
    crawl: null,
  };
}

describeIntegration("SEO content plan planner (mock providers)", () => {
  const runId = randomUUID().slice(0, 8);
  const saved = {
    plan: process.env.SEO_CONTENT_PLAN,
    sync: process.env.GSC_SYNC,
    insights: process.env.SEO_INSIGHTS,
    page: process.env.GSC_SEARCH_PAGE,
    provider: process.env.AGENTELSE_PROVIDER_MODE,
    reasoning: process.env.AGENTELSE_REASONING_MODE,
  };
  let fixture: AgencyFixture;
  let link: GscSiteLink;

  const args = () => ({
    link,
    month: MONTH,
    timezone: TIMEZONE,
    now: NOW,
    trigger: "manual" as const,
    userId: "u1",
  });

  async function setCap(monthlyCap: number): Promise<void> {
    await prisma.seoContentSetting.upsert({
      where: { projectId: fixture.projectId },
      create: { workspaceId: fixture.workspaceId, projectId: fixture.projectId, monthlyCap },
      update: { monthlyCap },
    });
  }

  async function clearPlan(): Promise<void> {
    const where = { projectId: fixture.projectId };
    await prisma.creativeVersion.deleteMany({ where: { creative: where } });
    await prisma.creative.deleteMany({ where });
    await prisma.post.deleteMany({ where });
    await prisma.idea.deleteMany({ where });
    await prisma.seoContentPlan.deleteMany({ where });
  }

  async function liveSeoCreatives() {
    return prisma.creative.findMany({
      where: {
        projectId: fixture.projectId,
        formatKey: "seo.article",
        status: { notIn: ["ARCHIVED", "REJECTED"] },
      },
    });
  }

  async function planRow() {
    return prisma.seoContentPlan.findUnique({
      where: { linkId_month: { linkId: link.id, month: MONTH } },
    });
  }

  beforeAll(async () => {
    process.env.SEO_CONTENT_PLAN = "true";
    process.env.GSC_SYNC = "true";
    process.env.SEO_INSIGHTS = "on";
    process.env.GSC_SEARCH_PAGE = "true";
    process.env.AGENTELSE_PROVIDER_MODE = "mock";
    process.env.AGENTELSE_REASONING_MODE = "mock";
    fixture = await createAgencyFixture(`seo-plan-${runId}`);
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
          searchConsoleSites: [{ siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" }],
          selectedSearchConsoleSite: "sc-domain:example.com",
        },
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
        propertyType: "DOMAIN",
        health: "OK",
        lastWeeklyWeek: WEEK,
      },
    });
  }, 60_000);

  beforeEach(async () => {
    w3.snapshot.mockResolvedValue(snapshot());
    await clearPlan();
    await setCap(4);
  });

  afterAll(async () => {
    process.env.SEO_CONTENT_PLAN = saved.plan;
    process.env.GSC_SYNC = saved.sync;
    process.env.SEO_INSIGHTS = saved.insights;
    process.env.GSC_SEARCH_PAGE = saved.page;
    process.env.AGENTELSE_PROVIDER_MODE = saved.provider;
    process.env.AGENTELSE_REASONING_MODE = saved.reasoning;
    await clearPlan();
    await prisma.seoContentSetting.deleteMany({ where: { projectId: fixture?.projectId } });
    await prisma.gscSiteLink.deleteMany({ where: { projectId: fixture?.projectId } });
    await prisma.integrationCredential.deleteMany({ where: { workspaceId: fixture?.workspaceId } });
    await teardownAgencyFixture(fixture?.workspaceId);
  });

  it("creates at most the limit of slots with an idea, a post and a draft creative each", async () => {
    const outcome = await createMonthlyPlan(args());
    expect(outcome.status).toBe("created");
    const row = await planRow();
    expect(row).toMatchObject({ status: "ACTIVE", cap: 4, isMock: true, wording: "MOCK" });
    const data = parseContentPlanData(row!.data);
    expect(data.slots.length).toBeGreaterThan(0);
    expect(data.slots.length).toBeLessThanOrEqual(4);

    const from = new Date("2026-09-30T21:00:00Z");
    const to = new Date("2026-10-31T21:00:00Z");
    for (const slot of data.slots) {
      const idea = await prisma.idea.findUniqueOrThrow({ where: { id: slot.ideaId } });
      expect(idea.status).toBe("PLANNING");
      expect(idea.isMock).toBe(true);
      expect(idea.concept).toMatchObject({ module: "seo", source: "search" });
      const post = await prisma.post.findUniqueOrThrow({ where: { id: slot.postId } });
      expect(post).toMatchObject({ planId: null, ideaId: slot.ideaId, workId: null, approvedAt: null });
      const creative = await prisma.creative.findUniqueOrThrow({
        where: { id: slot.creativeId },
        include: { versions: true },
      });
      expect(creative).toMatchObject({ status: "DRAFT", formatKey: "seo.article", channel: "seo", planId: null, postId: slot.postId });
      expect(creative.versions).toHaveLength(0);
      expect(creative.scheduledFor!.getTime()).toBeGreaterThanOrEqual(from.getTime());
      expect(creative.scheduledFor!.getTime()).toBeLessThan(to.getTime());
    }
    // Hiçbir kod yolu APPROVED yapmaz, onay damgası ya da sürüm yazmaz.
    expect(await prisma.creative.count({ where: { projectId: fixture.projectId, status: "APPROVED" } })).toBe(0);
    expect(await prisma.creativeVersion.count({ where: { creative: { projectId: fixture.projectId } } })).toBe(0);
    expect(await prisma.post.count({ where: { projectId: fixture.projectId, approvedAt: { not: null } } })).toBe(0);
  });

  it("a second call reports exists and leaves the counts unchanged", async () => {
    await createMonthlyPlan(args());
    const before = {
      creatives: await prisma.creative.count({ where: { projectId: fixture.projectId } }),
      posts: await prisma.post.count({ where: { projectId: fixture.projectId } }),
      ideas: await prisma.idea.count({ where: { projectId: fixture.projectId } }),
      plans: await prisma.seoContentPlan.count({ where: { projectId: fixture.projectId } }),
    };
    expect(await createMonthlyPlan(args())).toEqual({ status: "exists" });
    expect({
      creatives: await prisma.creative.count({ where: { projectId: fixture.projectId } }),
      posts: await prisma.post.count({ where: { projectId: fixture.projectId } }),
      ideas: await prisma.idea.count({ where: { projectId: fixture.projectId } }),
      plans: await prisma.seoContentPlan.count({ where: { projectId: fixture.projectId } }),
    }).toEqual(before);
  });

  it("two simultaneous calls write exactly one plan row and one set of pieces", async () => {
    const results = await Promise.all([createMonthlyPlan(args()), createMonthlyPlan(args())]);
    expect(results.filter((result) => result.status === "created")).toHaveLength(1);
    expect(await prisma.seoContentPlan.count({ where: { projectId: fixture.projectId } })).toBe(1);
    const data = parseContentPlanData((await planRow())!.data);
    expect(await prisma.creative.count({ where: { projectId: fixture.projectId } })).toBe(data.slots.length);
    expect(await prisma.post.count({ where: { projectId: fixture.projectId } })).toBe(data.slots.length);
    expect(await prisma.idea.count({ where: { projectId: fixture.projectId } })).toBe(data.slots.length);
  });

  it("a pre-existing manual article of the month reduces the capacity", async () => {
    const fields = creativeFieldsOfPlanItem({
      date: "2026-10-20",
      time: "10:00",
      channel: "seo",
      formatKey: "seo.article",
      topic: "A manual article",
      captionIdea: "Written by hand",
    });
    const post = await prisma.post.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        brandId: fixture.brandId,
        topic: "A manual article",
        scheduledFor: new Date("2026-10-20T07:00:00Z"),
        timezone: TIMEZONE,
      },
    });
    await prisma.creative.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        brandId: fixture.brandId,
        type: fields.type,
        channel: "seo",
        formatKey: "seo.article",
        title: "A manual article",
        status: "DRAFT",
        postId: post.id,
        scheduledFor: new Date("2026-10-20T07:00:00Z"),
      },
    });
    const outcome = await createMonthlyPlan(args());
    expect(outcome.status).toBe("created");
    const data = parseContentPlanData((await planRow())!.data);
    expect(data.slots.length).toBeLessThanOrEqual(3);
    expect(await liveSeoCreatives()).toHaveLength(data.slots.length + 1);
    expect((await planRow())!.existingAtPlan).toBe(1);
    // Slotlar elle yazılan makalenin gününe konmaz.
    for (const slot of data.slots) expect(slot.date).not.toBe("2026-10-20");
  });

  it("skip then replace keeps the month's articles within the limit", async () => {
    await createMonthlyPlan(args());
    const [first, second] = parseContentPlanData((await planRow())!.data).slots;
    expect(await skipSlot({ projectId: fixture.projectId, slotId: first!.id, userId: "u1", now: NOW })).toEqual({ ok: true });
    expect((await liveSeoCreatives()).length).toBeLessThanOrEqual(4);
    const replaced = await regenerateContentPlan({
      projectId: fixture.projectId,
      userId: "u1",
      slotId: second!.id,
      now: NOW,
      trigger: "manual",
    });
    expect(replaced.ok).toBe(true);
    expect((await liveSeoCreatives()).length).toBeLessThanOrEqual(4);
    const data = parseContentPlanData((await planRow())!.data);
    expect(data.slots.find((slot) => slot.id === first!.id)!.status).toBe("SKIPPED");
    expect(data.slots.find((slot) => slot.id === second!.id)!.status).toBe("REMOVED");
    expect(data.rejected.length).toBeGreaterThanOrEqual(2);
    const skippedIdea = await prisma.idea.findUniqueOrThrow({ where: { id: first!.ideaId } });
    expect(skippedIdea.status).toBe("ARCHIVED");
  });

  it("moves an untouched slot inside the month and refuses the past", async () => {
    await createMonthlyPlan(args());
    const [first] = parseContentPlanData((await planRow())!.data).slots;
    expect(await moveSlot({ projectId: fixture.projectId, slotId: first!.id, date: "2026-10-28", userId: "u1", now: NOW })).toEqual({ ok: true });
    const creative = await prisma.creative.findUniqueOrThrow({ where: { id: first!.creativeId } });
    expect(creative.scheduledFor!.toISOString()).toBe("2026-10-28T07:00:00.000Z");
    expect(await moveSlot({ projectId: fixture.projectId, slotId: first!.id, date: "2026-10-01", userId: "u1", now: NOW })).toEqual({ ok: false, reason: "past" });
  });

  it("refresh keeps a written slot and never goes over the limit", async () => {
    await createMonthlyPlan(args());
    const slots = parseContentPlanData((await planRow())!.data).slots;
    const written = slots[0]!;
    await prisma.creativeVersion.create({
      data: { creativeId: written.creativeId, version: 1, copy: "The article text" },
    });
    await prisma.creative.update({ where: { id: written.creativeId }, data: { status: "APPROVED" } });

    const result = await regenerateContentPlan({
      projectId: fixture.projectId,
      userId: "u1",
      now: NOW,
      trigger: "manual",
    });
    expect(result.ok).toBe(true);
    const data = parseContentPlanData((await planRow())!.data);
    expect(data.slots.find((slot) => slot.id === written.id)!.status).toBe("PLANNED");
    const creative = await prisma.creative.findUniqueOrThrow({ where: { id: written.creativeId } });
    expect(creative.status).toBe("APPROVED");
    expect((await liveSeoCreatives()).length).toBeLessThanOrEqual(4);
    expect((await planRow())!.regenerations).toBe(1);
  });
});
