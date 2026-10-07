import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { actionViewFixture } from "@/lib/seo/actions/test-support";
import type { SeoActionView } from "@/lib/seo/actions/types";

// Bu dosyanın kanıtladığı (SC-F6 "Fix this" / "Done" / "I fixed this"): INVESTIGATE
// düzeltilemez; kartlı türler deterministik kimlikli Work ve kart açar, ikinci
// çağrı aynı eylemi ve kartı bulur, silinmiş kart aynı kimliklerle yeniden
// kurulur; anahtar kelime hiçbir kart alanına girmez; kartsız türler kontrol
// listesine gider; gölge ya da başka projenin bulgusu bulunamaz; Done eylemi
// APPLIED açar ya da "To do"yu uygular; sağlık düzeltmesi yalnız
// HEALTH_FIX_KINDS'i eşler ve SEO kaynaklı uyarıda linkId null olur.

const mocks = vi.hoisted(() => ({
  prisma: {
    seoFinding: { findFirst: vi.fn() },
    gscSiteLink: { findFirst: vi.fn() },
    project: { findFirst: vi.fn() },
    adsAlert: { findFirst: vi.fn(), findMany: vi.fn() },
    seoAction: { findMany: vi.fn() },
  },
  createSeoAction: vi.fn(),
  findOpenAction: vi.fn(),
  transitionAction: vi.fn(),
  attachCard: vi.fn(),
  updateProposal: vi.fn(),
  decideFinding: vi.fn(),
  pageCheckSite: vi.fn(),
  readCrawledPage: vi.fn(),
  readTarget: vi.fn(),
  createSeoManagerCard: vi.fn(),
  readSeoCard: vi.fn(),
  runAction: vi.fn(),
  primaryGscLink: vi.fn(),
  afterFns: [] as (() => unknown)[],
}));

vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("next/server", () => ({
  after: (fn: () => unknown) => {
    mocks.afterFns.push(fn);
  },
}));
vi.mock("@/server/seo/actions/store", () => ({
  createSeoAction: mocks.createSeoAction,
  findOpenAction: mocks.findOpenAction,
  transitionAction: mocks.transitionAction,
  attachCard: mocks.attachCard,
  updateProposal: mocks.updateProposal,
}));
vi.mock("@/server/seo/opportunities/findings-store", () => ({
  decideFinding: mocks.decideFinding,
  findingViewOf: (row: { view: unknown }) => row.view,
}));
vi.mock("@/server/seo/actions/page-check", () => ({
  pageCheckSite: mocks.pageCheckSite,
  readCrawledPage: mocks.readCrawledPage,
}));
vi.mock("@/server/modules/seo/target", () => ({
  readTarget: mocks.readTarget,
}));
vi.mock("@/server/modules/seo/new-card", () => ({
  createSeoManagerCard: mocks.createSeoManagerCard,
}));
vi.mock("@/server/modules/seo/card", () => ({
  readSeoCard: mocks.readSeoCard,
}));
vi.mock("@/server/seo/actions/verify", () => ({
  SeoActionVerifier: { runAction: mocks.runAction },
}));
vi.mock("@/server/seo/store", () => ({
  primaryGscLink: mocks.primaryGscLink,
}));

const {
  fixFinding,
  trackFindingDone,
  trackHealthFix,
  loadFixThisStates,
  loadHealthFixStates,
} = await import("./fix-this");

const NOW = new Date("2026-10-07T10:00:00.000Z");
const KEYWORD = "blue widgets cheap";

type ViewOverrides = { actionKind?: string; pages?: unknown[] };

function findingRow(
  overrides: ViewOverrides & { status?: string } = {},
): Record<string, unknown> {
  const pages = overrides.pages ?? [
    {
      pageId: "page-1",
      url: "https://example.com/pricing",
      path: "/pricing",
      clicks: 10,
      impressions: 500,
      position: 8,
    },
  ];
  return {
    id: "finding-1",
    projectId: "project-1",
    linkId: "link-1",
    status: overrides.status ?? "OPEN",
    view: {
      id: "finding-1",
      ruleKey: "SO1_STRIKING_DISTANCE",
      actionKind: overrides.actionKind ?? "TITLE_META",
      pageId: "page-1",
      queryId: "query-1",
      keyword: KEYWORD,
      evidence: {
        pages,
        queries: [
          {
            queryId: "query-1",
            text: KEYWORD,
            clicks: 5,
            impressions: 400,
            position: 8,
          },
        ],
      },
    },
  };
}

function created(input: Record<string, unknown>) {
  return {
    action: actionViewFixture({
      id: "act-1",
      kind: input.kind as SeoActionView["kind"],
      status: input.status as SeoActionView["status"],
      source: input.source as SeoActionView["source"],
      proposal: input.proposal as SeoActionView["proposal"],
      targetUrl: (input.targetUrl as string | null) ?? null,
      linkId: (input.linkId as string | null | undefined) ?? null,
      findingId: (input.findingId as string | null | undefined) ?? null,
    }),
    created: true,
  };
}

const BASELINE = {
  url: "https://example.com/pricing",
  status: 200,
  title: "Pricing",
  metaDescription: "Our prices",
  h1: "Pricing",
  h2: [],
  canonical: null,
  noindex: false,
  indexable: true,
  wordCount: 300,
  textHash: "hash",
  schemaTypes: [],
  schemaErrors: 0,
  fetchedAt: "2026-10-07T09:00:00.000Z",
  source: "FETCH" as const,
};

const base = {
  projectId: "project-1",
  findingId: "finding-1",
  userId: "user-1",
  workspaceId: "workspace-1",
  brandId: "brand-1",
  now: NOW,
};

beforeEach(() => {
  // Fixture satırları gerçek kip (isMock: false); CI'nın mock kipi sızmasın.
  vi.stubEnv("AGENTELSE_PROVIDER_MODE", "live");
  mocks.afterFns.length = 0;
  mocks.prisma.seoFinding.findFirst.mockResolvedValue(findingRow());
  mocks.prisma.gscSiteLink.findFirst.mockResolvedValue({
    id: "link-1",
    siteUrl: "sc-domain:example.com",
  });
  mocks.prisma.project.findFirst.mockResolvedValue({ language: "en" });
  mocks.pageCheckSite.mockResolvedValue({
    siteId: "site-1",
    origin: "https://example.com",
  });
  mocks.findOpenAction.mockResolvedValue(null);
  mocks.createSeoAction.mockImplementation(async (input) => created(input));
  mocks.decideFinding.mockResolvedValue({ ok: true, status: "ACCEPTED" });
  mocks.readTarget.mockResolvedValue({
    ok: true,
    target: {
      url: "https://example.com/pricing",
      path: "/pricing",
      title: "Pricing",
      metaDescription: "Our prices",
      h1: "Pricing",
      h2: [],
      wordCount: 300,
      textHash: "hash",
      fetchedAt: "2026-10-07T09:00:00.000Z",
      queryCount: 12,
    },
    baseline: BASELINE,
    text: null,
  });
  mocks.readSeoCard.mockResolvedValue(null);
  mocks.createSeoManagerCard.mockImplementation(async (input) => ({
    workId: input.work.id,
    commandId: input.commandId,
    created: true,
  }));
  mocks.readCrawledPage.mockResolvedValue({ snapshot: BASELINE });
  mocks.transitionAction.mockResolvedValue({ ok: true });
  mocks.primaryGscLink.mockResolvedValue({
    id: "link-1",
    siteUrl: "sc-domain:example.com",
    isMock: false,
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("fixFinding", () => {
  it("refuses INVESTIGATE: it needs a closer look", async () => {
    mocks.prisma.seoFinding.findFirst.mockResolvedValue(
      findingRow({ actionKind: "INVESTIGATE" }),
    );
    const result = await fixFinding(base);
    expect(result).toEqual({
      ok: false,
      message: "This one needs a closer look rather than a single fix.",
    });
    expect(mocks.createSeoAction).not.toHaveBeenCalled();
    expect(mocks.decideFinding).not.toHaveBeenCalled();
  });

  it("opens a snippet card for a snippet finding", async () => {
    const result = await fixFinding(base);
    expect(result).toEqual({
      ok: true,
      actionId: "act-1",
      href: "/projects/project-1?work=seofix_act-1",
      opened: "manager",
    });
    expect(mocks.createSeoAction).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "TITLE_META",
        source: "FINDING",
        status: "ACCEPTED",
        openKey: "finding:finding-1",
        findingId: "finding-1",
        linkId: "link-1",
        targetUrl: "https://example.com/pricing",
        targetQueries: ["query-1"],
      }),
    );
    expect(mocks.decideFinding).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        findingId: "finding-1",
        decision: "ACCEPT",
        userId: "user-1",
      }),
    );
    expect(mocks.createSeoManagerCard).toHaveBeenCalledTimes(1);
    const card = mocks.createSeoManagerCard.mock.calls[0]![0];
    expect(card.mode).toBe("snippet");
    expect(card.work.id).toBe("seofix_act-1");
    expect(card.commandId).toBe("seofixcard_act-1");
    expect(card.work.title).toBe("Title and description · /pricing");
    expect(card.state.origin).toEqual({
      findingId: "finding-1",
      ruleKey: "SO1_STRIKING_DISTANCE",
    });
    expect(card.state.actionId).toBe("act-1");
    expect(card.state.target.path).toBe("/pricing");
    expect(card.state.brief).toEqual({
      topic: "Pricing",
      siteUrl: "https://example.com",
      language: "en",
      audience: "",
    });
    expect(mocks.attachCard).toHaveBeenCalledWith({
      projectId: "project-1",
      actionId: "act-1",
      commandId: "seofixcard_act-1",
      workId: "seofix_act-1",
    });
    // Önceki başlık ve açıklama ilk taramadan teklife yazılır.
    const update = mocks.updateProposal.mock.calls[0]![0];
    expect(update.baseline).toEqual(BASELINE);
    expect(update.proposal.before).toEqual({
      title: "Pricing",
      metaDescription: "Our prices",
    });
  });

  it("never puts the Search Console keyword into the card", async () => {
    await fixFinding(base);
    expect(JSON.stringify(mocks.createSeoManagerCard.mock.calls)).not.toContain(
      "blue widgets",
    );
  });

  it("does not decide the finding again when it is already accepted", async () => {
    mocks.prisma.seoFinding.findFirst.mockResolvedValue(
      findingRow({ status: "ACCEPTED" }),
    );
    await fixFinding(base);
    expect(mocks.decideFinding).not.toHaveBeenCalled();
  });

  it("reuses the action and the card on a second tap", async () => {
    mocks.findOpenAction.mockResolvedValue(
      actionViewFixture({
        id: "act-1",
        kind: "TITLE_META",
        status: "ACCEPTED",
        commandId: "seofixcard_act-1",
        workId: "seofix_act-1",
      }),
    );
    mocks.readSeoCard.mockResolvedValue({
      card: {},
      step: "brief",
      state: {},
      workId: "seofix_act-1",
    });
    const result = await fixFinding(base);
    expect(result).toMatchObject({
      ok: true,
      actionId: "act-1",
      href: "/projects/project-1?work=seofix_act-1",
    });
    expect(mocks.createSeoAction).not.toHaveBeenCalled();
    expect(mocks.createSeoManagerCard).not.toHaveBeenCalled();
    expect(mocks.attachCard).not.toHaveBeenCalled();
  });

  it("recreates a deleted card with the same ids", async () => {
    mocks.findOpenAction.mockResolvedValue(
      actionViewFixture({
        id: "act-1",
        kind: "TITLE_META",
        status: "ACCEPTED",
        commandId: "seofixcard_act-1",
        workId: "seofix_act-1",
      }),
    );
    mocks.readSeoCard.mockResolvedValue(null);
    const result = await fixFinding(base);
    expect(result).toMatchObject({
      ok: true,
      href: "/projects/project-1?work=seofix_act-1",
    });
    expect(mocks.createSeoAction).not.toHaveBeenCalled();
    const card = mocks.createSeoManagerCard.mock.calls[0]![0];
    expect(card.work.id).toBe("seofix_act-1");
    expect(card.commandId).toBe("seofixcard_act-1");
  });

  it("opens an article card with an empty topic and no keyword for NEW_CONTENT", async () => {
    mocks.prisma.seoFinding.findFirst.mockResolvedValue(
      findingRow({ actionKind: "NEW_CONTENT", pages: [] }),
    );
    const result = await fixFinding(base);
    expect(result).toMatchObject({ ok: true, opened: "manager" });
    const card = mocks.createSeoManagerCard.mock.calls[0]![0];
    expect(card.mode).toBe("article");
    expect(card.state.brief.topic).toBe("");
    expect(card.state.brief.siteUrl).toBe("https://example.com");
    expect(JSON.stringify(card)).not.toContain("blue widgets");
    expect(mocks.readTarget).not.toHaveBeenCalled();
    // Anahtar kelime yalnız eylemin teklifinde durur.
    expect(
      mocks.createSeoAction.mock.calls[0]![0].proposal.primaryKeyword,
    ).toBe(KEYWORD);
  });

  it("falls back to a pending address when the page cannot be read", async () => {
    mocks.readTarget.mockResolvedValue({ ok: false, message: "nope" });
    await fixFinding(base);
    const card = mocks.createSeoManagerCard.mock.calls[0]![0];
    expect(card.state.pendingUrl).toBe("https://example.com/pricing");
    expect(card.state.target).toBeUndefined();
    expect(mocks.updateProposal).not.toHaveBeenCalled();
  });

  it("sends checklist kinds to the Actions & results anchor", async () => {
    mocks.prisma.seoFinding.findFirst.mockResolvedValue(
      findingRow({ actionKind: "INTERNAL_LINKS" }),
    );
    const result = await fixFinding(base);
    expect(result).toEqual({
      ok: true,
      actionId: "act-1",
      href: "/projects/project-1/arama?action=act-1#actions",
      opened: "checklist",
    });
    expect(mocks.createSeoManagerCard).not.toHaveBeenCalled();
    expect(mocks.decideFinding).toHaveBeenCalled();
  });

  it("only finds open, non-shadow findings of this project", async () => {
    mocks.prisma.seoFinding.findFirst.mockResolvedValue(null);
    const result = await fixFinding(base);
    expect(result).toEqual({
      ok: false,
      message: "This opportunity is no longer open.",
    });
    expect(mocks.prisma.seoFinding.findFirst).toHaveBeenCalledWith({
      where: {
        id: "finding-1",
        projectId: "project-1",
        shadow: false,
        status: { in: ["OPEN", "ACCEPTED"] },
      },
    });
    expect(mocks.createSeoAction).not.toHaveBeenCalled();
  });

  it("refuses a finding whose link is not a current-mode link of the project", async () => {
    mocks.prisma.gscSiteLink.findFirst.mockResolvedValue(null);
    const result = await fixFinding(base);
    expect(result.ok).toBe(false);
    expect(mocks.prisma.gscSiteLink.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "link-1", projectId: "project-1", isMock: false },
      }),
    );
    expect(mocks.createSeoAction).not.toHaveBeenCalled();
  });

  it("reports a friendly message when the card cannot be created", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.createSeoManagerCard.mockRejectedValue(new Error("db down"));
    const result = await fixFinding(base);
    expect(result).toEqual({
      ok: false,
      message: "We couldn't open the SEO Manager. Try again.",
    });
  });
});

describe("trackFindingDone", () => {
  it("creates an APPLIED action when none is open, then verifies once", async () => {
    await trackFindingDone({
      projectId: "project-1",
      findingId: "finding-1",
      userId: "user-1",
      workspaceId: "workspace-1",
      now: NOW,
    });
    expect(mocks.createSeoAction).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "APPLIED",
        source: "OPPORTUNITY_DONE",
        openKey: "finding:finding-1",
        linkId: "link-1",
        findingId: "finding-1",
        baseline: BASELINE,
      }),
    );
    expect(mocks.transitionAction).not.toHaveBeenCalled();
    expect(mocks.afterFns).toHaveLength(1);
    await mocks.afterFns[0]!();
    expect(mocks.runAction).toHaveBeenCalledWith("act-1");
  });

  it("applies an ACCEPTED action instead of creating a second one", async () => {
    mocks.findOpenAction.mockResolvedValue(
      actionViewFixture({ id: "act-9", status: "ACCEPTED" }),
    );
    await trackFindingDone({
      projectId: "project-1",
      findingId: "finding-1",
      userId: "user-1",
      workspaceId: "workspace-1",
      now: NOW,
    });
    expect(mocks.createSeoAction).not.toHaveBeenCalled();
    expect(mocks.transitionAction).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: "act-9",
        event: "APPLY",
        userId: "user-1",
      }),
    );
    await mocks.afterFns[0]!();
    expect(mocks.runAction).toHaveBeenCalledWith("act-9");
  });

  it("leaves an already applied action alone", async () => {
    mocks.findOpenAction.mockResolvedValue(
      actionViewFixture({ id: "act-9", status: "APPLIED" }),
    );
    await trackFindingDone({
      projectId: "project-1",
      findingId: "finding-1",
      userId: "user-1",
      workspaceId: "workspace-1",
    });
    expect(mocks.transitionAction).not.toHaveBeenCalled();
    expect(mocks.afterFns).toHaveLength(0);
  });

  it("ignores INVESTIGATE and unknown findings", async () => {
    mocks.prisma.seoFinding.findFirst.mockResolvedValueOnce(
      findingRow({ actionKind: "INVESTIGATE" }),
    );
    await trackFindingDone({
      projectId: "project-1",
      findingId: "finding-1",
      userId: "user-1",
      workspaceId: "workspace-1",
    });
    mocks.prisma.seoFinding.findFirst.mockResolvedValueOnce(null);
    await trackFindingDone({
      projectId: "project-1",
      findingId: "finding-2",
      userId: "user-1",
      workspaceId: "workspace-1",
    });
    expect(mocks.createSeoAction).not.toHaveBeenCalled();
  });
});

function alertRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "alert-1",
    kind: "SEO_KEY_PAGE_NOINDEX",
    source: "SEO",
    dedupeKey: "seo:noindex:home",
    data: null,
    ...overrides,
  };
}

describe("trackHealthFix", () => {
  const input = {
    projectId: "project-1",
    alertId: "alert-1",
    userId: "user-1",
    workspaceId: "workspace-1",
    now: NOW,
  };

  it("only looks at open GSC and SEO alerts of this project", async () => {
    mocks.prisma.adsAlert.findFirst.mockResolvedValue(null);
    const result = await trackHealthFix(input);
    expect(result).toEqual({
      ok: false,
      message: "This issue is no longer open.",
    });
    expect(mocks.prisma.adsAlert.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "alert-1",
          projectId: "project-1",
          source: { in: ["GSC", "SEO"] },
          status: { in: ["OPEN", "ACKED", "MUTED"] },
        },
      }),
    );
    expect(mocks.createSeoAction).not.toHaveBeenCalled();
  });

  it("creates an APPLIED crawl-only action for an SEO alert", async () => {
    mocks.prisma.adsAlert.findFirst.mockResolvedValue(alertRow());
    const result = await trackHealthFix(input);
    expect(result).toEqual({ ok: true, actionId: "act-1" });
    const call = mocks.createSeoAction.mock.calls[0]![0];
    expect(call).toMatchObject({
      kind: "TECH_FIX",
      source: "HEALTH_ISSUE",
      status: "APPLIED",
      openKey: "alert:seo:noindex:home",
      linkId: null,
    });
    // Yol yoksa ana sayfa varsayılmaz.
    expect(call.targetUrl).toBeNull();
  });

  it("leaves the link to the store for a GSC alert", async () => {
    mocks.prisma.adsAlert.findFirst.mockResolvedValue(
      alertRow({
        kind: "GSC_CANONICAL_MISMATCH",
        source: "GSC",
        dedupeKey: "gsc:canon",
        data: { paths: ["/pricing"] },
      }),
    );
    await trackHealthFix(input);
    const call = mocks.createSeoAction.mock.calls[0]![0];
    expect("linkId" in call).toBe(false);
    expect(call.targetUrl).toBe("https://example.com/pricing");
    expect(call.proposal.alert).toEqual({
      kind: "GSC_CANONICAL_MISMATCH",
      dedupeKey: "gsc:canon",
      source: "GSC",
    });
  });

  it("has no target when the alert lists several paths", async () => {
    mocks.prisma.adsAlert.findFirst.mockResolvedValue(
      alertRow({ data: { paths: ["/a", "/b"] } }),
    );
    await trackHealthFix(input);
    expect(mocks.createSeoAction.mock.calls[0]![0].targetUrl).toBeNull();
  });

  it("rejects alert kinds that are not fixable changes", async () => {
    mocks.prisma.adsAlert.findFirst.mockResolvedValue(
      alertRow({ kind: "SEO_SITE_DOWN" }),
    );
    const result = await trackHealthFix(input);
    expect(result).toEqual({
      ok: false,
      message: "This issue can't be tracked as a change.",
    });
    expect(mocks.createSeoAction).not.toHaveBeenCalled();
    mocks.prisma.adsAlert.findFirst.mockResolvedValue(
      alertRow({ kind: "constructor" }),
    );
    expect((await trackHealthFix(input)).ok).toBe(false);
  });

  it("returns the open action instead of creating a second one", async () => {
    mocks.prisma.adsAlert.findFirst.mockResolvedValue(alertRow());
    mocks.findOpenAction.mockResolvedValue(
      actionViewFixture({ id: "act-7", status: "APPLIED" }),
    );
    expect(await trackHealthFix(input)).toEqual({
      ok: true,
      actionId: "act-7",
    });
    expect(mocks.createSeoAction).not.toHaveBeenCalled();
  });
});

describe("loaders", () => {
  function enable() {
    vi.stubEnv("SEO_ACTIONS", "true");
    vi.stubEnv("SEO_HEALTH", "true");
    vi.stubEnv("SEO_CRAWL", "true");
    vi.stubEnv("AGENTELSE_PROVIDER_MODE", "");
  }

  it("make no database read when the loop is off", async () => {
    expect(await loadFixThisStates("project-1", ["finding-1"])).toEqual({});
    expect(
      await loadHealthFixStates("project-1", [
        { id: "alert-1", kind: "SEO_KEY_PAGE_NOINDEX" },
      ]),
    ).toEqual({});
    expect(mocks.prisma.seoAction.findMany).not.toHaveBeenCalled();
    expect(mocks.prisma.adsAlert.findMany).not.toHaveBeenCalled();
  });

  it("loadFixThisStates maps open actions by finding in one query", async () => {
    enable();
    mocks.prisma.seoAction.findMany.mockResolvedValue([
      {
        id: "act-1",
        openKey: "finding:finding-1",
        status: "ACCEPTED",
        workId: "seofix_act-1",
        commandId: "seofixcard_act-1",
      },
      {
        id: "act-2",
        openKey: "finding:finding-2",
        status: "APPLIED",
        workId: null,
        commandId: null,
      },
    ]);
    const states = await loadFixThisStates("project-1", [
      "finding-1",
      "finding-2",
      "finding-3",
    ]);
    expect(mocks.prisma.seoAction.findMany).toHaveBeenCalledTimes(1);
    expect(states).toEqual({
      "finding-1": {
        actionId: "act-1",
        status: "ACCEPTED",
        statusLabel: "To do",
        href: "/projects/project-1?work=seofix_act-1",
      },
      "finding-2": {
        actionId: "act-2",
        status: "APPLIED",
        statusLabel: "Checking your site",
        href: "/projects/project-1/arama?action=act-2#actions",
      },
    });
  });

  it("loadHealthFixStates reads alerts, then open actions", async () => {
    enable();
    mocks.prisma.adsAlert.findMany.mockResolvedValue([
      { id: "alert-1", dedupeKey: "k1" },
      { id: "alert-2", dedupeKey: "k2" },
    ]);
    mocks.prisma.seoAction.findMany.mockResolvedValue([
      { id: "act-1", openKey: "alert:k1", status: "VERIFIED" },
    ]);
    const states = await loadHealthFixStates("project-1", [
      { id: "alert-1", kind: "SEO_KEY_PAGE_NOINDEX" },
      { id: "alert-2", kind: "SEO_STRUCTURED_DATA" },
      { id: "alert-3", kind: "SEO_SITE_DOWN" },
    ]);
    expect(mocks.prisma.adsAlert.findMany).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.seoAction.findMany).toHaveBeenCalledTimes(1);
    expect(states).toEqual({
      "alert-1": {
        actionId: "act-1",
        status: "VERIFIED",
        statusLabel: "Live · waiting for Google",
      },
      "alert-2": { trackable: true },
    });
  });

  it("loadHealthFixStates skips the query when nothing is fixable", async () => {
    enable();
    expect(
      await loadHealthFixStates("project-1", [
        { id: "alert-3", kind: "SEO_SITE_DOWN" },
      ]),
    ).toEqual({});
    expect(mocks.prisma.adsAlert.findMany).not.toHaveBeenCalled();
  });
});
