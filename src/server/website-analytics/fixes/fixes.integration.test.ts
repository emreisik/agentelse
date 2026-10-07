import { randomUUID } from "node:crypto";

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { applyApprovalDecision } from "@/server/commands/approval-decisions";
import {
  createMockGaAdminWriter,
  mockGaAdminCalls,
  resetMockGaAdmin,
} from "@/server/integrations/google-analytics/admin-write-mock";
import { disconnectGoogleCredential } from "@/server/integrations/google-disconnect";
import { SiteAlerts } from "@/server/monitoring/site-alerts";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { ApprovalRepository } from "@/server/repositories/approval.repository";
import { describeIntegration } from "@/test-support/integration-suite";

import { GaFixes } from "./fixes";

// GA-F7 yaşam döngüsü gerçek Postgres'e karşı (yalnız CI ve yerel tek
// kullanımlık veritabanı; mock modda Google'a hiç gidilmez, Analytics Admin
// istemcisi bellek içi mock'tur). Kanıtlar:
//  - öneri Task + Approval kurar ve Google'a SIFIR çağrı yapar;
//  - OWNER/ADMIN olmayan ve Telegram sözde kullanıcısı onaylayamaz; sıradan
//    (GA dışı) onaylar bu kapıdan etkilenmez;
//  - OWNER onaylayınca değişiklik VERIFIED, Task COMPLETED, link sütunu ve
//    sağlık yeniden kontrolü güncellenir, denetim kayıtları yalnız
//    {changeId, kind, source?, code?} taşır; ardından geri alma UNDONE;
//  - ret yolu (karar tablosu ve ApprovalRepository.decide doğrudan) ve hemen
//    ardından yeniden öneri taze satır açar;
//  - süre dolumu; süresi geçtikten sonra uygulanan ama süresinden önce verilmiş onay;
//  - iki eşzamanlı öneride tek açık satır (openKey);
//  - Disconnect GaConfigChange/GaChangeWatch/GA4 uyarılarını siler, Task ve
//    sohbet kartı metnini siler;
//  - paylaşılan veritabanındaki dev süreci izin listesi dışı projeyi reddeder.

const DAY = 24 * 3_600_000;
const FLAG_KEYS = [
  "GA_SYNC",
  "GA_FIXES",
  "GA_FIXES_ALPHA",
  "AGENTELSE_PROVIDER_MODE",
] as const;
const PROPERTY_ID = "424242";
const PROPERTY_NAME = "Acme Secret Property";
const SCRUBBED_TITLE = "Google Analytics change";

type TestProject = {
  fixture: AgencyFixture;
  credentialId: string;
  linkId: string;
  ownerId: string;
  memberId: string;
  userIds: string[];
};

describeIntegration("GA-F7 fix lifecycle (mock Google)", () => {
  const runId = randomUUID().slice(0, 8);
  const saved: Partial<Record<(typeof FLAG_KEYS)[number], string>> = {};
  const projects: TestProject[] = [];
  let main: TestProject;

  async function createProject(label: string): Promise<TestProject> {
    const fixture = await createAgencyFixture(`gf-${label}-${runId}`);
    const owner = await prisma.user.create({
      data: { email: `owner-${label}-${runId}@example.com`, name: "Owner" },
    });
    const member = await prisma.user.create({
      data: { email: `member-${label}-${runId}@example.com`, name: "Member" },
    });
    await prisma.workspaceMember.createMany({
      data: [
        { workspaceId: fixture.workspaceId, userId: owner.id, role: "OWNER" },
        { workspaceId: fixture.workspaceId, userId: member.id, role: "MEMBER" },
      ],
    });
    const credential = await prisma.integrationCredential.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        brandId: fixture.brandId,
        provider: "google_analytics",
        accountLabel: "owner@example.com",
        encryptedSecret: "not-used-in-mock-mode",
        status: "ACTIVE",
        metadata: {
          ga4Properties: [
            {
              propertyId: PROPERTY_ID,
              propertyName: PROPERTY_NAME,
              accountName: "Acme",
            },
          ],
          selectedGa4PropertyId: PROPERTY_ID,
          selectedGa4PropertyName: PROPERTY_NAME,
        },
      },
    });
    const link = await prisma.gaPropertyLink.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        credentialId: credential.id,
        propertyId: PROPERTY_ID,
        propertyName: PROPERTY_NAME,
        accountId: "1111",
        isPrimary: true,
        isMock: true,
        timeZone: "Europe/Istanbul",
        serviceLevel: "GOOGLE_ANALYTICS_STANDARD",
        streamId: "1",
        keyEvents: [
          {
            eventName: "purchase",
            countingMethod: "ONCE_PER_EVENT",
            createTime: null,
          },
        ],
        dataRetention: "TWO_MONTHS",
      },
    });
    // apply, sağlık yeniden kontrolünü bu satıra yazar (updateMany).
    await prisma.gaHealthRun.create({
      data: {
        linkId: link.id,
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
      },
    });
    const project: TestProject = {
      fixture,
      credentialId: credential.id,
      linkId: link.id,
      ownerId: owner.id,
      memberId: member.id,
      userIds: [owner.id, member.id],
    };
    projects.push(project);
    return project;
  }

  async function removeProject(project: TestProject): Promise<void> {
    const { workspaceId, projectId } = project.fixture;
    await prisma.adsAlert.deleteMany({ where: { projectId } });
    await prisma.gaPropertyLink.deleteMany({ where: { projectId } });
    await prisma.integrationCredential.deleteMany({ where: { workspaceId } });
    await teardownAgencyFixture(workspaceId);
    await prisma.user.deleteMany({ where: { id: { in: project.userIds } } });
  }

  async function mustPropose(
    project: TestProject,
    eventName: string,
    kind: "KEY_EVENT_CREATE" | "RETENTION_14M" = "KEY_EVENT_CREATE",
  ) {
    const result = await GaFixes.propose({
      projectId: project.fixture.projectId,
      kind,
      raw: kind === "KEY_EVENT_CREATE" ? { eventName } : undefined,
      source: "PANEL",
      actor: { type: "USER", userId: project.ownerId },
    });
    if (!result.ok) throw new Error(`propose refused: ${result.code}`);
    return result;
  }

  async function changeOf(changeId: string) {
    return prisma.gaConfigChange.findUniqueOrThrow({ where: { id: changeId } });
  }

  async function approvalOfChange(changeId: string) {
    const change = await changeOf(changeId);
    if (!change.approvalId) throw new Error("change has no approval");
    return prisma.approval.findUniqueOrThrow({
      where: { id: change.approvalId },
    });
  }

  async function taskOfChange(changeId: string) {
    const change = await changeOf(changeId);
    if (!change.taskId) throw new Error("change has no task");
    return prisma.task.findUniqueOrThrow({ where: { id: change.taskId } });
  }

  async function decide(
    changeId: string,
    to: "APPROVED" | "REJECTED",
    userId: string,
  ): Promise<void> {
    const approval = await approvalOfChange(changeId);
    await applyApprovalDecision({
      approval,
      to,
      reviewedByUserId: userId,
      actorType: "USER",
    });
  }

  beforeAll(async () => {
    for (const key of FLAG_KEYS) saved[key] = process.env[key];
    process.env.GA_SYNC = "true";
    process.env.GA_FIXES = "true";
    process.env.GA_FIXES_ALPHA = "true";
    process.env.AGENTELSE_PROVIDER_MODE = "mock";
    main = await createProject("main");
  }, 60_000);

  beforeEach(() => {
    resetMockGaAdmin();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    for (const key of FLAG_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const project of projects) await removeProject(project);
  }, 60_000);

  it("proposes a change with a waiting Task and a pending approval and makes no Google call", async () => {
    const result = await mustPropose(main, "generate_lead");
    expect(result).toMatchObject({ created: true, status: "PROPOSED" });

    const change = await changeOf(result.changeId);
    expect(change).toMatchObject({
      kind: "KEY_EVENT_CREATE",
      status: "PROPOSED",
      source: "PANEL",
      dedupeKey: "KEY_EVENT_CREATE:generate_lead",
      openKey: "KEY_EVENT_CREATE:generate_lead",
      proposedByType: "USER",
      proposedByUserId: main.ownerId,
      noop: false,
      linkId: main.linkId,
    });

    const task = await taskOfChange(result.changeId);
    expect(task).toMatchObject({
      capability: "ANALYTICS_EDIT",
      status: "WAITING_APPROVAL",
      requiresApproval: true,
    });
    const approval = await approvalOfChange(result.changeId);
    expect(approval).toMatchObject({
      type: "CRITICAL_CHANGE_APPROVAL",
      status: "PENDING",
      entityType: "Task",
      entityId: task.id,
      taskId: task.id,
      level: "LEVEL_3_CLIENT",
    });
    const ttl = (approval.expiresAt?.getTime() ?? 0) - Date.now();
    expect(ttl).toBeGreaterThan(7 * DAY - 120_000);
    expect(ttl).toBeLessThanOrEqual(7 * DAY);

    // Property adı Task'a ve onay metnine girmez.
    expect(JSON.stringify(task)).not.toContain(PROPERTY_NAME);
    expect(JSON.stringify(task)).not.toContain(PROPERTY_ID);

    expect(mockGaAdminCalls()).toEqual([]);
  });

  it("refuses an approval from a plain member and from a Telegram pseudo user", async () => {
    const result = await mustPropose(main, "whatsapp_click");

    await expect(
      decide(result.changeId, "APPROVED", main.memberId),
    ).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    await expect(
      decide(result.changeId, "APPROVED", "telegram:123456"),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });

    expect((await approvalOfChange(result.changeId)).status).toBe("PENDING");
    expect((await changeOf(result.changeId)).status).toBe("PROPOSED");
    expect((await taskOfChange(result.changeId)).status).toBe(
      "WAITING_APPROVAL",
    );
    expect(mockGaAdminCalls()).toEqual([]);
  });

  it("does not gate ordinary approvals by workspace role", async () => {
    const generic = await ApprovalRepository.create({
      workspaceId: main.fixture.workspaceId,
      projectId: main.fixture.projectId,
      brandId: main.fixture.brandId,
      entityType: "Test",
      entityId: `generic-${runId}`,
      type: "GENERIC",
      requestedByType: "SYSTEM",
      notify: false,
    });
    // Üyesi olmayan bir kullanıcı da (eski davranış) sıradan onayı verebilir:
    // GA kapısı yalnız CRITICAL_CHANGE_APPROVAL için üyelik arar.
    const decided = await ApprovalRepository.decide(
      generic.id,
      main.fixture.projectId,
      "APPROVED",
      `stranger-${runId}`,
    );
    expect(decided.status).toBe("APPROVED");

    const critical = await mustPropose(main, "email_click");
    const approval = await approvalOfChange(critical.changeId);
    await expect(
      ApprovalRepository.decide(
        approval.id,
        main.fixture.projectId,
        "APPROVED",
        `stranger-${runId}`,
      ),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("applies after the owner approves, reads back, then undoes on request", async () => {
    const result = await mustPropose(main, "click_to_call");
    expect(mockGaAdminCalls()).toEqual([]);

    await decide(result.changeId, "APPROVED", main.ownerId);

    const verified = await changeOf(result.changeId);
    expect(verified).toMatchObject({
      status: "VERIFIED",
      openKey: null,
      noop: false,
      approvedByUserId: main.ownerId,
    });
    expect(verified.verifiedAt).not.toBeNull();
    expect(verified.resourceName).toMatch(/^properties\/424242\/keyEvents\//);
    expect(verified.after).toMatchObject({
      kind: "KEY_EVENT_CREATE",
      exists: true,
    });
    // Sıra: canlı okuma, yazma, canlı geri okuma.
    expect(mockGaAdminCalls()).toEqual([
      "listKeyEvents",
      "createKeyEvent",
      "listKeyEvents",
    ]);

    expect((await taskOfChange(result.changeId)).status).toBe("COMPLETED");
    const link = await prisma.gaPropertyLink.findUniqueOrThrow({
      where: { id: main.linkId },
    });
    const names = (link.keyEvents as { eventName: string }[]).map(
      (event) => event.eventName,
    );
    expect(names).toContain("click_to_call");
    const health = await prisma.gaHealthRun.findUniqueOrThrow({
      where: { linkId: main.linkId },
    });
    expect(health.recheckRequestedAt).not.toBeNull();

    const audit = await prisma.auditLog.findMany({
      where: { entityType: "GaConfigChange", entityId: result.changeId },
      orderBy: { createdAt: "asc" },
    });
    expect(audit.map((row) => row.action)).toEqual([
      "ga_config_change.proposed",
      "ga_config_change.approved",
      "ga_config_change.verified",
    ]);
    for (const row of audit) {
      const keys = Object.keys((row.metadata ?? {}) as Record<string, unknown>);
      for (const key of keys) {
        expect(["changeId", "kind", "source", "code"]).toContain(key);
      }
    }
    expect(JSON.stringify(audit)).not.toContain("click_to_call");

    // Geri alma: üye reddedilir (Google'a çağrı yok), OWNER'ın tıklaması işler.
    const callsBefore = mockGaAdminCalls().length;
    const refused = await GaFixes.undo({
      projectId: main.fixture.projectId,
      changeId: result.changeId,
      userId: main.memberId,
    });
    expect(refused.ok).toBe(false);
    expect(mockGaAdminCalls()).toHaveLength(callsBefore);
    expect((await changeOf(result.changeId)).status).toBe("VERIFIED");

    const undone = await GaFixes.undo({
      projectId: main.fixture.projectId,
      changeId: result.changeId,
      userId: main.ownerId,
    });
    expect(undone).toEqual({ ok: true });
    const after = await changeOf(result.changeId);
    expect(after).toMatchObject({
      status: "UNDONE",
      undoneByUserId: main.ownerId,
    });
    expect(after.rolledBackAt).not.toBeNull();
    const live = await createMockGaAdminWriter().listKeyEvents(PROPERTY_ID);
    expect(live.map((event) => event.eventName)).not.toContain("click_to_call");
    const undoAudit = await prisma.auditLog.findMany({
      where: {
        entityType: "GaConfigChange",
        entityId: result.changeId,
        action: "ga_config_change.undone",
      },
    });
    expect(undoAudit).toHaveLength(1);
  });

  it("closes the change when the approval is rejected, then lets a fresh one be proposed", async () => {
    const first = await mustPropose(main, "sign_up");
    // OWNER/ADMIN kapısı reddi de kapsar: üye reddedemez, karar bekler. Sahip
    // reddedince karar tablosu Task'ı iptal eder, satırı GaFixes hizalar.
    await expect(
      decide(first.changeId, "REJECTED", main.memberId),
    ).rejects.toThrow(/owner or admin/i);
    expect(await GaFixes.syncApprovalState(first.changeId)).toBe("PROPOSED");
    await decide(first.changeId, "REJECTED", main.ownerId);
    expect(await GaFixes.syncApprovalState(first.changeId)).toBe("REJECTED");
    expect(await changeOf(first.changeId)).toMatchObject({
      status: "REJECTED",
      openKey: null,
    });
    expect((await taskOfChange(first.changeId)).status).toBe("CANCELLED");

    // Doğrudan ApprovalRepository.decide: satır hâlâ PROPOSED, hemen yeniden öneri
    // eski satırı kapatıp taze bir değişiklik açar.
    const second = await mustPropose(main, "sign_up");
    expect(second.created).toBe(true);
    expect(second.changeId).not.toBe(first.changeId);
    const approval = await approvalOfChange(second.changeId);
    await ApprovalRepository.decide(
      approval.id,
      main.fixture.projectId,
      "REJECTED",
      main.ownerId,
    );
    expect((await changeOf(second.changeId)).status).toBe("PROPOSED");

    const third = await mustPropose(main, "sign_up");
    expect(third.created).toBe(true);
    expect(third.changeId).not.toBe(second.changeId);
    expect(await changeOf(second.changeId)).toMatchObject({
      status: "REJECTED",
      openKey: null,
    });
    expect(await changeOf(third.changeId)).toMatchObject({
      status: "PROPOSED",
      openKey: "KEY_EVENT_CREATE:sign_up",
    });
    expect((await approvalOfChange(third.changeId)).status).toBe("PENDING");
    expect(mockGaAdminCalls()).toEqual([]);
  });

  it("expires a proposal nobody decided in 7 days and cancels its approval and task", async () => {
    const result = await mustPropose(main, "newsletter_signup");
    const later = new Date(Date.now() + 8 * DAY);

    expect(await GaFixes.runDue(50, later)).toBeGreaterThan(0);

    expect(await changeOf(result.changeId)).toMatchObject({
      status: "EXPIRED",
      openKey: null,
    });
    expect((await approvalOfChange(result.changeId)).status).toBe("EXPIRED");
    expect((await taskOfChange(result.changeId)).status).toBe("CANCELLED");
    expect(mockGaAdminCalls()).toEqual([]);

    // Süresi dolan satır yeni öneriyi engellemez.
    const again = await mustPropose(main, "newsletter_signup");
    expect(again.created).toBe(true);
  });

  it("still applies an approval given before it expired, even after the proposal expiry", async () => {
    const result = await mustPropose(main, "book_demo");
    const approval = await approvalOfChange(result.changeId);
    // Karar süresinden önce verilir; GaFixes kancası atlanır (ör. kayıp süreç).
    await ApprovalRepository.decide(
      approval.id,
      main.fixture.projectId,
      "APPROVED",
      main.ownerId,
    );
    const past = new Date(Date.now() - 3_600_000);
    await prisma.approval.update({
      where: { id: approval.id },
      data: { expiresAt: past },
    });
    await prisma.gaConfigChange.update({
      where: { id: result.changeId },
      data: { expiresAt: past },
    });

    expect(await GaFixes.runDue(50, new Date())).toBeGreaterThan(0);

    const applied = await changeOf(result.changeId);
    expect(applied.status).toBe("VERIFIED");
    expect(mockGaAdminCalls()).toEqual([
      "listKeyEvents",
      "createKeyEvent",
      "listKeyEvents",
    ]);
    expect((await taskOfChange(result.changeId)).status).toBe("COMPLETED");
  });

  it("keeps a single open change under two concurrent proposals", async () => {
    const [a, b] = await Promise.all([
      mustPropose(main, "start_trial"),
      mustPropose(main, "start_trial"),
    ]);
    expect(a.changeId).toBe(b.changeId);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);

    const open = await prisma.gaConfigChange.findMany({
      where: { linkId: main.linkId, openKey: "KEY_EVENT_CREATE:start_trial" },
    });
    expect(open).toHaveLength(1);
    const tasks = await prisma.task.findMany({
      where: {
        projectId: main.fixture.projectId,
        capability: "ANALYTICS_EDIT",
        title: { contains: "start_trial" },
      },
    });
    expect(tasks).toHaveLength(1);
    expect(mockGaAdminCalls()).toEqual([]);
  });

  it("refuses a project outside the allow-list in a development process on a shared database", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@ep-live.neon.tech/db");
    vi.stubEnv("GA_SYNC_DEV_PROJECTS", `someone-else-${runId}`);
    const result = await GaFixes.propose({
      projectId: main.fixture.projectId,
      kind: "KEY_EVENT_CREATE",
      raw: { eventName: "dev_guard_probe" },
      source: "PANEL",
      actor: { type: "USER", userId: main.ownerId },
    });
    expect(result).toMatchObject({ ok: false, code: "not_enabled" });
    vi.unstubAllEnvs();
    expect(
      await prisma.gaConfigChange.count({
        where: {
          projectId: main.fixture.projectId,
          dedupeKey: "KEY_EVENT_CREATE:dev_guard_probe",
        },
      }),
    ).toBe(0);

    // İzin listesindeki proje serbest.
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@ep-live.neon.tech/db");
    vi.stubEnv("GA_SYNC_DEV_PROJECTS", main.fixture.projectId);
    const allowed = await GaFixes.propose({
      projectId: main.fixture.projectId,
      kind: "KEY_EVENT_CREATE",
      raw: { eventName: "dev_guard_probe" },
      source: "PANEL",
      actor: { type: "USER", userId: main.ownerId },
    });
    expect(allowed.ok).toBe(true);
  });

  it("deletes the records at Disconnect and scrubs the Task and chat card text", async () => {
    const project = await createProject("disc");
    const pending = await mustPropose(project, "generate_lead");
    const done = await mustPropose(project, "click_to_call");
    await decide(done.changeId, "APPROVED", project.ownerId);
    expect((await changeOf(done.changeId)).status).toBe("VERIFIED");

    await prisma.gaChangeWatch.create({
      data: {
        linkId: project.linkId,
        workspaceId: project.fixture.workspaceId,
        projectId: project.fixture.projectId,
      },
    });
    await SiteAlerts.raise({
      workspaceId: project.fixture.workspaceId,
      projectId: project.fixture.projectId,
      source: "GA4",
      kind: "GA_CHG_KEY_EVENT_REMOVED",
      severity: "WARN",
      dedupeKey: `ga4:${project.linkId}:CHG:KEY_EVENT_REMOVED:lead`,
      title: "A key event was removed in Google Analytics",
    });

    const pendingTask = await taskOfChange(pending.changeId);
    const doneTask = await taskOfChange(done.changeId);
    const approvalId = (await changeOf(pending.changeId)).approvalId;
    const doneApprovalId = (await changeOf(done.changeId)).approvalId;
    const cardsBefore = await prisma.command.findMany({
      where: {
        projectId: project.fixture.projectId,
        source: "SYSTEM",
        parsedIntent: { path: ["card", "taskId"], equals: pendingTask.id },
      },
    });
    // Onay kartı sohbete en iyi çabayla yazılır; yazıldıysa temizlenmeli.
    expect(cardsBefore.length).toBeGreaterThan(0);
    expect(JSON.stringify(cardsBefore)).toContain("generate_lead");

    const credential = await prisma.integrationCredential.findUniqueOrThrow({
      where: { id: project.credentialId },
      select: { id: true, encryptedSecret: true, metadata: true },
    });
    await disconnectGoogleCredential(credential);

    expect(
      await prisma.gaConfigChange.count({
        where: { projectId: project.fixture.projectId },
      }),
    ).toBe(0);
    expect(
      await prisma.gaChangeWatch.count({
        where: { projectId: project.fixture.projectId },
      }),
    ).toBe(0);
    expect(
      await prisma.adsAlert.count({
        where: { projectId: project.fixture.projectId, source: "GA4" },
      }),
    ).toBe(0);

    const tasks = await prisma.task.findMany({
      where: { id: { in: [pendingTask.id, doneTask.id] } },
    });
    expect(tasks).toHaveLength(2);
    for (const task of tasks) {
      expect(task).toMatchObject({
        title: SCRUBBED_TITLE,
        description: null,
        capability: "ANALYTICS_EDIT",
      });
      expect(task.payload).toEqual({});
    }
    expect(tasks.find((task) => task.id === pendingTask.id)?.status).toBe(
      "CANCELLED",
    );
    expect(tasks.find((task) => task.id === doneTask.id)?.status).toBe(
      "COMPLETED",
    );
    if (approvalId) {
      const approval = await prisma.approval.findUniqueOrThrow({
        where: { id: approvalId },
      });
      expect(approval.status).toBe("CANCELLED");
    }

    // Kart satırları görev kimliğiyle (istek ve sonuç kartı) ve onay kimliğiyle
    // (karar kartı) bulunur; hepsi sabit başlığa çevrilmiş olmalı.
    const cardKeys = [
      { path: ["card", "taskId"], equals: pendingTask.id },
      { path: ["card", "taskId"], equals: doneTask.id },
      ...[approvalId, doneApprovalId]
        .filter((id): id is string => id !== null)
        .map((id) => ({ path: ["card", "approvalId"], equals: id })),
    ];
    const cards = await prisma.command.findMany({
      where: {
        projectId: project.fixture.projectId,
        source: "SYSTEM",
        OR: cardKeys.map((parsedIntent) => ({ parsedIntent })),
      },
    });
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      expect(
        (card.parsedIntent as { card: { title: string } }).card.title,
      ).toBe(SCRUBBED_TITLE);
      const text = JSON.stringify(card);
      expect(text).not.toContain("generate_lead");
      expect(text).not.toContain("click_to_call");
    }
    const revoked = await prisma.integrationCredential.findUniqueOrThrow({
      where: { id: project.credentialId },
    });
    expect(revoked.status).toBe("REVOKED");
  }, 60_000);
});
