import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
// after() istek dışında çalışmaz; bu testte doğrulama sıraya girmez.
vi.mock("next/server", () => ({ after: vi.fn() }));

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { scopeFromGscSite } from "@/lib/seo/crawl-url";
import { seoMockMode } from "@/lib/seo/health-flags";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { forgetSeoActionsForProjectMode } from "@/server/seo/actions/forget";
import { decideFinding } from "@/server/seo/opportunities/findings-store";
import { describeIntegration } from "@/test-support/integration-suite";

import { fixFinding, trackFindingDone } from "./fix-this";

// "Fix this" ve "Done" gerçek Postgres'e karşı (yalnız CI ve yerel tek
// kullanımlık veritabanı; mock kipte siteye ya da Google'a gidilmez): TITLE_META
// bulgusu ACCEPTED eylem açar (linkId = bulgunun bağı), bulgu ACCEPTED olur,
// 'seofix_<id>' Work'ü hedef sayfa ve kökenle snippet kartı taşır ve karta sorgu
// dizesi girmez; NEW_CONTENT bulgusu boş konulu makale kartı açar ve anahtar
// kelime kartın hiçbir yerinde geçmez; ikinci dokunuş aynı eylemi ve kartı
// bulur; Done APPLIED eylem açar ve bulgu DONE kalır; Search Console bağının
// verisi silinince eylemler gider ve kartın target.queryCount'u sıfırlanır.

const KEYWORD = "blue widgets cheap";

describeIntegration("Fix this (mock providers)", () => {
  const runId = randomUUID().slice(0, 8);
  const saved = {
    provider: process.env.AGENTELSE_PROVIDER_MODE,
    actions: process.env.SEO_ACTIONS,
    health: process.env.SEO_HEALTH,
    crawl: process.env.SEO_CRAWL,
  };
  let fixture: AgencyFixture;
  let linkId: string;
  const userId = `user-${runId}`;

  async function createFinding(input: {
    actionKind: string;
    status?: string;
    keyword?: string | null;
    pages?: { path: string; url: string }[];
  }): Promise<string> {
    const pages = (input.pages ?? []).map((page) => ({
      pageId: null,
      path: page.path,
      url: page.url,
      clicks: 12,
      impressions: 900,
      position: 8.2,
    }));
    const finding = await prisma.seoFinding.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        linkId,
        ruleKey: "SO1_STRIKING_DISTANCE",
        ruleVersion: 1,
        kind: "OPPORTUNITY",
        subject: `page:${randomUUID()}`,
        periodStart: new Date("2026-09-21"),
        periodEnd: new Date("2026-09-27"),
        periodKey: "W:2026-09-21",
        severity: "INFO",
        confidence: "DIRECTIONAL",
        status: input.status ?? "OPEN",
        effort: "S",
        actionKind: input.actionKind,
        title: "Improve a page",
        summary: "It ranks near the first page.",
        evidence: {
          window: { from: "2026-08-31", to: "2026-09-27" },
          metrics: { impressions: 900 },
          pages,
          queries: [],
        },
        keyword: input.keyword ?? null,
        fingerprint: `fp-${randomUUID()}`,
        lastSeenAt: new Date("2026-10-01T00:00:00.000Z"),
      },
    });
    return finding.id;
  }

  function fixInput(findingId: string) {
    return {
      projectId: fixture.projectId,
      findingId,
      userId,
      workspaceId: fixture.workspaceId,
      brandId: fixture.brandId,
    };
  }

  async function rawCard(commandId: string) {
    const command = await prisma.command.findFirstOrThrow({
      where: { id: commandId, projectId: fixture.projectId },
    });
    const intent = command.parsedIntent as {
      card: { data: Record<string, unknown>; module: string; step: string };
    };
    return { command, card: intent.card };
  }

  beforeAll(async () => {
    process.env.AGENTELSE_PROVIDER_MODE = "mock";
    process.env.SEO_ACTIONS = "true";
    process.env.SEO_HEALTH = "true";
    process.env.SEO_CRAWL = "true";
    fixture = await createAgencyFixture(`fix-this-${runId}`);
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
    const link = await prisma.gscSiteLink.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        credentialId: credential.id,
        siteUrl: "sc-domain:example.com",
        isPrimary: true,
        isMock: seoMockMode(),
      },
    });
    linkId = link.id;
    const scope = scopeFromGscSite("sc-domain:example.com");
    if (!scope) throw new Error("scope fixture missing");
    await prisma.seoSite.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        isMock: seoMockMode(),
        origin: "https://example.com",
        scope: scope as unknown as Prisma.InputJsonValue,
        scopeKey: scope.key,
        robotsVerdict: "MISSING",
      },
    });
  }, 60_000);

  afterAll(async () => {
    process.env.AGENTELSE_PROVIDER_MODE = saved.provider;
    process.env.SEO_ACTIONS = saved.actions;
    process.env.SEO_HEALTH = saved.health;
    process.env.SEO_CRAWL = saved.crawl;
    const where = { workspaceId: fixture?.workspaceId };
    await prisma.brandLearning.deleteMany({ where });
    await prisma.seoAction.deleteMany({ where });
    await prisma.seoFinding.deleteMany({ where });
    await prisma.seoSite.deleteMany({ where });
    await prisma.gscSiteLink.deleteMany({
      where: { projectId: fixture?.projectId },
    });
    await prisma.integrationCredential.deleteMany({ where });
    await teardownAgencyFixture(fixture?.workspaceId);
    await prisma.work.deleteMany({ where });
  });

  it("opens a snippet card for a title finding and accepts the finding", async () => {
    const findingId = await createFinding({
      actionKind: "TITLE_META",
      keyword: KEYWORD,
      pages: [
        { path: "/pricing", url: "https://example.com/pricing" },
      ],
    });
    const result = await fixFinding(fixInput(findingId));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.opened).toBe("manager");

    const action = await prisma.seoAction.findFirstOrThrow({
      where: { id: result.actionId },
    });
    expect(action).toMatchObject({
      status: "ACCEPTED",
      kind: "TITLE_META",
      source: "FINDING",
      linkId,
      findingId,
      openKey: `finding:${findingId}`,
      workId: `seofix_${action.id}`,
      commandId: `seofixcard_${action.id}`,
    });
    const finding = await prisma.seoFinding.findUniqueOrThrow({
      where: { id: findingId },
    });
    expect(finding.status).toBe("ACCEPTED");

    expect(result.href).toBe(
      `/projects/${fixture.projectId}?work=seofix_${action.id}`,
    );
    const work = await prisma.work.findUniqueOrThrow({
      where: { id: `seofix_${action.id}` },
    });
    expect(work.projectId).toBe(fixture.projectId);

    const { card } = await rawCard(`seofixcard_${action.id}`);
    expect(card.module).toBe("seo");
    const data = card.data as {
      mode?: string;
      origin?: { findingId: string; ruleKey: string };
      actionId?: string;
      target?: { path: string; queryCount: number };
    };
    expect(data.mode).toBe("snippet");
    expect(data.origin).toEqual({
      findingId,
      ruleKey: "SO1_STRIKING_DISTANCE",
    });
    expect(data.actionId).toBe(action.id);
    expect(data.target?.path).toBe("/pricing");
    // Kartta anahtar kelime ve sorgu dizesi yoktur.
    const serialized = JSON.stringify(card.data);
    expect(serialized).not.toContain(KEYWORD);

    // İkinci dokunuş aynı eylemi bulur; ikinci eylem doğmaz.
    const again = await fixFinding(fixInput(findingId));
    expect(again).toMatchObject({ ok: true, actionId: action.id });
    expect(await prisma.seoAction.count({ where: { findingId } })).toBe(1);
  });

  it("reuses the card on a second tap and recreates a deleted one", async () => {
    const findingId = await createFinding({
      actionKind: "TITLE_META",
      status: "ACCEPTED",
      pages: [{ path: "/about", url: "https://example.com/about" }],
    });
    const first = await fixFinding(fixInput(findingId));
    const second = await fixFinding(fixInput(findingId));
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.actionId).toBe(first.actionId);
    expect(second.href).toBe(first.href);
    expect(
      await prisma.command.count({
        where: { id: `seofixcard_${first.actionId}` },
      }),
    ).toBe(1);

    // Kullanıcı Work'ü sildi: aynı kimliklerle yeniden kurulur.
    await prisma.command.deleteMany({
      where: { id: `seofixcard_${first.actionId}` },
    });
    await prisma.work.deleteMany({ where: { id: `seofix_${first.actionId}` } });
    const third = await fixFinding(fixInput(findingId));
    expect(third).toMatchObject({ ok: true, actionId: first.actionId });
    expect(
      await prisma.command.count({
        where: { id: `seofixcard_${first.actionId}` },
      }),
    ).toBe(1);
  });

  it("opens an article card with an empty topic and no keyword", async () => {
    const findingId = await createFinding({
      actionKind: "NEW_CONTENT",
      keyword: KEYWORD,
    });
    const result = await fixFinding(fixInput(findingId));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { card } = await rawCard(`seofixcard_${result.actionId}`);
    const data = card.data as {
      mode?: string;
      brief?: { topic: string; siteUrl: string };
    };
    expect(data.mode).toBe("article");
    expect(data.brief?.topic).toBe("");
    expect(data.brief?.siteUrl).toBe("https://example.com");
    expect(JSON.stringify(card.data)).not.toContain(KEYWORD);

    // Anahtar kelime yalnız eylemin teklifinde durur (öneri olarak sunulur).
    const action = await prisma.seoAction.findUniqueOrThrow({
      where: { id: result.actionId },
    });
    expect(JSON.stringify(action.proposal)).toContain(KEYWORD);
  });

  it("sends a checklist kind to the Actions & results anchor", async () => {
    const findingId = await createFinding({ actionKind: "INTERNAL_LINKS" });
    const result = await fixFinding(fixInput(findingId));
    expect(result).toMatchObject({ ok: true, opened: "checklist" });
    if (!result.ok) return;
    expect(result.href).toBe(
      `/projects/${fixture.projectId}/arama?action=${result.actionId}#actions`,
    );
  });

  it("refuses a closer-look finding", async () => {
    const findingId = await createFinding({ actionKind: "INVESTIGATE" });
    const result = await fixFinding(fixInput(findingId));
    expect(result).toEqual({
      ok: false,
      message: "This one needs a closer look rather than a single fix.",
    });
  });

  it("starts measurement when an opportunity is marked done", async () => {
    const findingId = await createFinding({
      actionKind: "TITLE_META",
      status: "ACCEPTED",
      pages: [{ path: "/contact", url: "https://example.com/contact" }],
    });
    const decided = await decideFinding({
      projectId: fixture.projectId,
      findingId,
      decision: "DONE",
      userId,
    });
    expect(decided.ok).toBe(true);
    await trackFindingDone({
      projectId: fixture.projectId,
      findingId,
      userId,
      workspaceId: fixture.workspaceId,
    });
    const action = await prisma.seoAction.findFirstOrThrow({
      where: { findingId },
    });
    expect(action).toMatchObject({
      status: "APPLIED",
      source: "OPPORTUNITY_DONE",
      linkId,
      kind: "TITLE_META",
    });
    const finding = await prisma.seoFinding.findUniqueOrThrow({
      where: { id: findingId },
    });
    expect(finding.status).toBe("DONE");
  });

  it("forgets the actions and zeroes the card's query count with the link's data", async () => {
    const actions = await prisma.seoAction.findMany({
      where: { projectId: fixture.projectId },
      select: { id: true, commandId: true },
    });
    expect(actions.length).toBeGreaterThan(0);
    const cardAction = actions.find((action) => action.commandId !== null);
    if (!cardAction?.commandId) throw new Error("card action missing");

    // Kartın Google kökenli sorgu sayısı dolu olsun.
    const { command, card } = await rawCard(cardAction.commandId);
    const target = (card.data.target ?? {}) as Record<string, unknown>;
    const seeded = {
      card: {
        ...card,
        data: { ...card.data, target: { ...target, queryCount: 12 } },
      },
    };
    await prisma.command.update({
      where: { id: command.id },
      data: { parsedIntent: seeded as unknown as Prisma.InputJsonValue },
    });

    const result = await forgetSeoActionsForProjectMode(
      fixture.projectId,
      seoMockMode(),
    );
    expect(result.actions).toBe(actions.length);
    expect(
      await prisma.seoAction.count({ where: { projectId: fixture.projectId } }),
    ).toBe(0);

    const after = await rawCard(cardAction.commandId);
    const data = after.card.data as { target?: { queryCount: number } };
    expect(data.target?.queryCount).toBe(0);
  });
});
