import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { prisma } from "@/lib/prisma";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { connectWordPress } from "@/server/integrations/wordpress/connect";
import {
  createWordPressClient,
  type WordPressClient,
} from "@/server/integrations/wordpress/client";
import {
  createMockWpTransport,
  mockWpCalls,
  resetMockWordPress,
} from "@/server/integrations/wordpress/mock-site";
import { ApprovalRepository } from "@/server/repositories/approval.repository";
import { checkSiteVerification } from "@/server/seo/site/verify";
import { describeIntegration } from "@/test-support/integration-suite";

import { SeoApply } from "./seo-apply";

// SC-F8 uygulama motoru gerçek Postgres'e karşı (yalnız CI ve yerel tek
// kullanımlık veritabanı; mock modda hiçbir WordPress ya da IndexNow isteği
// süreçten çıkmaz, WordPress bellek içi sahte sitedir). Kanıtlar:
//  - öneri Task + Approval kurar ve siteye SIFIR yazma yapar;
//  - ApprovalRepository.decide (OWNER) + SeoApply.onTaskApproved sonrası değişiklik
//    VERIFIED olur, Task COMPLETED, denetim kayıtları yalnız izinli anahtar taşır;
//  - makale -> yayına al (ikinci onay) -> yayından kaldır -> makaleyi geri al:
//    taslak yazılır, herkese açılır, taslağa döner, Çöp Kutusu'na gider;
//  - TITLE_META ve INTERNAL_LINKS geri alınınca sayfa önceki hâline döner.
// Üye/Telegram onay engeli ve dispatch kancası kabuk testlerindedir; burada
// karar OWNER ile verilip kanca elle çağrılır.

const FLAG_KEYS = [
  "SEO_APPLY",
  "SEO_HEALTH",
  "SEO_ACTIONS",
  "SEO_INDEXNOW",
  "AGENTELSE_PROVIDER_MODE",
  "META_TOKEN_KEYS",
] as const;
const HOST = "example.com";
const ORIGIN = `https://${HOST}`;
const AUDIT_KEYS = new Set([
  "changeId",
  "kind",
  "source",
  "code",
  "dailyLimit",
]);

describeIntegration("SC-F8 apply engine (mock WordPress)", () => {
  const runId = randomUUID().slice(0, 8);
  const saved: Partial<Record<(typeof FLAG_KEYS)[number], string>> = {};
  let fixture: AgencyFixture;
  let ownerId = "";
  let memberId = "";
  let userIds: string[] = [];
  let reader: WordPressClient;

  async function writesOnSite(): Promise<number> {
    return mockWpCalls().filter(
      (call) => call.method === "POST" || call.method === "DELETE",
    ).length;
  }

  async function changeOf(changeId: string) {
    return prisma.seoChange.findUniqueOrThrow({ where: { id: changeId } });
  }

  // Öneriyi onaylar (OWNER) ve işçinin onay kancasını çağırır.
  async function approveAndApply(changeId: string): Promise<void> {
    const change = await changeOf(changeId);
    if (!change.approvalId || !change.taskId) {
      throw new Error("change has no approval or task");
    }
    await ApprovalRepository.decide(
      change.approvalId,
      fixture.projectId,
      "APPROVED",
      ownerId,
    );
    await SeoApply.onTaskApproved({
      id: change.taskId,
      projectId: fixture.projectId,
      workspaceId: fixture.workspaceId,
    });
  }

  async function mustPropose(
    input:
      | {
          kind: "TITLE_META";
          url: string;
          title: string;
          metaDescription: string;
        }
      | {
          kind: "INTERNAL_LINKS";
          url: string;
          links: { toUrl: string; anchor: string }[];
        }
      | { kind: "PUBLISH_ARTICLE"; creativeId: string }
      | { kind: "PUBLISH_LIVE"; draftChangeId: string },
  ): Promise<string> {
    const result = await SeoApply.propose({
      projectId: fixture.projectId,
      userId: ownerId,
      ...input,
    });
    if (!result.ok) throw new Error(`propose refused: ${result.code}`);
    expect(result.status).toBe("PROPOSED");
    return result.changeId;
  }

  beforeAll(async () => {
    for (const key of FLAG_KEYS) saved[key] = process.env[key];
    process.env.AGENTELSE_PROVIDER_MODE = "mock";
    process.env.SEO_HEALTH = "true";
    process.env.SEO_APPLY = "true";
    delete process.env.SEO_ACTIONS;
    delete process.env.SEO_INDEXNOW;
    process.env.META_TOKEN_KEYS = `it:${"ab".repeat(32)}`;
    resetMockWordPress();

    fixture = await createAgencyFixture(`seo-apply-${runId}`);
    const owner = await prisma.user.create({
      data: { email: `owner-seo-apply-${runId}@example.com`, name: "Owner" },
    });
    const member = await prisma.user.create({
      data: { email: `member-seo-apply-${runId}@example.com`, name: "Member" },
    });
    ownerId = owner.id;
    memberId = member.id;
    userIds = [owner.id, member.id];
    await prisma.workspaceMember.createMany({
      data: [
        { workspaceId: fixture.workspaceId, userId: owner.id, role: "OWNER" },
        { workspaceId: fixture.workspaceId, userId: member.id, role: "MEMBER" },
      ],
    });
    await prisma.project.update({
      where: { id: fixture.projectId },
      data: { domain: HOST, status: "ACTIVE" },
    });
    // Mock modda alan adı doğrulaması (SC-F3) ağsız geçer; kapsam anahtarı buradan gelir.
    const verified = await checkSiteVerification(
      fixture.projectId,
      {},
      new Date(),
    );
    expect(verified).toEqual({ ok: true, method: "MOCK" });

    const connected = await connectWordPress({
      projectId: fixture.projectId,
      workspaceId: fixture.workspaceId,
      brandId: fixture.brandId,
      userId: ownerId,
      siteUrl: ORIGIN,
      username: "agentelse",
      appPassword: "abcdefghijklmnopqrstuvwx",
    });
    if (!connected.ok) throw new Error(`connect failed: ${connected.code}`);

    reader = createWordPressClient({
      origin: ORIGIN,
      restMode: "pretty",
      credentials: {
        username: "agentelse",
        appPassword: "abcd efgh ijkl mnop qrst uvwx",
      },
      transport: createMockWpTransport(),
      pace: async () => undefined,
    });
  }, 60_000);

  beforeEach(() => {
    // Çağrı günlüğü ve sahte sitenin içeriği her testte sıfırlanır (kimlik bilgisi
    // ve CmsSite veritabanında kalır).
    resetMockWordPress();
  });

  afterAll(async () => {
    const site = await prisma.cmsSite.findFirst({
      where: { projectId: fixture?.projectId },
      select: { id: true },
    });
    if (site) await prisma.cmsSite.deleteMany({ where: { id: site.id } });
    if (fixture) {
      await prisma.seoApplySetting.deleteMany({
        where: { projectId: fixture.projectId },
      });
      await prisma.integrationCredential.deleteMany({
        where: { workspaceId: fixture.workspaceId },
      });
      await prisma.gscSiteLink.deleteMany({
        where: { projectId: fixture.projectId },
      });
      await prisma.seoSite.deleteMany({
        where: { projectId: fixture.projectId },
      });
      await teardownAgencyFixture(fixture.workspaceId);
    }
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    for (const key of FLAG_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }, 60_000);

  it("proposes without writing, applies after the owner decides, then undoes TITLE_META", async () => {
    const changeId = await mustPropose({
      kind: "TITLE_META",
      url: `${ORIGIN}/about`,
      title: "About our small team",
      metaDescription: "Meet the small team behind tools for local businesses.",
    });

    // Önerinin kendisi siteye hiçbir şey yazmaz.
    expect(await writesOnSite()).toBe(0);
    const proposed = await changeOf(changeId);
    expect(proposed.status).toBe("PROPOSED");
    const task = await prisma.task.findUniqueOrThrow({
      where: { id: proposed.taskId! },
    });
    expect(task).toMatchObject({
      capability: "WEBSITE_UPDATE",
      status: "WAITING_APPROVAL",
      requiresApproval: true,
    });
    const approval = await prisma.approval.findUniqueOrThrow({
      where: { id: proposed.approvalId! },
    });
    expect(approval).toMatchObject({
      type: "CRITICAL_CHANGE_APPROVAL",
      status: "PENDING",
      entityType: "Task",
    });
    // Onay süresi ile değişiklik süresi aynı değerdir.
    expect(approval.expiresAt?.getTime()).toBe(proposed.expiresAt.getTime());

    // Onay verilmeden uygulama hiçbir şey yazmaz.
    await SeoApply.runDue(5);
    expect(await writesOnSite()).toBe(0);
    expect((await changeOf(changeId)).status).toBe("PROPOSED");

    const before = (await reader.getObject("page", 102))!;
    await approveAndApply(changeId);

    const applied = await changeOf(changeId);
    expect(applied.status).toBe("VERIFIED");
    expect(applied.noop).toBe(false);
    expect(applied.approvedByUserId).toBe(ownerId);
    expect(applied.appliedAt).not.toBeNull();
    expect(applied.openKey).toBeNull();
    expect(
      (await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).status,
    ).toBe("COMPLETED");
    const live = (await reader.getObject("page", 102))!;
    expect(live.meta["_yoast_wpseo_title"]).toBe("About our small team");
    expect(live.meta["_yoast_wpseo_metadesc"]).toBe(
      "Meet the small team behind tools for local businesses.",
    );

    // Üye geri alamaz; OWNER geri alır.
    const denied = await SeoApply.undo({
      projectId: fixture.projectId,
      changeId,
      userId: memberId,
    });
    expect(denied.ok).toBe(false);
    expect((await changeOf(changeId)).status).toBe("VERIFIED");

    const undone = await SeoApply.undo({
      projectId: fixture.projectId,
      changeId,
      userId: ownerId,
    });
    expect(undone).toEqual({ ok: true });
    const row = await changeOf(changeId);
    expect(row.status).toBe("UNDONE");
    expect(row.undoneByUserId).toBe(ownerId);
    const restored = (await reader.getObject("page", 102))!;
    expect(restored.meta["_yoast_wpseo_title"]).toBe(
      before.meta["_yoast_wpseo_title"],
    );
    expect(restored.meta["_yoast_wpseo_metadesc"]).toBe(
      before.meta["_yoast_wpseo_metadesc"],
    );

    // Denetim kayıtları yalnız izinli anahtarları taşır.
    const audits = await prisma.auditLog.findMany({
      where: {
        projectId: fixture.projectId,
        action: { startsWith: "seo_change." },
      },
    });
    expect(audits.length).toBeGreaterThan(0);
    for (const audit of audits) {
      const metadata = (audit.metadata ?? {}) as Record<string, unknown>;
      for (const key of Object.keys(metadata)) {
        expect(AUDIT_KEYS.has(key)).toBe(true);
      }
    }
  });

  it("INTERNAL_LINKS: inserts the link after approval and restores the content on undo", async () => {
    const original = (await reader.getObject("page", 101))!.content;
    const changeId = await mustPropose({
      kind: "INTERNAL_LINKS",
      url: `${ORIGIN}/pricing`,
      links: [{ toUrl: `${ORIGIN}/about`, anchor: "pricing plans" }],
    });
    expect(await writesOnSite()).toBe(0);

    await approveAndApply(changeId);

    expect((await changeOf(changeId)).status).toBe("VERIFIED");
    expect((await reader.getObject("page", 101))!.content).toContain(
      `<a href="${ORIGIN}/about">pricing plans</a>`,
    );

    const undone = await SeoApply.undo({
      projectId: fixture.projectId,
      changeId,
      userId: ownerId,
    });
    expect(undone).toEqual({ ok: true });
    expect((await reader.getObject("page", 101))!.content).toBe(original);
    expect((await changeOf(changeId)).status).toBe("UNDONE");
  });

  it("article: draft -> make live (second approval) -> undo live -> undo article (Trash)", async () => {
    const sentence =
      "Small teams win with simple, repeatable marketing steps that they can run every single week. ";
    const creative = await prisma.creative.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        brandId: fixture.brandId,
        type: "COPY",
        channel: "seo",
        formatKey: "seo.article",
        title: "Weekly marketing for small teams",
        status: "APPROVED",
      },
    });
    const version = await prisma.creativeVersion.create({
      data: {
        creativeId: creative.id,
        version: 1,
        copy: `## Start small\n\n${sentence.repeat(14)}\n\n## Keep going\n\n${sentence.repeat(6)}`,
        generationMetadata: {
          title: "Weekly marketing for small teams",
          metaDescription: "Simple weekly steps for small local teams.",
          language: "en",
        },
      },
    });
    await prisma.creative.update({
      where: { id: creative.id },
      data: { currentVersionId: version.id },
    });

    const draftChangeId = await mustPropose({
      kind: "PUBLISH_ARTICLE",
      creativeId: creative.id,
    });
    expect(await writesOnSite()).toBe(0);
    await approveAndApply(draftChangeId);

    const draft = await changeOf(draftChangeId);
    expect(draft.status).toBe("VERIFIED");
    expect(draft.noop).toBe(false);
    expect(draft.creativeId).toBe(creative.id);
    expect(draft.wpId).not.toBeNull();
    // Taslak herkese açık değildir ve yalnız bir yazma yapıldı.
    expect((await reader.getObject("post", draft.wpId!))!.status).toBe("draft");
    expect(mockWpCalls().filter((call) => call.method === "POST").length).toBe(
      1,
    );

    const liveChangeId = await mustPropose({
      kind: "PUBLISH_LIVE",
      draftChangeId,
    });
    expect((await reader.getObject("post", draft.wpId!))!.status).toBe("draft");
    await approveAndApply(liveChangeId);

    const live = await changeOf(liveChangeId);
    expect(live.status).toBe("VERIFIED");
    expect(live.liveUrl).toContain(ORIGIN);
    expect((await reader.getObject("post", draft.wpId!))!.status).toBe(
      "publish",
    );
    // Zincir kuralı: taslak değişikliğin after görüntüsü yayını yansıtır.
    expect(
      ((await changeOf(draftChangeId)).after as { status: string }).status,
    ).toBe("publish");

    // Yayındayken makaleyi geri almak güvenli değildir.
    const early = await SeoApply.undo({
      projectId: fixture.projectId,
      changeId: draftChangeId,
      userId: ownerId,
    });
    expect(early.ok).toBe(false);

    const unpublished = await SeoApply.undo({
      projectId: fixture.projectId,
      changeId: liveChangeId,
      userId: ownerId,
    });
    expect(unpublished).toEqual({ ok: true });
    expect((await reader.getObject("post", draft.wpId!))!.status).toBe("draft");

    const trashed = await SeoApply.undo({
      projectId: fixture.projectId,
      changeId: draftChangeId,
      userId: ownerId,
    });
    expect(trashed).toEqual({ ok: true });
    expect((await reader.getObject("post", draft.wpId!))!.status).toBe("trash");
    expect((await changeOf(draftChangeId)).status).toBe("UNDONE");
    expect((await changeOf(liveChangeId)).status).toBe("UNDONE");
  });
});
