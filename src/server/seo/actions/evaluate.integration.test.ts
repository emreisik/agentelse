import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import type { GscSiteLink } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { proposalFixture } from "@/lib/seo/actions/test-support";
import { evaluationWindows } from "@/lib/seo/actions/windows";
import { addWeeks, dayKeyToDate } from "@/lib/seo/dates";
import { normalizePageUrl } from "@/lib/seo/normalize";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { describeIntegration } from "@/test-support/integration-suite";

import { SeoActionEvaluator } from "./evaluate";
import { SeoLearnings } from "./learnings";

// Eylem değerlendirmesi gerçek Postgres'e karşı (yalnız CI ve yerel tek
// kullanımlık veritabanı; mock kipte Google'a ya da siteye gidilmez):
// 20 haftalık ambar tohumunda işlenen sayfa değişiklikten sonra %40 artar,
// kontrol sayfaları sabittir. Başlık/meta eylemi WORKED + SIGNIFICANT olur,
// bulgu EVALUATED'e geçer ve tek bir digit-free SEO öğrenmesi yazılır
// (ikinci çağrı yazmaz). Aynı veriye çakışan CORE güncellemesi eklenince
// sonuç INCONCLUSIVE GOOGLE_UPDATE olur ve öğrenme yazılmaz. Sabit işlenen
// sayfa DIDNT'tir ve öğrenme yazmaz. Başka (sağlık olmayan) eylemin sayfası
// kontrol dışı kalır; sağlık-uyarısı eyleminin sayfası kalmaz.

const NOW = new Date("2026-09-10T12:00:00.000Z");
const MEASURE_FROM = new Date("2026-08-05T12:00:00.000Z");
const EVALUATE_AFTER = new Date("2026-09-02T12:00:00.000Z");
const APPLIED_AT = new Date("2026-08-05T10:00:00.000Z");
const FIRST_WEEK = "2026-04-27";
const WEEKS = Array.from({ length: 20 }, (_, index) =>
  addWeeks(FIRST_WEEK, index),
);
const LAST_WEEK = WEEKS[WEEKS.length - 1]!;
const WINDOWS = evaluationWindows({
  measureFrom: MEASURE_FROM,
  windowDays: 28,
});
const ORIGIN = "https://example.com";
// Bandın içindeki üç kontrol (sabit 20 tıklama); kalan sekiz sayfa bandın
// dışındadır (sabit 100 tıklama).
const PATHS = Array.from(
  { length: 12 },
  (_, index) => `/services/p${index + 1}`,
);
const TREATED_PATH = PATHS[0]!;
const IN_BAND_PATHS = PATHS.slice(1, 4);

describeIntegration("SEO action evaluation (mock providers)", () => {
  const runId = randomUUID().slice(0, 8);
  const saved = {
    actions: process.env.SEO_ACTIONS,
    health: process.env.SEO_HEALTH,
    crawl: process.env.SEO_CRAWL,
    provider: process.env.AGENTELSE_PROVIDER_MODE,
  };
  let fixture: AgencyFixture;
  let link: GscSiteLink;
  const pageIds = new Map<string, string>();
  let counter = 0;

  function urlOf(path: string): string {
    return `${ORIGIN}${path}`;
  }

  async function seedLink(credentialId: string): Promise<GscSiteLink> {
    const created = await prisma.gscSiteLink.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        credentialId,
        siteUrl: "sc-domain:example.com",
        isPrimary: true,
        isMock: true,
        propertyType: "DOMAIN",
        health: "OK",
        lastWeeklyWeek: LAST_WEEK,
      },
    });
    const base = { linkId: created.id, projectId: fixture.projectId };
    for (const path of PATHS) {
      const normalized = normalizePageUrl(urlOf(path))!;
      const page = await prisma.gscPage.create({
        data: {
          ...base,
          url: normalized.url,
          urlHash: normalized.hash,
          path: normalized.path,
          pageGroup: normalized.pageGroup,
          firstSeenWeek: dayKeyToDate(WEEKS[0]!),
          lastSeenWeek: dayKeyToDate(LAST_WEEK),
        },
      });
      pageIds.set(path, page.id);
    }
    const rows = WEEKS.flatMap((week) =>
      PATHS.map((path) => {
        const isTreated = path === TREATED_PATH;
        const lifted = isTreated && WINDOWS.postWeeks.includes(week);
        const inBand = isTreated || IN_BAND_PATHS.includes(path);
        const clicks = lifted ? 28 : inBand ? 20 : 100;
        const impressions = inBand ? 200 : 1000;
        return {
          ...base,
          weekStart: dayKeyToDate(week),
          pageId: pageIds.get(path)!,
          clicks,
          impressions,
          positionWeighted: impressions * 5,
        };
      }),
    );
    await prisma.gscWeeklyPage.createMany({ data: rows });
    await prisma.gscPeriodFetch.createMany({
      data: WEEKS.map((week) => ({
        ...base,
        grain: "WEEK",
        periodStart: dayKeyToDate(week),
        key: "page",
        fetchedAt: NOW,
      })),
    });
    return created;
  }

  async function seedAction(
    overrides: {
      source?: string;
      kind?: string;
      path?: string;
      status?: string;
      withFinding?: boolean;
      appliedAt?: Date;
    } = {},
  ) {
    counter += 1;
    const kind = overrides.kind ?? "TITLE_META";
    const path = overrides.path ?? TREATED_PATH;
    const findingId =
      (overrides.withFinding ?? true)
        ? (
            await prisma.seoFinding.create({
              data: {
                workspaceId: fixture.workspaceId,
                projectId: fixture.projectId,
                linkId: link.id,
                ruleKey: "SO2_CTR_GAP",
                ruleVersion: 1,
                kind: "OPPORTUNITY",
                subject: `page:${pageIds.get(path)}`,
                periodStart: dayKeyToDate(WEEKS[0]!),
                periodEnd: dayKeyToDate(LAST_WEEK),
                periodKey: `W:${LAST_WEEK}`,
                severity: "INFO",
                confidence: "SIGNIFICANT",
                status: "DONE",
                effort: "S",
                actionKind: kind,
                title: "Title",
                summary: "Summary",
                evidence: {},
                fingerprint: `fp-${runId}-${counter}`,
                lastSeenAt: NOW,
                evaluateAfter: EVALUATE_AFTER,
              },
            })
          ).id
        : null;
    const evaluating = (overrides.status ?? "EVALUATING") === "EVALUATING";
    return prisma.seoAction.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        isMock: true,
        linkId: link.id,
        findingId,
        source: overrides.source ?? "FINDING",
        kind,
        openKey: `test:${runId}:${counter}`,
        pageId: pageIds.get(path),
        targetUrl: urlOf(path),
        targetUrlHash: `crawler-${runId}-${counter}`,
        proposal: JSON.parse(
          JSON.stringify(proposalFixture(kind as "TITLE_META")),
        ),
        status: overrides.status ?? "EVALUATING",
        appliedVia: "USER",
        appliedAt: overrides.appliedAt ?? APPLIED_AT,
        windowDays: 28,
        ...(evaluating
          ? {
              measureFrom: MEASURE_FROM,
              evaluateAfter: EVALUATE_AFTER,
              nextCheckAt: EVALUATE_AFTER,
            }
          : { nextCheckAt: NOW }),
      },
    });
  }

  async function evaluate(actionId: string) {
    return SeoActionEvaluator.evaluateAction(actionId, { now: NOW });
  }

  async function reload(actionId: string) {
    return prisma.seoAction.findUniqueOrThrow({ where: { id: actionId } });
  }

  async function learningsFor(actionId: string) {
    return prisma.brandLearning.findMany({
      where: { projectId: fixture.projectId, sourceRef: actionId },
    });
  }

  beforeAll(async () => {
    process.env.SEO_ACTIONS = "true";
    process.env.SEO_HEALTH = "true";
    process.env.SEO_CRAWL = "true";
    process.env.AGENTELSE_PROVIDER_MODE = "mock";
    fixture = await createAgencyFixture(`seo-act-${runId}`);
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
    link = await seedLink(credential.id);
  }, 60_000);

  afterEach(async () => {
    await prisma.seoAction.deleteMany({
      where: { projectId: fixture.projectId },
    });
    await prisma.seoFinding.deleteMany({ where: { linkId: link.id } });
    await prisma.brandLearning.deleteMany({
      where: { projectId: fixture.projectId },
    });
    await prisma.searchUpdate.deleteMany({
      where: { externalId: { startsWith: `test-${runId}` } },
    });
  });

  afterAll(async () => {
    for (const [key, value] of [
      ["SEO_ACTIONS", saved.actions],
      ["SEO_HEALTH", saved.health],
      ["SEO_CRAWL", saved.crawl],
      ["AGENTELSE_PROVIDER_MODE", saved.provider],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (!fixture) return;
    await prisma.seoAction.deleteMany({
      where: { projectId: fixture.projectId },
    });
    await prisma.brandLearning.deleteMany({
      where: { projectId: fixture.projectId },
    });
    await prisma.gscSiteLink.deleteMany({
      where: { projectId: fixture.projectId },
    });
    await prisma.integrationCredential.deleteMany({
      where: { workspaceId: fixture.workspaceId },
    });
    await teardownAgencyFixture(fixture.workspaceId);
  });

  it("evaluates a +40% title change against controls as WORKED and writes one learning", async () => {
    const action = await seedAction();
    expect(await SeoActionEvaluator.runDue(10, NOW)).toBe(1);

    const row = await reload(action.id);
    expect(row).toMatchObject({
      status: "WORKED",
      outcome: "WORKED",
      confidence: "SIGNIFICANT",
      openKey: null,
      nextCheckAt: null,
      leaseOwner: null,
    });
    const evaluation = row.evaluation as Record<string, unknown>;
    expect(evaluation.method).toBe("DID");
    expect(evaluation.controls).toBe(3);
    expect(evaluation.updates).toEqual([]);
    expect(evaluation.effect as number).toBeGreaterThan(0.3);

    const finding = await prisma.seoFinding.findUniqueOrThrow({
      where: { id: action.findingId! },
    });
    expect(finding).toMatchObject({ status: "EVALUATED", outcome: "WORKED" });
    expect(finding.evaluatedAt).not.toBeNull();

    // Mock veride öğrenme yazılmaz: kapı gerçek (mock olmayan) veri ister.
    expect(await learningsFor(action.id)).toHaveLength(0);
    // Satırı gerçek veriye çevir: kapıyı geçen sonuçtan tek, rakamsız öğrenme yazılır.
    await prisma.seoAction.update({
      where: { id: action.id },
      data: { isMock: false },
    });
    expect(await SeoLearnings.writeFor(action.id, NOW)).toBe(true);

    const learnings = await learningsFor(action.id);
    expect(learnings).toHaveLength(1);
    expect(learnings[0]).toMatchObject({
      sourceType: "SEO",
      polarity: "WORKS",
      brandId: fixture.brandId,
    });
    expect(learnings[0]!.insight).not.toMatch(/\d/);
    expect(learnings[0]!.insight).not.toContain("/");
    expect(learnings[0]!.insight).not.toContain("http");
    expect((await reload(action.id)).learningId).toBe(learnings[0]!.id);

    // Aynı eylem için ikinci yazım öğrenme çoğaltmaz.
    expect(await SeoLearnings.writeFor(action.id, NOW)).toBe(false);
    expect(await learningsFor(action.id)).toHaveLength(1);
  }, 60_000);

  it("turns a window that overlaps a Google update into INCONCLUSIVE with no learning", async () => {
    await prisma.searchUpdate.create({
      data: {
        externalId: `test-${runId}-core`,
        name: "August core update",
        kind: "CORE",
        source: "MANUAL",
        startedAt: new Date("2026-08-01T00:00:00.000Z"),
        endedAt: new Date("2026-08-12T00:00:00.000Z"),
      },
    });
    const action = await seedAction();
    const result = await evaluate(action.id);
    expect(result).toEqual({ status: "evaluated", outcome: "INCONCLUSIVE" });

    const row = await reload(action.id);
    expect(row.status).toBe("INCONCLUSIVE");
    expect(row.confidence).toBe("DIRECTIONAL");
    const evaluation = row.evaluation as Record<string, unknown>;
    expect(evaluation.reason).toBe("GOOGLE_UPDATE");
    expect(evaluation.updates).toEqual([
      expect.objectContaining({ name: "August core update", kind: "CORE" }),
    ]);
    expect(await learningsFor(action.id)).toHaveLength(0);
    expect(row.learningId).toBeNull();
    const finding = await prisma.seoFinding.findUniqueOrThrow({
      where: { id: action.findingId! },
    });
    expect(finding).toMatchObject({
      status: "EVALUATED",
      outcome: "INCONCLUSIVE",
    });
  }, 60_000);

  it("marks a flat treated page as DIDNT and writes no learning", async () => {
    const treatedId = pageIds.get(TREATED_PATH)!;
    await prisma.gscWeeklyPage.updateMany({
      where: {
        pageId: treatedId,
        weekStart: { in: WINDOWS.postWeeks.map((week) => dayKeyToDate(week)) },
      },
      data: { clicks: 20 },
    });
    try {
      const action = await seedAction();
      const result = await evaluate(action.id);
      expect(result).toEqual({ status: "evaluated", outcome: "DIDNT" });
      const row = await reload(action.id);
      expect(row.status).toBe("DIDNT");
      expect(await learningsFor(action.id)).toHaveLength(0);
      const finding = await prisma.seoFinding.findUniqueOrThrow({
        where: { id: action.findingId! },
      });
      expect(finding).toMatchObject({ status: "EVALUATED", outcome: "DIDNT" });
    } finally {
      await prisma.gscWeeklyPage.updateMany({
        where: {
          pageId: treatedId,
          weekStart: {
            in: WINDOWS.postWeeks.map((week) => dayKeyToDate(week)),
          },
        },
        data: { clicks: 28 },
      });
    }
  }, 60_000);

  it("does not change the control count for a health-issue action on a control page", async () => {
    const controlPath = IN_BAND_PATHS[0]!;
    await seedAction({
      source: "HEALTH_ISSUE",
      kind: "TECH_FIX",
      path: controlPath,
      status: "APPLIED",
      withFinding: false,
      appliedAt: new Date("2026-07-20T12:00:00.000Z"),
    });
    const action = await seedAction();
    await evaluate(action.id);
    const row = await reload(action.id);
    const evaluation = row.evaluation as Record<string, unknown>;
    expect(evaluation.method).toBe("DID");
    expect(evaluation.controls).toBe(3);
    expect(row.status).toBe("WORKED");
  }, 60_000);

  it("drops a control page another (non-health) action changed", async () => {
    const controlPath = IN_BAND_PATHS[0]!;
    await seedAction({
      source: "FINDING",
      kind: "INTERNAL_LINKS",
      path: controlPath,
      status: "APPLIED",
      withFinding: false,
      appliedAt: new Date("2026-07-20T12:00:00.000Z"),
    });
    const action = await seedAction();
    await evaluate(action.id);
    const row = await reload(action.id);
    const evaluation = row.evaluation as Record<string, unknown>;
    // Bandda yalnız iki kontrol kaldı: site toplamı, yönsel sonuç.
    expect(evaluation.method).toBe("DID_SITE");
    expect(evaluation.controls).toBe(2);
    expect(row.confidence).toBe("DIRECTIONAL");
    expect(await learningsFor(action.id)).toHaveLength(0);
  }, 60_000);
});
