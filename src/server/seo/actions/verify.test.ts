import type { SeoAction } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  actionViewFixture,
  proposalFixture,
} from "@/lib/seo/actions/test-support";
import type {
  SeoActionProposalStored,
  SeoActionView,
} from "@/lib/seo/actions/types";
import type { ObservedPage } from "@/lib/seo/actions/verify-checks";
import { seoMockMode } from "@/lib/seo/health-flags";

// Bu dosyanın kanıtladığı: bayrak kapalıyken runDue veritabanına hiç gitmez;
// izin listesi WHERE'de, proje başına üst sınır aday fazla çekilerek uygulanır
// (A projesinin 6 satırı B'yi dışarıda bırakmaz); bütçe 0 ise hiçbir eylem
// başlamaz, süre eylemin ortasında biterse 'deadline' döner ve nextCheckAt
// korunur; uyarı kaynaklı eylem yalnız uyarı appliedAt'tan sonra çözülünce
// doğrulanır, inceleme uyarıları ≤5 etkilenen anahtar sayfayı bir kez ister ve
// 3 gün sonra yeniden; CWV_FIX 35. günde sorar (14. değil); makalesi takvimde
// olan eylem keşfedilince APPLIED DETECTED olup ölçüme geçer ve bulgu null
// kullanıcıyla DONE olur; Google aşaması kullanılabilirse VERIFIED + tek inceleme
// isteği ('full' → requestedAt boş), kullanılamıyorsa doğrudan ölçüm; VERIFIED
// görülünce çapa lastCrawlTime olur, 21 günde vazgeçilir; kira doluysa 'busy'.

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  projectFindUnique: vi.fn(),
  alertFindUnique: vi.fn(),
  cwvFindFirst: vi.fn(),
  claim: vi.fn(),
  release: vi.fn(),
  startMeasuring: vi.fn(),
  markFindingDone: vi.fn(),
  pageCheckSite: vi.fn(),
  checkPage: vi.fn(),
  readCrawledPage: vi.fn(),
  robotsAllow: vi.fn(),
  findPublishedPage: vi.fn(),
  forProject: vi.fn(),
  keyPagesFor: vi.fn(),
  readInspectionsFor: vi.fn(),
  readGscSitemaps: vi.fn(),
  requestInspection: vi.fn(),
  beat: vi.fn(),
  ok: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    seoAction: {
      findMany: mocks.findMany,
      findUnique: mocks.findUnique,
      updateMany: mocks.updateMany,
    },
    project: { findUnique: mocks.projectFindUnique },
    adsAlert: { findUnique: mocks.alertFindUnique },
    seoCwv: { findFirst: mocks.cwvFindFirst },
  },
}));
vi.mock("./store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./store")>()),
  claimAction: mocks.claim,
  releaseAction: mocks.release,
  startMeasuring: mocks.startMeasuring,
  markFindingDone: mocks.markFindingDone,
}));
vi.mock("./page-check", () => ({
  pageCheckSite: mocks.pageCheckSite,
  checkPage: mocks.checkPage,
  readCrawledPage: mocks.readCrawledPage,
  robotsAllow: mocks.robotsAllow,
}));
vi.mock("./discovery", () => ({ findPublishedPage: mocks.findPublishedPage }));
vi.mock("@/server/seo/site/sites", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/seo/site/sites")>()),
  SeoSites: { forProject: mocks.forProject },
}));
vi.mock("@/server/seo/site/key-pages", () => ({
  keyPagesFor: mocks.keyPagesFor,
}));
vi.mock("@/server/seo/health/google-reads", () => ({
  readInspectionsFor: mocks.readInspectionsFor,
  readGscSitemaps: mocks.readGscSitemaps,
}));
vi.mock("@/server/seo/health/inspection", () => ({
  SeoInspection: { requestInspection: mocks.requestInspection },
}));
vi.mock("@/server/observability/heartbeat", () => ({
  Heartbeat: { beat: mocks.beat, ok: mocks.ok },
}));

import { SeoActionVerifier } from "./verify";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const DAY = 86_400_000;
const ENV_KEYS = [
  "SEO_ACTIONS",
  "SEO_HEALTH",
  "SEO_CRAWL",
  "GSC_SYNC",
  "SEO_ROLLOUT_PROJECTS",
  "GSC_ROLLOUT_PROJECTS",
] as const;
const saved: Record<string, string | undefined> = {};

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY);
}

function rowOf(view: SeoActionView): SeoAction {
  return {
    id: view.id,
    workspaceId: view.workspaceId,
    projectId: view.projectId,
    isMock: seoMockMode(),
    linkId: view.linkId,
    findingId: view.findingId,
    source: view.source,
    kind: view.kind,
    openKey: null,
    pageId: null,
    targetUrl: view.targetUrl,
    targetUrlHash: view.targetUrlHash,
    targetQueries: [],
    proposal: view.proposal as never,
    baseline: (view.baseline ?? null) as never,
    status: view.status,
    appliedVia: view.appliedVia,
    appliedAt: view.appliedAt,
    appliedByUserId: null,
    verifiedAt: view.verifiedAt,
    verification: view.verification as never,
    verifyAttempts: 0,
    askedAt: view.askedAt,
    nextCheckAt: view.nextCheckAt,
    leaseUntil: null,
    leaseOwner: null,
    windowDays: view.windowDays,
    measureFrom: null,
    evaluateAfter: null,
    evaluatedAt: null,
    evaluation: null,
    outcome: null,
    confidence: null,
    learningId: null,
    creativeId: view.creativeId,
    commandId: null,
    workId: null,
    approvalId: null,
    createdByUserId: null,
    decidedAt: null,
    dismissReason: null,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
  };
}

function observed(overrides: Partial<ObservedPage> = {}): ObservedPage {
  return {
    url: "https://example.com/page",
    finalUrl: "https://example.com/page",
    status: 200,
    title: "A page",
    metaDescription: null,
    h1: "A page",
    h2: [],
    canonical: null,
    noindex: false,
    indexable: true,
    wordCount: 500,
    textHash: "hash",
    schemaTypes: [],
    schemaErrors: 0,
    fetchedAt: NOW.toISOString(),
    source: "FETCH",
    hops: 0,
    fetchError: null,
    robotsBlocked: false,
    links: [],
    ...overrides,
  };
}

function techProposal(
  issue: "NOINDEX" | "STATUS" | "CANONICAL",
): SeoActionProposalStored {
  return {
    v: 1,
    kind: "TECH_FIX",
    issue,
    issueCodes: [],
    note: null,
    alert: null,
  };
}

function articleProposal(liveUrl: string | null): SeoActionProposalStored {
  return {
    v: 1,
    kind: "NEW_CONTENT",
    title: "Blue widgets guide",
    primaryKeyword: null,
    language: null,
    liveUrl,
    note: null,
    alert: null,
  };
}

function load(view: SeoActionView) {
  mocks.findUnique.mockResolvedValue(rowOf(view));
}

function alertProposal(
  kind: "TECH_FIX" | "SCHEMA" | "CWV_FIX",
  alertKind: string,
  source: "GSC" | "SEO" = "GSC",
): SeoActionProposalStored {
  return {
    ...proposalFixture(kind),
    alert: { kind: alertKind, dedupeKey: "dedupe-1", source },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  process.env.SEO_ACTIONS = "true";
  process.env.SEO_HEALTH = "true";
  process.env.SEO_CRAWL = "true";
  delete process.env.GSC_SYNC;
  delete process.env.SEO_ROLLOUT_PROJECTS;
  delete process.env.GSC_ROLLOUT_PROJECTS;
  mocks.claim.mockResolvedValue(true);
  mocks.release.mockResolvedValue(true);
  mocks.startMeasuring.mockResolvedValue(true);
  mocks.updateMany.mockResolvedValue({ count: 0 });
  mocks.projectFindUnique.mockResolvedValue({ status: "ACTIVE" });
  mocks.pageCheckSite.mockResolvedValue({
    siteId: "site-1",
    projectId: "project-1",
    robotsFailing: false,
  });
  mocks.readCrawledPage.mockResolvedValue(null);
  mocks.robotsAllow.mockResolvedValue(true);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("runDue", () => {
  it("does nothing, and queries nothing, while the flag is off", async () => {
    process.env.SEO_ACTIONS = "false";
    expect(await SeoActionVerifier.runDue(10, NOW)).toBe(0);
    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.beat).not.toHaveBeenCalled();
  });

  it("puts the allow-list into every WHERE and sweeps stale open actions", async () => {
    process.env.SEO_ROLLOUT_PROJECTS = "project-a,project-b";
    mocks.findMany.mockResolvedValue([]);
    await SeoActionVerifier.runDue(10, NOW);
    expect(mocks.findMany.mock.calls[0]![0].where.projectId).toEqual({
      in: ["project-a", "project-b"],
    });
    expect(mocks.findMany.mock.calls[0]![0].take).toBe(30);
    expect(mocks.updateMany).toHaveBeenCalledTimes(2);
    for (const call of mocks.updateMany.mock.calls) {
      expect(call[0].where.projectId).toEqual({
        in: ["project-a", "project-b"],
      });
      expect(call[0].where.isMock).toBe(seoMockMode());
      expect(call[0].data).toMatchObject({ status: "EXPIRED", openKey: null });
    }
  });

  it("caps a project at five per run but still reaches the next project", async () => {
    mocks.findMany.mockResolvedValue([
      ...Array.from({ length: 6 }, (_, index) => ({
        id: `a${index}`,
        projectId: "project-a",
      })),
      { id: "b0", projectId: "project-b" },
    ]);
    mocks.claim.mockResolvedValue(false);
    await SeoActionVerifier.runDue(10, NOW);
    expect(mocks.claim.mock.calls.map((call) => call[0])).toEqual([
      "a0",
      "a1",
      "a2",
      "a3",
      "a4",
      "b0",
    ]);
  });

  it("starts no action when the run budget is already spent", async () => {
    mocks.findMany.mockResolvedValue([{ id: "a0", projectId: "project-a" }]);
    expect(await SeoActionVerifier.runDue(10, NOW, { budgetMs: 0 })).toBe(0);
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it("counts a busy action as not processed", async () => {
    mocks.findMany.mockResolvedValue([{ id: "a0", projectId: "project-a" }]);
    mocks.claim.mockResolvedValue(false);
    expect(await SeoActionVerifier.runDue(10, NOW)).toBe(0);
  });
});

describe("runAction", () => {
  it("reports 'busy' when the lease is taken", async () => {
    mocks.claim.mockResolvedValue(false);
    const result = await SeoActionVerifier.runAction("action-1", { now: NOW });
    expect(result).toEqual({ status: "busy", fetches: 0 });
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("returns 'deadline' and keeps nextCheckAt when time runs out before a fetch", async () => {
    load(actionViewFixture({ kind: "TITLE_META", appliedAt: daysAgo(2) }));
    const result = await SeoActionVerifier.runAction("action-1", {
      now: NOW,
      remaining: () => 0,
    });
    expect(result.status).toBe("deadline");
    expect(mocks.checkPage).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledWith(
      "action-1",
      expect.stringMatching(/^verify:/),
      {},
    );
  });

  it("skips and pushes the next check when the project is not active", async () => {
    load(actionViewFixture({ kind: "TITLE_META" }));
    mocks.projectFindUnique.mockResolvedValue({ status: "PAUSED" });
    const result = await SeoActionVerifier.runAction("action-1", { now: NOW });
    expect(result.status).toBe("skipped");
    expect(mocks.release.mock.calls[0]![2]).toEqual({
      nextCheckAt: new Date(NOW.getTime() + DAY),
    });
  });

  it("verifies an alert-sourced action only when the alert was resolved after it was applied", async () => {
    const appliedAt = daysAgo(3);
    load(
      actionViewFixture({
        kind: "TECH_FIX",
        linkId: null,
        appliedAt,
        proposal: alertProposal("TECH_FIX", "SEO_KEY_PAGE_NOINDEX", "SEO"),
      }),
    );
    mocks.alertFindUnique.mockResolvedValue({
      status: "RESOLVED",
      resolvedAt: daysAgo(5),
    });
    const stale = await SeoActionVerifier.runAction("action-1", { now: NOW });
    expect(stale.status).toBe("pending");
    expect(mocks.startMeasuring).not.toHaveBeenCalled();
    expect(mocks.release.mock.calls[0]![2]).toMatchObject({
      nextCheckAt: new Date(NOW.getTime() + DAY),
    });

    mocks.alertFindUnique.mockResolvedValue({
      status: "RESOLVED",
      resolvedAt: daysAgo(1),
    });
    const fresh = await SeoActionVerifier.runAction("action-1", { now: NOW });
    expect(fresh.status).toBe("measuring");
    expect(mocks.startMeasuring.mock.calls[0]![0]).toMatchObject({
      method: "ALERT",
      owner: expect.stringMatching(/^verify:/),
    });
  });

  describe("inspection alerts", () => {
    function richPages(count: number) {
      const pages = Array.from({ length: count }, (_, index) => ({
        url: `https://example.com/p${index}`,
        urlHash: `hash-${index}`,
      }));
      const inspections = new Map(
        pages.map((page) => [
          page.urlHash,
          {
            googleCanonical: null,
            userCanonical: null,
            richResults: {
              verdict: "FAIL",
              items: [
                {
                  type: "FAQ",
                  issues: [{ severity: "ERROR", message: "bad" }],
                },
              ],
            },
          },
        ]),
      );
      return { pages, inspections };
    }

    it("asks Google to recheck up to five affected key pages once, then again after three days", async () => {
      process.env.GSC_SYNC = "true";
      const { pages, inspections } = richPages(7);
      mocks.forProject.mockResolvedValue({ id: "site-1" });
      mocks.keyPagesFor.mockResolvedValue(pages);
      mocks.readInspectionsFor.mockResolvedValue(inspections);
      mocks.requestInspection.mockResolvedValue("queued");
      mocks.alertFindUnique.mockResolvedValue({
        status: "OPEN",
        resolvedAt: null,
      });
      const view = (requestedAt: Date | null) =>
        actionViewFixture({
          kind: "SCHEMA",
          appliedAt: daysAgo(4),
          proposal: alertProposal("SCHEMA", "GSC_RICH_RESULTS"),
          verification: {
            ...actionViewFixture().verification,
            google: requestedAt
              ? {
                  state: "pending",
                  requestedAt: requestedAt.toISOString(),
                  lastCrawlTime: null,
                  verdict: null,
                  richResultsVerdict: null,
                  checkedAt: null,
                }
              : null,
          },
        });

      load(view(null));
      await SeoActionVerifier.runAction("action-1", { now: NOW });
      expect(mocks.requestInspection).toHaveBeenCalledTimes(5);
      expect(mocks.requestInspection.mock.calls[0]![0]).toMatchObject({
        by: "watchdog",
        projectId: "project-1",
      });
      const stored = mocks.release.mock.calls[0]![2].verification;
      expect(stored.google.requestedAt).toBe(NOW.toISOString());

      mocks.requestInspection.mockClear();
      load(view(daysAgo(1)));
      await SeoActionVerifier.runAction("action-1", { now: NOW });
      expect(mocks.requestInspection).not.toHaveBeenCalled();

      load(view(daysAgo(3)));
      await SeoActionVerifier.runAction("action-1", { now: NOW });
      expect(mocks.requestInspection).toHaveBeenCalledTimes(5);
    });
  });

  it("asks about a CWV fix at day 35, not at day 14", async () => {
    const view = (days: number) =>
      actionViewFixture({
        kind: "CWV_FIX",
        linkId: null,
        appliedAt: daysAgo(days),
        proposal: alertProposal("CWV_FIX", "SEO_CWV_POOR", "SEO"),
      });
    mocks.alertFindUnique.mockResolvedValue({
      status: "OPEN",
      resolvedAt: null,
    });

    load(view(20));
    const early = await SeoActionVerifier.runAction("action-1", { now: NOW });
    expect(early.status).toBe("pending");
    expect(mocks.release.mock.calls[0]![2].askedAt).toBeUndefined();

    load(view(36));
    const late = await SeoActionVerifier.runAction("action-1", { now: NOW });
    expect(late.status).toBe("asked");
    expect(mocks.release.mock.calls[1]![2].askedAt).toEqual(NOW);
  });

  it("expires an unverified action after its expiry day and frees the open key", async () => {
    load(
      actionViewFixture({
        kind: "TECH_FIX",
        appliedAt: daysAgo(50),
        proposal: techProposal("NOINDEX"),
      }),
    );
    mocks.checkPage.mockResolvedValue({
      ok: true,
      page: observed({ noindex: true }),
      text: null,
    });
    const result = await SeoActionVerifier.runAction("action-1", { now: NOW });
    expect(result.status).toBe("expired");
    expect(mocks.release.mock.calls[0]![2]).toMatchObject({
      status: "EXPIRED",
      openKey: null,
      nextCheckAt: null,
    });
  });

  describe("article discovery", () => {
    it("turns a found article into APPLIED DETECTED and starts measuring", async () => {
      load(
        actionViewFixture({
          kind: "NEW_CONTENT",
          status: "ACCEPTED",
          appliedAt: null,
          appliedVia: null,
          creativeId: "creative-1",
          findingId: "finding-1",
          proposal: articleProposal(null),
        }),
      );
      const firstSeenAt = daysAgo(2);
      mocks.findPublishedPage.mockResolvedValue({
        url: "https://example.com/blog/blue-widgets",
        firstSeenAt,
      });
      mocks.updateMany.mockResolvedValue({ count: 1 });
      const result = await SeoActionVerifier.runAction("action-1", {
        now: NOW,
      });
      expect(result.status).toBe("detected");
      expect(mocks.updateMany.mock.calls[0]![0]).toMatchObject({
        where: { status: "ACCEPTED" },
        data: {
          status: "APPLIED",
          appliedVia: "DETECTED",
          appliedAt: firstSeenAt,
          targetUrl: "https://example.com/blog/blue-widgets",
        },
      });
      expect(mocks.markFindingDone).toHaveBeenCalledWith(
        expect.objectContaining({ findingId: "finding-1", userId: null }),
      );
      expect(mocks.startMeasuring.mock.calls[0]![0]).toMatchObject({
        method: "DETECTED",
        verifiedAt: firstSeenAt,
      });
      // Bulgu önce DONE olur, ölçüm sonra vadeyi uzatır.
      expect(mocks.markFindingDone.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.startMeasuring.mock.invocationCallOrder[0]!,
      );
    });

    it("checks the live URL first when the user gave one", async () => {
      load(
        actionViewFixture({
          kind: "NEW_CONTENT",
          status: "ACCEPTED",
          creativeId: "creative-1",
          proposal: articleProposal("https://example.com/blog/live"),
        }),
      );
      mocks.checkPage.mockResolvedValue({
        ok: true,
        page: observed({ url: "https://example.com/blog/live" }),
        text: null,
      });
      mocks.updateMany.mockResolvedValue({ count: 1 });
      await SeoActionVerifier.runAction("action-1", { now: NOW });
      expect(mocks.checkPage).toHaveBeenCalledTimes(1);
      expect(mocks.findPublishedPage).not.toHaveBeenCalled();
      expect(mocks.startMeasuring).toHaveBeenCalledTimes(1);
    });

    it("tries again tomorrow when nothing was published yet", async () => {
      load(
        actionViewFixture({
          kind: "NEW_CONTENT",
          status: "ACCEPTED",
          creativeId: "creative-1",
          proposal: articleProposal(null),
        }),
      );
      mocks.findPublishedPage.mockResolvedValue(null);
      const result = await SeoActionVerifier.runAction("action-1", {
        now: NOW,
      });
      expect(result.status).toBe("pending");
      expect(mocks.release.mock.calls[0]![2]).toEqual({
        nextCheckAt: new Date(NOW.getTime() + DAY),
      });
    });
  });

  describe("Google stage", () => {
    const techFix = (overrides: Partial<SeoActionView> = {}) =>
      actionViewFixture({
        kind: "TECH_FIX",
        appliedAt: daysAgo(2),
        proposal: techProposal("NOINDEX"),
        ...overrides,
      });

    beforeEach(() => {
      mocks.checkPage.mockResolvedValue({
        ok: true,
        page: observed({ noindex: false }),
        text: null,
      });
    });

    it("waits for Google after the crawler verified the change and asks for one inspection", async () => {
      process.env.GSC_SYNC = "true";
      load(techFix());
      mocks.requestInspection.mockResolvedValue("queued");
      const result = await SeoActionVerifier.runAction("action-1", {
        now: NOW,
      });
      expect(result.status).toBe("verified");
      expect(mocks.requestInspection).toHaveBeenCalledTimes(1);
      const data = mocks.release.mock.calls[0]![2];
      expect(data).toMatchObject({
        status: "VERIFIED",
        verifiedAt: NOW,
        nextCheckAt: new Date(NOW.getTime() + 3 * DAY),
      });
      expect(data.verification.google).toMatchObject({
        state: "pending",
        requestedAt: NOW.toISOString(),
      });
      expect(mocks.startMeasuring).not.toHaveBeenCalled();
    });

    it("leaves requestedAt empty when the inspection queue is full", async () => {
      process.env.GSC_SYNC = "true";
      load(techFix());
      mocks.requestInspection.mockResolvedValue("full");
      await SeoActionVerifier.runAction("action-1", { now: NOW });
      expect(
        mocks.release.mock.calls[0]![2].verification.google.requestedAt,
      ).toBeNull();
    });

    it("goes straight to measuring when inspection is not available", async () => {
      process.env.GSC_SYNC = "true";
      process.env.GSC_ROLLOUT_PROJECTS = "some-other-project";
      load(techFix());
      const result = await SeoActionVerifier.runAction("action-1", {
        now: NOW,
      });
      expect(result.status).toBe("measuring");
      expect(mocks.requestInspection).not.toHaveBeenCalled();
      expect(mocks.startMeasuring.mock.calls[0]![0]).toMatchObject({
        method: "CRAWLER",
        googleCrawlAt: null,
      });
    });

    it("measures from the crawl time once Google has seen a verified content refresh", async () => {
      process.env.GSC_SYNC = "true";
      const lastCrawlTime = daysAgo(1);
      load(
        actionViewFixture({
          kind: "CONTENT_REFRESH",
          status: "VERIFIED",
          appliedAt: daysAgo(5),
          verifiedAt: daysAgo(4),
          targetUrlHash: "target-hash",
        }),
      );
      mocks.readInspectionsFor.mockResolvedValue(
        new Map([
          [
            "target-hash",
            { lastCrawlTime, verdict: "PASS", richResults: null },
          ],
        ]),
      );
      const result = await SeoActionVerifier.runAction("action-1", {
        now: NOW,
      });
      expect(result.status).toBe("measuring");
      const call = mocks.startMeasuring.mock.calls[0]![0];
      expect(call.googleCrawlAt).toEqual(lastCrawlTime);
      expect(call.verifiedAt).toEqual(daysAgo(4));
      expect(call.verification.google).toMatchObject({ state: "seen" });
    });

    it("keeps waiting while Google has not crawled, then gives up after 21 days", async () => {
      process.env.GSC_SYNC = "true";
      mocks.readInspectionsFor.mockResolvedValue(new Map());
      mocks.requestInspection.mockResolvedValue("queued");
      const view = (verifiedDaysAgo: number, requestedDaysAgo: number) =>
        actionViewFixture({
          kind: "CONTENT_REFRESH",
          status: "VERIFIED",
          appliedAt: daysAgo(verifiedDaysAgo + 1),
          verifiedAt: daysAgo(verifiedDaysAgo),
          targetUrlHash: "target-hash",
          verification: {
            ...actionViewFixture().verification,
            google: {
              state: "pending",
              requestedAt: daysAgo(requestedDaysAgo).toISOString(),
              lastCrawlTime: null,
              verdict: null,
              richResultsVerdict: null,
              checkedAt: null,
            },
          },
        });

      load(view(5, 4));
      const waiting = await SeoActionVerifier.runAction("action-1", {
        now: NOW,
      });
      expect(waiting.status).toBe("pending");
      expect(mocks.requestInspection).toHaveBeenCalledTimes(1);
      expect(mocks.release.mock.calls[0]![2].nextCheckAt).toEqual(
        new Date(NOW.getTime() + 3 * DAY),
      );

      load(view(22, 2));
      const gaveUp = await SeoActionVerifier.runAction("action-1", {
        now: NOW,
      });
      expect(gaveUp.status).toBe("measuring");
      expect(mocks.startMeasuring.mock.calls[0]![0]).toMatchObject({
        googleCrawlAt: null,
      });
      expect(
        mocks.startMeasuring.mock.calls[0]![0].verification.google.state,
      ).toBe("not_seen");
    });
  });
});
