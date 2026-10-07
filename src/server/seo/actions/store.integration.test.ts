import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { seoMockMode } from "@/lib/seo/health-flags";
import type { SeoActionProposalStored } from "@/lib/seo/actions/types";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { describeIntegration } from "@/test-support/integration-suite";

import {
  forgetSeoActionsForCredential,
  forgetSeoActionsForLinks,
} from "./forget";
import { SeoActionRetention } from "./retention";
import { createSeoAction, getAction, transitionAction } from "./store";

// SeoAction deposu gerçek Postgres'e karşı (yalnız CI ve yerel tek
// kullanımlık veritabanı): openKey (projectId, isMock) başına tekildir ve
// DISMISS'ten sonra yeniden kullanılır; bulgu eşlemesi OPEN → DONE (vadeyle),
// UNDO_APPLY → ACCEPTED, yeniden APPLY → DONE, ölçüme geçiş vadeyi 21 gün
// uzatır; bağ silinince bağlı eylemler ve SEO öğrenmeleri (sourceType
// yeniden yazılmış olsa da) gider, linksiz eylem kalır; kimlik bilgisi yolu
// aynı şeyi yapar; saklama 1095 günlük terminal satırı siler (1094 günlüğü
// bırakır), silinmiş projenin ve bağı kalmayan satırları (öğrenmeleriyle) siler.

describeIntegration("SeoAction store", () => {
  const runId = randomUUID().slice(0, 8);
  const DAY = 86_400_000;
  const NOW = new Date("2026-10-01T12:00:00.000Z");
  const saved = { mode: process.env.AGENTELSE_PROVIDER_MODE };
  let fixture: AgencyFixture;
  let credentialId: string;
  let linkId: string;

  const proposal: SeoActionProposalStored = {
    v: 1,
    kind: "TITLE_META",
    before: null,
    after: null,
    variants: [],
    note: null,
    alert: null,
  };

  function actionInput(overrides: Record<string, unknown> = {}) {
    return {
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      kind: "TITLE_META" as const,
      source: "FINDING" as const,
      status: "PROPOSED" as const,
      openKey: `finding:${randomUUID()}`,
      linkId: null,
      targetUrl: "https://example.test/page",
      pageId: null,
      targetQueries: [],
      proposal,
      userId: "user-1",
      now: NOW,
      ...overrides,
    };
  }

  async function createFinding(status: string): Promise<string> {
    const finding = await prisma.seoFinding.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        linkId,
        ruleKey: "SO2_LOW_CTR",
        ruleVersion: 1,
        kind: "OPPORTUNITY",
        subject: `page:${randomUUID()}`,
        periodStart: new Date("2026-09-21"),
        periodEnd: new Date("2026-09-27"),
        periodKey: "W:2026-09-21",
        severity: "INFO",
        confidence: "DIRECTIONAL",
        status,
        effort: "S",
        actionKind: "TITLE_META",
        title: "Title",
        summary: "Summary",
        evidence: {},
        fingerprint: `fp-${randomUUID()}`,
        lastSeenAt: NOW,
      },
    });
    return finding.id;
  }

  async function backdate(id: string, at: Date): Promise<void> {
    await prisma.$executeRaw`UPDATE "SeoAction" SET "updatedAt" = ${at} WHERE "id" = ${id}`;
  }

  beforeAll(async () => {
    process.env.AGENTELSE_PROVIDER_MODE = "mock";
    fixture = await createAgencyFixture(`sas-${runId}`);
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
    const link = await prisma.gscSiteLink.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        credentialId,
        siteUrl: "sc-domain:example.test",
        isPrimary: true,
        isMock: seoMockMode(),
      },
    });
    linkId = link.id;
  }, 60_000);

  beforeEach(async () => {
    await prisma.systemHeartbeat.deleteMany({
      where: { key: "seo.actions-retention" },
    });
    SeoActionRetention.resetMemo();
  });

  afterAll(async () => {
    process.env.AGENTELSE_PROVIDER_MODE = saved.mode;
    await prisma.brandLearning.deleteMany({
      where: { workspaceId: fixture?.workspaceId },
    });
    await prisma.seoAction.deleteMany({
      where: { workspaceId: fixture?.workspaceId },
    });
    await prisma.seoFinding.deleteMany({
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

  it("keeps one open action per key and reuses the key after a dismissal", async () => {
    const input = actionInput({ openKey: `card:${randomUUID()}` });
    const first = await createSeoAction(input);
    const second = await createSeoAction(input);
    expect(first.created).toBe(true);
    expect(second).toMatchObject({ created: false });
    expect(second.action.id).toBe(first.action.id);

    const dismissed = await transitionAction({
      projectId: fixture.projectId,
      actionId: first.action.id,
      event: "DISMISS",
      userId: "user-1",
    });
    expect(dismissed.ok).toBe(true);
    const third = await createSeoAction(input);
    expect(third.created).toBe(true);
    expect(third.action.id).not.toBe(first.action.id);
  });

  it("syncs the finding through apply, undo, re-apply and measuring", async () => {
    const findingId = await createFinding("OPEN");
    const { action } = await createSeoAction(
      actionInput({
        findingId,
        linkId,
        status: "ACCEPTED",
        openKey: `finding:${findingId}`,
      }),
    );
    const finding = () =>
      prisma.seoFinding.findUniqueOrThrow({ where: { id: findingId } });

    await transitionAction({
      projectId: fixture.projectId,
      actionId: action.id,
      event: "APPLY",
      userId: "user-1",
      now: NOW,
    });
    let row = await finding();
    expect(row.status).toBe("DONE");
    expect(row.evaluateAfter).toEqual(new Date(NOW.getTime() + 28 * DAY));

    await transitionAction({
      projectId: fixture.projectId,
      actionId: action.id,
      event: "UNDO_APPLY",
      userId: "user-1",
    });
    row = await finding();
    expect(row.status).toBe("ACCEPTED");
    expect(row.evaluateAfter).toBeNull();

    await transitionAction({
      projectId: fixture.projectId,
      actionId: action.id,
      event: "APPLY",
      userId: "user-1",
      now: NOW,
    });
    expect((await finding()).status).toBe("DONE");

    const live = await transitionAction({
      projectId: fixture.projectId,
      actionId: action.id,
      event: "CONFIRM_LIVE",
      userId: "user-1",
      now: NOW,
    });
    expect(live.ok).toBe(true);
    const measured = await getAction(fixture.projectId, action.id);
    expect(measured?.status).toBe("EVALUATING");
    expect(measured?.evaluateAfter).toEqual(new Date(NOW.getTime() + 28 * DAY));
    expect((await finding()).evaluateAfter).toEqual(
      new Date(NOW.getTime() + 49 * DAY),
    );
  });

  it("forgets the linked actions and their learnings but keeps crawl-only actions", async () => {
    const linked = (await createSeoAction(actionInput({ linkId }))).action;
    const crawlOnly = (await createSeoAction(actionInput({ linkId: null })))
      .action;
    await prisma.brandLearning.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        brandId: fixture.brandId,
        insight: "On this site, a clearer title raised click-through.",
        // memory-service tipi yeniden yazmış olabilir
        sourceType: "MEMORY",
        sourceRef: linked.id,
      },
    });
    const keep = await prisma.brandLearning.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        brandId: fixture.brandId,
        insight: "Unrelated learning.",
        sourceType: "SEO",
        sourceRef: crawlOnly.id,
      },
    });

    const result = await forgetSeoActionsForLinks([linkId]);
    expect(result.actions).toBeGreaterThanOrEqual(1);
    expect(result.learnings).toBe(1);
    expect(await getAction(fixture.projectId, linked.id)).toBeNull();
    expect(await getAction(fixture.projectId, crawlOnly.id)).not.toBeNull();
    expect(
      await prisma.brandLearning.findUnique({ where: { id: keep.id } }),
    ).not.toBeNull();
  });

  it("forgets by credential", async () => {
    const linked = (await createSeoAction(actionInput({ linkId }))).action;
    const result = await forgetSeoActionsForCredential(credentialId);
    expect(result.actions).toBeGreaterThanOrEqual(1);
    expect(await getAction(fixture.projectId, linked.id)).toBeNull();
  });

  it("deletes terminal rows after 1095 days, rows of deleted projects and rows without a link", async () => {
    const old = (await createSeoAction(actionInput({ openKey: null }))).action;
    const recent = (await createSeoAction(actionInput({ openKey: null })))
      .action;
    for (const id of [old.id, recent.id]) {
      await prisma.seoAction.update({
        where: { id },
        data: { status: "WORKED", outcome: "WORKED" },
      });
    }
    await backdate(old.id, new Date(NOW.getTime() - 1095 * DAY - 1000));
    await backdate(recent.id, new Date(NOW.getTime() - 1094 * DAY));

    const ghost = await prisma.seoAction.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: `gone-${runId}`,
        isMock: seoMockMode(),
        source: "FINDING",
        kind: "TITLE_META",
        proposal: {},
        status: "PROPOSED",
        windowDays: 28,
      },
    });
    const missingLink = `missing-link-${runId}`;
    const dangling = await prisma.seoAction.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        isMock: seoMockMode(),
        linkId: missingLink,
        source: "FINDING",
        kind: "TITLE_META",
        proposal: {},
        status: "EVALUATING",
        windowDays: 28,
      },
    });
    await prisma.brandLearning.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        brandId: fixture.brandId,
        insight: "Dangling learning.",
        sourceType: "SEO",
        sourceRef: dangling.id,
      },
    });

    const deleted = await SeoActionRetention.runDue(NOW);
    expect(deleted).toBeGreaterThanOrEqual(4);
    const exists = async (id: string) =>
      (await prisma.seoAction.findUnique({ where: { id } })) !== null;
    expect(await exists(old.id)).toBe(false);
    expect(await exists(recent.id)).toBe(true);
    expect(await exists(ghost.id)).toBe(false);
    expect(await exists(dangling.id)).toBe(false);
    expect(
      await prisma.brandLearning.count({ where: { sourceRef: dangling.id } }),
    ).toBe(0);
  });
});
