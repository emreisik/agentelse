import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import type { GscSiteLink, Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { disconnectGoogleCredential } from "@/server/integrations/google-disconnect";
import {
  placeSeoArticle,
  SeoMonthlyCapError,
} from "@/server/modules/seo/calendar";
import { deleteGscDataForProject } from "@/server/seo/sync/links";
import { describeIntegration } from "@/test-support/integration-suite";

import { SeoContentPlanRetention } from "./retention";
import {
  countSeoPiecesInMonth,
  createSlotPiecesInTx,
  type SlotPieceRef,
} from "./pieces";

// Aylık SEO planı yaşam döngüsü gerçek Postgres'e karşı (yalnız CI ve yerel
// tek kullanımlık veritabanı; mock kipte Google'a, siteye ya da OpenAI'ye
// gidilmez). Plan satırı ve slot parçaları W3 motoru çalıştırılmadan tohumlanır
// (planlayıcının kendi testi planner.integration.test.ts'te): burada kanıtlanan
// yerleştirme + sınır + silme yoludur: slot tüketimi (tek parça, APPROVED, sürüm
// 1, planId = commandId, ay sayısı büyümez); slotsuz makale sınırda
// SeoMonthlyCapError ile reddedilir ve hiçbir şey yazılmaz; capExempt çalışır;
// SeoContentSetting'te sınırı yükseltmek yeniden izin verir; "Delete stored
// data", Disconnect ve 14 aylık saklama dokunulmamış slot parçalarını ve plana
// ait fikirleri KALICI siler, yazılmış makaleyi korur, plan satırlarını siler ve
// SeoContentSetting'i bırakır. Sınır değişmezi (ay sayısı <= sınır) her planlama
// ve yerleştirme adımından sonra denetlenir (takvimden sürükleme kapsam dışı).
// Silme yolları google-disconnect.ts / sync/links.ts / retention.ts'teki
// forgetSeoContentPlansFor* çağrılarına (paylaşılan düzenlemeler) dayanır.

const NOW = new Date("2026-10-07T12:00:00.000Z");
const MONTH = "2026-10";
const TIMEZONE = "UTC";
const PLAN_URL = "https://app.example.com/projects/p/arama#content-plan";

const ARTICLE = {
  title: "How to choose running shoes",
  metaDescription: "Pick running shoes that fit.",
  markdown: "Intro.\n\n## Section",
  writtenAt: "2026-10-05T09:00:00.000Z",
  rewrites: 0,
};

type SeededSlot = {
  slotId: string;
  ideaId: string;
  creativeId: string;
  postId: string;
};

describeIntegration("SEO content plan lifecycle (mock providers)", () => {
  const runId = randomUUID().slice(0, 8);
  const saved = {
    plan: process.env.SEO_CONTENT_PLAN,
    sync: process.env.GSC_SYNC,
    insights: process.env.SEO_INSIGHTS,
    page: process.env.GSC_SEARCH_PAGE,
    rollout: process.env.GSC_ROLLOUT_PROJECTS,
    provider: process.env.AGENTELSE_PROVIDER_MODE,
    reasoning: process.env.AGENTELSE_REASONING_MODE,
  };
  let fixture: AgencyFixture;
  let credentialId: string;
  let link: GscSiteLink;
  let commandCounter = 0;

  const scope = () => ({
    workspaceId: fixture.workspaceId,
    projectId: fixture.projectId,
    brandId: fixture.brandId,
  });

  function place(
    extra: Partial<Parameters<typeof placeSeoArticle>[0]> & {
      when?: string;
    } = {},
  ) {
    commandCounter += 1;
    return placeSeoArticle({
      scope: scope(),
      userId: "user-1",
      commandId: `cmd-${runId}-${commandCounter}`,
      workId: null,
      timezone: TIMEZONE,
      when: "2026-10-14T10:00",
      article: ARTICLE,
      ...extra,
    });
  }

  async function seedLink(): Promise<GscSiteLink> {
    return prisma.gscSiteLink.create({
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
        lastWeeklyWeek: "2026-09-28",
        lastFinalDate: "2026-10-04",
      },
    });
  }

  // Plan satırı + slot başına fikir (PLANNING), Post ve DRAFT Creative.
  async function seedPlan(
    options: {
      month?: string;
      days?: number[];
      slotStatuses?: ("PLANNED" | "SKIPPED" | "REMOVED")[];
    } = {},
  ): Promise<{ planId: string; slots: SeededSlot[] }> {
    const month = options.month ?? MONTH;
    const days = options.days ?? [8, 14, 20];
    const slots: SeededSlot[] = [];
    const data = await prisma.$transaction(async (tx) => {
      const rows: Record<string, unknown>[] = [];
      for (const [index, day] of days.entries()) {
        const keyword = `keyword ${runId} ${month} ${index + 1}`;
        const idea = await tx.idea.create({
          data: {
            workspaceId: fixture.workspaceId,
            projectId: fixture.projectId,
            brandId: fixture.brandId,
            title: `Article ${index + 1}`,
            description: "A planned article.",
            status: "PLANNING",
            isMock: true,
            concept: {
              v: 1,
              module: "seo",
              source: "search",
              why: "Searched often, and no page on your site answers it yet.",
              strength: 3,
              evidence: [{ title: "This month's articles", url: PLAN_URL }],
              draft: { keyword },
            },
          },
        });
        const refs: SlotPieceRef[] = await createSlotPiecesInTx(
          tx,
          scope(),
          {
            timezone: TIMEZONE,
            items: [
              {
                date: `${month}-${String(day).padStart(2, "0")}`,
                time: "10:00",
                title: `Article ${index + 1}`,
                brief: "Planned SEO article.",
                ideaId: idea.id,
              },
            ],
          },
        );
        const ref = refs[0]!;
        slots.push({
          slotId: `s${index + 1}`,
          ideaId: idea.id,
          creativeId: ref.creativeId,
          postId: ref.postId,
        });
        rows.push({
          id: `s${index + 1}`,
          status: options.slotStatuses?.[index] ?? "PLANNED",
          kind: "SUPPORT",
          clusterId: null,
          clusterName: null,
          keyword,
          queries: [],
          intent: "informational",
          impressions: 100,
          share: 0.1,
          position: null,
          gap: "NO_PAGE",
          rising: false,
          findingId: null,
          title: `Article ${index + 1}`,
          angle: "",
          description: "",
          date: `${month}-${String(day).padStart(2, "0")}`,
          time: "10:00",
          creativeId: ref.creativeId,
          postId: ref.postId,
          ideaId: idea.id,
          prevIdeaStatus: null,
          linkFrom: [],
          linkTo: [],
          linksVerified: false,
          reusedIdea: false,
        });
      }
      return {
        v: 1,
        slots: rows,
        nextSlot: rows.length + 1,
        rejected: [],
        reason: null,
        notes: [],
        pillars: [],
        totals: { nonBrandImpressions: 1000 },
        considered: rows.length,
        filtered: [],
        checkedAt: NOW.toISOString(),
        regeneratedAt: null,
        wordingNote: null,
      };
    });
    const plan = await prisma.seoContentPlan.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        linkId: link.id,
        isMock: true,
        month,
        status: "ACTIVE",
        cap: 4,
        existingAtPlan: 0,
        basedOnWeek: "2026-09-28",
        wording: "BASIC",
        data: data as Prisma.InputJsonValue,
      },
    });
    return { planId: plan.id, slots };
  }

  async function seoCreatives() {
    return prisma.creative.findMany({
      where: { projectId: fixture.projectId, formatKey: "seo.article" },
      include: { versions: true },
    });
  }

  async function monthCount(): Promise<number> {
    return countSeoPiecesInMonth(prisma, {
      projectId: fixture.projectId,
      month: MONTH,
      timezone: TIMEZONE,
    });
  }

  async function currentCap(): Promise<number> {
    const row = await prisma.seoContentSetting.findUnique({
      where: { projectId: fixture.projectId },
    });
    return row?.monthlyCap ?? 4;
  }

  async function resetProject() {
    await prisma.creativeVersion.deleteMany({
      where: { creative: { projectId: fixture.projectId } },
    });
    await prisma.creative.deleteMany({
      where: { projectId: fixture.projectId },
    });
    await prisma.post.deleteMany({ where: { projectId: fixture.projectId } });
    await prisma.idea.deleteMany({ where: { projectId: fixture.projectId } });
    await prisma.seoContentPlan.deleteMany({
      where: { projectId: fixture.projectId },
    });
    await prisma.seoContentSetting.deleteMany({
      where: { projectId: fixture.projectId },
    });
  }

  beforeAll(async () => {
    process.env.SEO_CONTENT_PLAN = "true";
    process.env.GSC_SYNC = "true";
    process.env.SEO_INSIGHTS = "on";
    process.env.GSC_SEARCH_PAGE = "true";
    delete process.env.GSC_ROLLOUT_PROJECTS;
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

  afterEach(async () => {
    await resetProject();
  });

  afterAll(async () => {
    for (const [key, value] of Object.entries({
      SEO_CONTENT_PLAN: saved.plan,
      GSC_SYNC: saved.sync,
      SEO_INSIGHTS: saved.insights,
      GSC_SEARCH_PAGE: saved.page,
      GSC_ROLLOUT_PROJECTS: saved.rollout,
      AGENTELSE_PROVIDER_MODE: saved.provider,
      AGENTELSE_REASONING_MODE: saved.reasoning,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (!fixture) return;
    await resetProject();
    await prisma.gscSiteLink.deleteMany({
      where: { projectId: fixture.projectId },
    });
    await prisma.integrationCredential.deleteMany({
      where: { workspaceId: fixture.workspaceId },
    });
    await prisma.post.deleteMany({
      where: { workspaceId: fixture.workspaceId },
    });
    await teardownAgencyFixture(fixture.workspaceId);
  });

  it("consumes the slot: one piece, APPROVED, version 1, planId = commandId, month count unchanged", async () => {
    const { slots } = await seedPlan();
    const before = await monthCount();
    expect(before).toBe(3);
    expect(before).toBeLessThanOrEqual(await currentCap());

    const target = slots[1]!;
    const commandId = `cmd-consume-${runId}`;
    const placed = await place({
      commandId,
      ideaId: target.ideaId,
      workId: null,
      when: "2026-10-16T10:00",
    });
    expect(placed.reused).toBe(false);
    expect(placed.creativeId).toBe(target.creativeId);
    expect(placed.postId).toBe(target.postId);

    const creatives = await seoCreatives();
    expect(creatives).toHaveLength(3);
    const consumed = creatives.find((row) => row.id === target.creativeId)!;
    expect(consumed.status).toBe("APPROVED");
    expect(consumed.planId).toBe(commandId);
    expect(consumed.versions).toHaveLength(1);
    expect(consumed.versions[0]?.version).toBe(1);
    expect(consumed.currentVersionId).toBe(consumed.versions[0]?.id);
    // Planlı gün kullanıcının seçtiği güne taşındı.
    expect(consumed.scheduledFor?.toISOString()).toBe(
      "2026-10-16T10:00:00.000Z",
    );
    const post = await prisma.post.findUniqueOrThrow({
      where: { id: target.postId },
    });
    expect(post.planId).toBe(commandId);
    expect(post.approvedAt).not.toBeNull();
    // Dokunulmamış öteki slotlar DRAFT, planId'siz kalır.
    for (const other of [slots[0]!, slots[2]!]) {
      const row = creatives.find((creative) => creative.id === other.creativeId)!;
      expect(row.status).toBe("DRAFT");
      expect(row.planId).toBeNull();
      expect(row.versions).toHaveLength(0);
    }
    // Ay sayısı büyümedi ve sınırı aşmadı.
    expect(await monthCount()).toBe(before);
    expect(await monthCount()).toBeLessThanOrEqual(await currentCap());

    // Aynı commandId tekrarı: aynı parça, yeni sürüm yok.
    const again = await place({ commandId, ideaId: target.ideaId });
    expect(again.reused).toBe(true);
    expect(again.creativeId).toBe(target.creativeId);
    expect(
      await prisma.creativeVersion.count({
        where: { creativeId: target.creativeId },
      }),
    ).toBe(1);
  }, 60_000);

  it("refuses a slot-less article at the cap, writes nothing, then capExempt and a raised cap allow it", async () => {
    await seedPlan({ days: [8, 10, 14, 20] });
    expect(await monthCount()).toBe(4);
    const creativesBefore = await seoCreatives();
    const postsBefore = await prisma.post.count({
      where: { projectId: fixture.projectId },
    });

    await expect(place()).rejects.toBeInstanceOf(SeoMonthlyCapError);
    // Hiçbir şey yazılmadı (işlem geri alındı).
    expect(await seoCreatives()).toHaveLength(creativesBefore.length);
    expect(
      await prisma.post.count({ where: { projectId: fixture.projectId } }),
    ).toBe(postsBefore);
    expect(await prisma.creativeVersion.count({
      where: { creative: { projectId: fixture.projectId } },
    })).toBe(0);
    // Reddedilen yerleştirme denetim satırı bırakır (geri alma sonrası).
    expect(
      await prisma.auditLog.count({
        where: {
          projectId: fixture.projectId,
          action: "seo_content_plan.cap_blocked",
        },
      }),
    ).toBeGreaterThanOrEqual(1);
    expect(await monthCount()).toBeLessThanOrEqual(await currentCap());

    // "Mark as published": sınırdan muaf.
    const exempt = await place({ capExempt: true });
    expect(exempt.reused).toBe(false);
    expect(await monthCount()).toBe(5);

    // Sınırı yükseltmek yeniden izin verir.
    await prisma.seoContentSetting.upsert({
      where: { projectId: fixture.projectId },
      create: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        monthlyCap: 6,
        autoPlan: true,
      },
      update: { monthlyCap: 6 },
    });
    const allowed = await place();
    expect(allowed.reused).toBe(false);
    expect(await monthCount()).toBe(6);
    // Altıncıdan sonra bir yenisi yine reddedilir.
    await expect(place()).rejects.toBeInstanceOf(SeoMonthlyCapError);
  }, 60_000);

  it("a slot in its own month is consumed even after the limit was lowered below the slot count", async () => {
    const { slots } = await seedPlan({ days: [8, 10, 14, 20] });
    await prisma.seoContentSetting.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        monthlyCap: 2,
        autoPlan: true,
      },
    });
    const placed = await place({
      ideaId: slots[3]!.ideaId,
      when: "2026-10-20T10:00",
    });
    expect(placed.creativeId).toBe(slots[3]!.creativeId);
    // Başka aya taşınmış tüketim o ayın sınırına tabidir (boş ay: izin).
    const moved = await place({
      ideaId: slots[0]!.ideaId,
      when: "2026-11-05T10:00",
    });
    expect(moved.creativeId).toBe(slots[0]!.creativeId);
  }, 60_000);

  it("'Delete stored data' hard-deletes untouched slots and plan ideas, keeps the written article and the setting", async () => {
    const { slots } = await seedPlan({
      days: [8, 14, 20],
      slotStatuses: ["PLANNED", "PLANNED", "SKIPPED"],
    });
    // Skip, parçayı arşivler (Creative ARCHIVED, Post.archivedAt): silme onu da kapsamalı.
    await prisma.creative.update({
      where: { id: slots[2]!.creativeId },
      data: { status: "ARCHIVED" },
    });
    await prisma.post.update({
      where: { id: slots[2]!.postId },
      data: { archivedAt: NOW },
    });
    await prisma.seoContentSetting.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        monthlyCap: 5,
        autoPlan: true,
      },
    });
    const written = slots[1]!;
    await place({ ideaId: written.ideaId, when: "2026-10-14T10:00" });

    await deleteGscDataForProject(fixture.projectId, NOW);

    expect(
      await prisma.seoContentPlan.count({
        where: { projectId: fixture.projectId },
      }),
    ).toBe(0);
    const rest = await seoCreatives();
    expect(rest.map((row) => row.id)).toEqual([written.creativeId]);
    expect(rest[0]?.status).toBe("APPROVED");
    expect(rest[0]?.versions).toHaveLength(1);
    // Silinen slotların Post'ları da gitti; yazılmış makalenin Post'u kaldı.
    const posts = await prisma.post.findMany({
      where: { projectId: fixture.projectId },
      select: { id: true },
    });
    expect(posts.map((post) => post.id)).toEqual([written.postId]);
    // Plana ait fikirler silindi; yazılmış makaleye bağlı fikir kaldı ve yalnız
    // plan kanıtını kaybetti.
    const ideas = await prisma.idea.findMany({
      where: { projectId: fixture.projectId },
    });
    expect(ideas.map((idea) => idea.id)).toEqual([written.ideaId]);
    expect(
      (ideas[0]?.concept as { evidence?: unknown[] } | null)?.evidence,
    ).toEqual([]);
    // Sınır ayarı Google verisi değildir: kalır.
    expect(
      await prisma.seoContentSetting.count({
        where: { projectId: fixture.projectId },
      }),
    ).toBe(1);

    // "Delete stored data" bağları sildi; Disconnect testi için yeniden tohumla.
    await prisma.gscSiteLink.deleteMany({
      where: { projectId: fixture.projectId },
    });
    link = await seedLink();
  }, 120_000);

  it("Disconnect hard-deletes untouched slots and ideas, keeps the written article and deletes the plan rows", async () => {
    const { slots } = await seedPlan({ days: [8, 14, 20] });
    await prisma.seoContentSetting.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        monthlyCap: 3,
        autoPlan: false,
      },
    });
    const written = slots[0]!;
    await place({ ideaId: written.ideaId, when: "2026-10-08T10:00" });
    expect(await monthCount()).toBeLessThanOrEqual(await currentCap());

    const credential = await prisma.integrationCredential.findUniqueOrThrow({
      where: { id: credentialId },
    });
    await disconnectGoogleCredential({ ...credential, metadata: {} });

    expect(
      await prisma.seoContentPlan.count({
        where: { projectId: fixture.projectId },
      }),
    ).toBe(0);
    const rest = await seoCreatives();
    expect(rest.map((row) => row.id)).toEqual([written.creativeId]);
    expect(
      (
        await prisma.idea.findMany({ where: { projectId: fixture.projectId } })
      ).map((idea) => idea.id),
    ).toEqual([written.ideaId]);
    expect(
      await prisma.seoContentSetting.count({
        where: { projectId: fixture.projectId },
      }),
    ).toBe(1);

    link = await seedLink();
  }, 120_000);

  it("14-month retention forgets old plans first (slots and ideas) and keeps recent ones", async () => {
    const old = await seedPlan({ month: "2025-01", days: [8, 14] });
    const recent = await seedPlan({ month: MONTH, days: [20] });
    await prisma.systemHeartbeat.deleteMany({
      where: { key: "seo.content-plan-retention" },
    });

    expect(await SeoContentPlanRetention.runDue(NOW)).toBeGreaterThanOrEqual(1);

    expect(
      await prisma.seoContentPlan.findUnique({ where: { id: old.planId } }),
    ).toBeNull();
    expect(
      await prisma.seoContentPlan.findUnique({ where: { id: recent.planId } }),
    ).not.toBeNull();
    const left = (await seoCreatives()).map((row) => row.id);
    expect(left).toEqual([recent.slots[0]!.creativeId]);
    expect(
      (
        await prisma.idea.findMany({ where: { projectId: fixture.projectId } })
      ).map((idea) => idea.id),
    ).toEqual([recent.slots[0]!.ideaId]);
  }, 60_000);
});
