import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { changeFixture } from "@/lib/seo/apply/test-support";

// Bu dosyanın kanıtladığı: action-link.ts SC-F6 ile tek bağlantı noktasıdır ve
// SEO_ACTIONS kapalıyken hiçbir sorgu yapmaz; TITLE_META adayları öneri
// metnini taşır; TITLE_META doğrulanınca nihai metin öneriye yazılıp eylem
// APPLY edilir; INTERNAL_LINKS fan-out'u (iki sayfaya yayılan 5 bağlantı)
// birinci doğrulanmış değişiklikten sonra eylemi açık bırakır ve ikincisinden
// sonra tamamlar, remainingLinksOf kalanları verir; PUBLISH_LIVE döngüyü
// kapatır (NEW_CONTENT eylemi liveUrl ile APPLY, Creative PUBLISHED) ve elle
// "Mark as published" ile yan yana idempotenttir; invalid_transition ve her
// hata yutulur; geri alma eylemi yalnız hâlâ APPLIED ise geri sarar.

const mocks = vi.hoisted(() => ({
  changeFindMany: vi.fn(),
  actionFindMany: vi.fn(),
  actionFindFirst: vi.fn(),
  creativeFindFirst: vi.fn(),
  getAction: vi.fn(),
  findOpenAction: vi.fn(),
  transitionAction: vi.fn(),
  updateProposal: vi.fn(),
  fixFinding: vi.fn(),
  creativeTransition: vi.fn(),
  markPublishState: vi.fn(),
  auditRecord: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    seoChange: { findMany: mocks.changeFindMany },
    seoAction: {
      findMany: mocks.actionFindMany,
      findFirst: mocks.actionFindFirst,
    },
    creative: { findFirst: mocks.creativeFindFirst },
  },
}));
vi.mock("@/server/seo/actions/store", () => ({
  getAction: mocks.getAction,
  findOpenAction: mocks.findOpenAction,
  transitionAction: mocks.transitionAction,
  updateProposal: mocks.updateProposal,
}));
vi.mock("@/server/seo/actions/fix-this", () => ({
  fixFinding: mocks.fixFinding,
}));
vi.mock("@/server/repositories/creative.repository", () => ({
  CreativeRepository: { transition: mocks.creativeTransition },
}));
vi.mock("@/server/repositories/idea-chat.repository", () => ({
  IdeaChatRepository: { markCreativePublishState: mocks.markPublishState },
}));
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: mocks.auditRecord },
}));

const {
  listApplyCandidates,
  ensureActionForFinding,
  ensureActionAccepted,
  onChangeVerified,
  onChangeUndone,
  remainingLinksOf,
} = await import("./action-link");

const LINKS = [
  { fromUrl: "https://example.com/a", toUrl: "https://example.com/x", anchor: "one" },
  { fromUrl: "https://example.com/a", toUrl: "https://example.com/y", anchor: "two" },
  { fromUrl: "https://example.com/a", toUrl: "https://example.com/z", anchor: "three" },
  { fromUrl: "https://example.com/b", toUrl: "https://example.com/x", anchor: "four" },
  { fromUrl: "https://example.com/b", toUrl: "https://example.com/y", anchor: "five" },
];

function action(overrides: Record<string, unknown> = {}) {
  return {
    id: "act-1",
    projectId: "proj_1",
    status: "ACCEPTED",
    kind: "TITLE_META",
    findingId: "find-1",
    proposal: {
      v: 1,
      kind: "TITLE_META",
      before: null,
      after: { title: "Old suggestion", metaDescription: "Old description" },
      variants: [],
      note: null,
      alert: null,
    },
    ...overrides,
  };
}

function linksAction(overrides: Record<string, unknown> = {}) {
  return action({
    kind: "INTERNAL_LINKS",
    proposal: {
      v: 1,
      kind: "INTERNAL_LINKS",
      links: LINKS,
      note: null,
      alert: null,
    },
    ...overrides,
  });
}

function linksChange(url: string, toUrls: string[]) {
  return {
    params: {
      kind: "INTERNAL_LINKS",
      url,
      wpType: "page",
      wpId: 1,
      expectModified: "2026-10-01T08:00:00.000Z",
      links: toUrls.map((toUrl) => ({ toUrl, anchor: "x" })),
    },
  };
}

const TITLE_CHANGE = changeFixture({
  kind: "TITLE_META",
  status: "VERIFIED",
  seoActionId: "act-1",
  approvalId: "apr-1",
  approvedByUserId: "owner-1",
  params: {
    kind: "TITLE_META",
    url: "https://example.com/pricing",
    wpType: "page",
    wpId: 42,
    expectModified: "2026-10-01T08:00:00.000Z",
    title: "Final title",
    metaDescription: null,
  },
});

const LINKS_CHANGE = changeFixture({
  kind: "INTERNAL_LINKS",
  status: "VERIFIED",
  seoActionId: "act-1",
  approvalId: "apr-1",
  params: linksChange("https://example.com/a", []).params,
});

const LIVE_CHANGE = changeFixture({
  kind: "PUBLISH_LIVE",
  status: "VERIFIED",
  seoActionId: null,
  creativeId: "cr-1",
  liveUrl: "https://example.com/blog/post",
  approvalId: "apr-2",
  params: {
    kind: "PUBLISH_LIVE",
    draftChangeId: "draft-1",
    wpType: "post",
    wpId: 7,
    link: "https://example.com/blog/post",
    expectModified: "2026-10-01T08:00:00.000Z",
    creativeId: "cr-1",
  },
});

function allMocksUntouched(): void {
  for (const mock of Object.values(mocks)) expect(mock).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("SEO_ACTIONS", "true");
  vi.stubEnv("SEO_HEALTH", "true");
  vi.stubEnv("SEO_CRAWL", "true");
  mocks.transitionAction.mockResolvedValue({ ok: true, action: {} });
  mocks.updateProposal.mockResolvedValue(true);
  mocks.changeFindMany.mockResolvedValue([]);
  mocks.creativeTransition.mockResolvedValue({});
  mocks.markPublishState.mockResolvedValue(true);
  mocks.auditRecord.mockResolvedValue({});
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("inert with SEO_ACTIONS off", () => {
  it.each([
    ["SEO_ACTIONS", "false"],
    ["SEO_CRAWL", "false"],
  ])("%s=%s makes every function a no-op without a query", async (name, value) => {
    vi.stubEnv(name, value);
    expect(await listApplyCandidates("proj_1", { findingIds: ["f"] })).toEqual([]);
    expect(
      await ensureActionForFinding({
        projectId: "proj_1",
        findingId: "f",
        userId: "u",
        workspaceId: "w",
        brandId: "b",
      }),
    ).toEqual({ ok: false });
    expect(await ensureActionAccepted("proj_1", "act-1", "u")).toBe(false);
    await onChangeVerified(TITLE_CHANGE, { userId: "u" });
    await onChangeVerified(LIVE_CHANGE, { userId: "u" });
    expect(await remainingLinksOf("proj_1", "act-1")).toEqual([]);
    await onChangeUndone(TITLE_CHANGE, { userId: "u" });
    allMocksUntouched();
  });
});

describe("listApplyCandidates", () => {
  it("returns TITLE_META candidates with the proposed text", async () => {
    mocks.actionFindMany.mockResolvedValue([
      {
        id: "act-1",
        findingId: "find-1",
        kind: "TITLE_META",
        status: "ACCEPTED",
        targetUrl: "https://example.com/pricing",
        proposal: action().proposal,
      },
      {
        id: "act-2",
        findingId: "find-2",
        kind: "TITLE_META",
        status: "PROPOSED",
        targetUrl: "https://example.com/about",
        proposal: { kind: "TITLE_META", before: null, after: null },
      },
    ]);
    const result = await listApplyCandidates("proj_1", {
      findingIds: ["find-1", "find-2"],
    });
    expect(result).toEqual([
      {
        actionId: "act-1",
        findingId: "find-1",
        kind: "TITLE_META",
        status: "ACCEPTED",
        targetUrl: "https://example.com/pricing",
        after: { title: "Old suggestion", metaDescription: "Old description" },
        links: [],
      },
      {
        actionId: "act-2",
        findingId: "find-2",
        kind: "TITLE_META",
        status: "PROPOSED",
        targetUrl: "https://example.com/about",
        after: null,
        links: [],
      },
    ]);
  });

  it("returns the full proposal links of an INTERNAL_LINKS candidate", async () => {
    mocks.actionFindMany.mockResolvedValue([
      {
        id: "act-1",
        findingId: null,
        kind: "INTERNAL_LINKS",
        status: "ACCEPTED",
        targetUrl: null,
        proposal: linksAction().proposal,
      },
    ]);
    const result = await listApplyCandidates("proj_1", { actionIds: ["act-1"] });
    expect(result[0]?.links).toHaveLength(5);
    expect(result[0]?.after).toBeNull();
  });

  it("makes no query without ids", async () => {
    expect(await listApplyCandidates("proj_1", {})).toEqual([]);
    expect(mocks.actionFindMany).not.toHaveBeenCalled();
  });

  it("returns [] when the query fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.actionFindMany.mockRejectedValue(new Error("db"));
    expect(await listApplyCandidates("proj_1", { findingIds: ["f"] })).toEqual([]);
    spy.mockRestore();
  });
});

describe("ensureActionForFinding and ensureActionAccepted", () => {
  const input = {
    projectId: "proj_1",
    findingId: "find-1",
    userId: "u",
    workspaceId: "w",
    brandId: "b",
  };

  it("reuses an existing open action", async () => {
    mocks.findOpenAction.mockResolvedValue({ id: "act-9" });
    expect(await ensureActionForFinding(input)).toEqual({
      ok: true,
      actionId: "act-9",
    });
    expect(mocks.findOpenAction).toHaveBeenCalledWith("proj_1", "finding:find-1");
    expect(mocks.fixFinding).not.toHaveBeenCalled();
  });

  it("opens the action through fixFinding when none exists", async () => {
    mocks.findOpenAction.mockResolvedValue(null);
    mocks.fixFinding.mockResolvedValue({
      ok: true,
      actionId: "act-3",
      href: "/x",
      opened: "checklist",
    });
    expect(await ensureActionForFinding(input)).toEqual({
      ok: true,
      actionId: "act-3",
    });
    mocks.fixFinding.mockResolvedValue({ ok: false, message: "no" });
    expect(await ensureActionForFinding(input)).toEqual({ ok: false });
  });

  it("accepts a PROPOSED action and treats ACCEPTED as ready", async () => {
    mocks.getAction.mockResolvedValue(action({ status: "PROPOSED" }));
    expect(await ensureActionAccepted("proj_1", "act-1", "u")).toBe(true);
    expect(mocks.transitionAction).toHaveBeenCalledWith({
      projectId: "proj_1",
      actionId: "act-1",
      event: "ACCEPT",
      userId: "u",
    });

    mocks.transitionAction.mockClear();
    mocks.getAction.mockResolvedValue(action({ status: "ACCEPTED" }));
    expect(await ensureActionAccepted("proj_1", "act-1", "u")).toBe(true);
    expect(mocks.transitionAction).not.toHaveBeenCalled();

    mocks.getAction.mockResolvedValue(action({ status: "DISMISSED" }));
    expect(await ensureActionAccepted("proj_1", "act-1", "u")).toBe(false);
    mocks.getAction.mockResolvedValue(null);
    expect(await ensureActionAccepted("proj_1", "act-1", "u")).toBe(false);
  });
});

describe("onChangeVerified: TITLE_META", () => {
  it("writes the final text into the proposal, then APPLY with appliedVia CMS and the approval id", async () => {
    mocks.getAction.mockResolvedValue(action());
    await onChangeVerified(TITLE_CHANGE, { userId: "owner-1" });

    // Meta açıklaması değişmedi: önerideki metin korunur.
    expect(mocks.updateProposal).toHaveBeenCalledWith({
      projectId: "proj_1",
      actionId: "act-1",
      proposal: expect.objectContaining({
        kind: "TITLE_META",
        after: { title: "Final title", metaDescription: "Old description" },
      }),
    });
    expect(mocks.transitionAction).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj_1",
        actionId: "act-1",
        event: "APPLY",
        userId: "owner-1",
        appliedVia: "CMS",
        approvalId: "apr-1",
      }),
    );
    expect(
      mocks.updateProposal.mock.invocationCallOrder[0]!,
    ).toBeLessThan(mocks.transitionAction.mock.invocationCallOrder[0]!);
  });

  it("does nothing for a change without an action", async () => {
    await onChangeVerified({ ...TITLE_CHANGE, seoActionId: null }, { userId: "u" });
    expect(mocks.getAction).not.toHaveBeenCalled();
    expect(mocks.transitionAction).not.toHaveBeenCalled();
  });

  it("falls back to the approver when no user id is given", async () => {
    mocks.getAction.mockResolvedValue(action());
    await onChangeVerified(TITLE_CHANGE, { userId: null });
    expect(mocks.transitionAction).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "owner-1" }),
    );
  });

  it("swallows invalid_transition from an action that is already applied", async () => {
    mocks.getAction.mockResolvedValue(action({ status: "APPLIED" }));
    mocks.transitionAction.mockResolvedValue({
      ok: false,
      reason: "invalid_transition",
    });
    await expect(
      onChangeVerified(TITLE_CHANGE, { userId: "u" }),
    ).resolves.toBeUndefined();
  });

  it("never throws, only logs the error name", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.getAction.mockRejectedValue(new TypeError("secret detail"));
    await expect(
      onChangeVerified(TITLE_CHANGE, { userId: "u" }),
    ).resolves.toBeUndefined();
    expect(spy.mock.calls.flat().join(" ")).toContain("TypeError");
    expect(spy.mock.calls.flat().join(" ")).not.toContain("secret detail");
    spy.mockRestore();
  });
});

describe("onChangeVerified: INTERNAL_LINKS fan-out", () => {
  it("keeps the action open after the first page and completes after the second", async () => {
    mocks.getAction.mockResolvedValue(linksAction());

    // 1. sayfa (3 bağlantı) doğrulandı: yalnız o satır var.
    mocks.changeFindMany.mockResolvedValue([
      linksChange("https://example.com/a", [
        "https://example.com/x",
        "https://example.com/y",
        "https://example.com/z",
      ]),
    ]);
    await onChangeVerified(LINKS_CHANGE, { userId: "u" });
    expect(mocks.transitionAction).not.toHaveBeenCalled();
    expect(await remainingLinksOf("proj_1", "act-1")).toEqual([
      LINKS[3],
      LINKS[4],
    ]);

    // 2. sayfa (2 bağlantı) doğrulandı: bütün öneri karşılandı.
    mocks.changeFindMany.mockResolvedValue([
      linksChange("https://example.com/a", [
        "https://example.com/x",
        "https://example.com/y",
        "https://example.com/z",
      ]),
      linksChange("https://example.com/b", [
        "https://example.com/x",
        "https://example.com/y",
      ]),
    ]);
    await onChangeVerified(LINKS_CHANGE, { userId: "u" });
    expect(mocks.transitionAction).toHaveBeenCalledTimes(1);
    expect(mocks.transitionAction).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "APPLY",
        actionId: "act-1",
        appliedVia: "CMS",
        approvalId: "apr-1",
      }),
    );
    expect(await remainingLinksOf("proj_1", "act-1")).toEqual([]);
  });

  it("counts only VERIFIED changes of this action (query shape)", async () => {
    mocks.getAction.mockResolvedValue(linksAction());
    await onChangeVerified(LINKS_CHANGE, { userId: "u" });
    expect(mocks.changeFindMany).toHaveBeenCalledWith({
      where: {
        projectId: "proj_1",
        seoActionId: "act-1",
        kind: "INTERNAL_LINKS",
        status: "VERIFIED",
      },
      select: { params: true },
    });
  });

  it("matches coverage on page and target, not on the anchor text", async () => {
    mocks.getAction.mockResolvedValue(
      linksAction({
        proposal: {
          v: 1,
          kind: "INTERNAL_LINKS",
          links: [LINKS[0]],
          note: null,
          alert: null,
        },
      }),
    );
    mocks.changeFindMany.mockResolvedValue([
      {
        params: {
          kind: "INTERNAL_LINKS",
          url: "https://example.com/a",
          links: [{ toUrl: "https://example.com/x", anchor: "edited anchor" }],
        },
      },
    ]);
    await onChangeVerified(LINKS_CHANGE, { userId: "u" });
    expect(mocks.transitionAction).toHaveBeenCalledTimes(1);
  });

  it("remainingLinksOf is empty for a TITLE_META action", async () => {
    mocks.getAction.mockResolvedValue(action());
    expect(await remainingLinksOf("proj_1", "act-1")).toEqual([]);
    expect(mocks.changeFindMany).not.toHaveBeenCalled();
  });
});

describe("onChangeVerified: PUBLISH_LIVE closes the article loop", () => {
  const articleAction = (overrides: Record<string, unknown> = {}) => ({
    id: "act-7",
    projectId: "proj_1",
    status: "ACCEPTED",
    kind: "NEW_CONTENT",
    proposal: {
      v: 1,
      kind: "NEW_CONTENT",
      title: "T",
      primaryKeyword: null,
      language: null,
      liveUrl: null,
      note: null,
      alert: null,
    },
    ...overrides,
  });

  beforeEach(() => {
    mocks.actionFindFirst.mockResolvedValue({ id: "act-7" });
    mocks.creativeFindFirst.mockResolvedValue({
      status: "APPROVED",
      createdByTaskId: "task-9",
    });
  });

  it("finds the NEW_CONTENT action by creativeId, sets liveUrl, applies via CMS and publishes the Creative", async () => {
    mocks.getAction.mockResolvedValue(articleAction());
    await onChangeVerified(LIVE_CHANGE, { userId: "owner-1" });

    expect(mocks.actionFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ creativeId: "cr-1" }),
      }),
    );
    expect(mocks.updateProposal).toHaveBeenCalledWith({
      projectId: "proj_1",
      actionId: "act-7",
      proposal: expect.objectContaining({
        kind: "NEW_CONTENT",
        liveUrl: "https://example.com/blog/post",
      }),
      targetUrl: "https://example.com/blog/post",
    });
    expect(mocks.transitionAction).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: "act-7",
        event: "APPLY",
        appliedVia: "CMS",
        approvalId: "apr-2",
      }),
    );
    expect(mocks.creativeTransition).toHaveBeenCalledWith(
      "cr-1",
      "proj_1",
      "PUBLISHED",
    );
    expect(mocks.markPublishState).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-9",
        creativeId: "cr-1",
        publishState: "published",
      }),
    );
    expect(mocks.auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "creative.marked_published",
        entityId: "cr-1",
      }),
    );
  });

  it("is idempotent next to a manual Mark as published", async () => {
    // Elle işaretleme önce geldi: eylem APPLIED, Creative PUBLISHED.
    mocks.getAction.mockResolvedValue(articleAction({ status: "APPLIED" }));
    mocks.creativeFindFirst.mockResolvedValue({
      status: "PUBLISHED",
      createdByTaskId: "task-9",
    });
    await onChangeVerified(LIVE_CHANGE, { userId: "owner-1" });
    expect(mocks.updateProposal).not.toHaveBeenCalled();
    expect(mocks.transitionAction).not.toHaveBeenCalled();
    expect(mocks.creativeTransition).not.toHaveBeenCalled();
    expect(mocks.auditRecord).not.toHaveBeenCalled();
  });

  it("still publishes the Creative when there is no SEO action for it", async () => {
    mocks.actionFindFirst.mockResolvedValue(null);
    await onChangeVerified(LIVE_CHANGE, { userId: "owner-1" });
    expect(mocks.transitionAction).not.toHaveBeenCalled();
    expect(mocks.creativeTransition).toHaveBeenCalledTimes(1);
  });

  it("does not close the loop for a noop change (the post was already public)", async () => {
    await onChangeVerified({ ...LIVE_CHANGE, noop: true }, { userId: "u" });
    allMocksUntouched();
  });

  it("falls back to the creative id in the params", async () => {
    mocks.getAction.mockResolvedValue(articleAction());
    await onChangeVerified({ ...LIVE_CHANGE, creativeId: null }, { userId: "u" });
    expect(mocks.creativeTransition).toHaveBeenCalledWith(
      "cr-1",
      "proj_1",
      "PUBLISHED",
    );
  });

  it("swallows invalid_transition", async () => {
    mocks.getAction.mockResolvedValue(articleAction());
    mocks.transitionAction.mockResolvedValue({
      ok: false,
      reason: "invalid_transition",
    });
    await expect(
      onChangeVerified(LIVE_CHANGE, { userId: "u" }),
    ).resolves.toBeUndefined();
  });
});

describe("onChangeVerified: PUBLISH_ARTICLE", () => {
  it("does nothing: a draft closes no loop", async () => {
    await onChangeVerified(
      changeFixture({
        kind: "PUBLISH_ARTICLE",
        status: "VERIFIED",
        params: {
          kind: "PUBLISH_ARTICLE",
          creativeId: "cr-1",
          versionId: "v-1",
          title: "T",
          metaDescription: "",
          markdown: "x",
          language: null,
        },
      }),
      { userId: "u" },
    );
    expect(mocks.transitionAction).not.toHaveBeenCalled();
    expect(mocks.creativeTransition).not.toHaveBeenCalled();
  });
});

describe("onChangeUndone", () => {
  it("reverts an action that is still APPLIED", async () => {
    mocks.getAction.mockResolvedValue(action({ status: "APPLIED" }));
    await onChangeUndone(TITLE_CHANGE, { userId: "owner-1" });
    expect(mocks.transitionAction).toHaveBeenCalledWith({
      projectId: "proj_1",
      actionId: "act-1",
      event: "UNDO_APPLY",
      userId: "owner-1",
    });
  });

  it("leaves an action whose measurement already started", async () => {
    mocks.getAction.mockResolvedValue(action({ status: "EVALUATING" }));
    await onChangeUndone(TITLE_CHANGE, { userId: "owner-1" });
    expect(mocks.transitionAction).not.toHaveBeenCalled();
  });

  it("finds the article action by creativeId when a PUBLISH_LIVE is undone", async () => {
    mocks.actionFindFirst.mockResolvedValue({ id: "act-7" });
    mocks.getAction.mockResolvedValue(
      action({ id: "act-7", status: "APPLIED", kind: "NEW_CONTENT" }),
    );
    await onChangeUndone(LIVE_CHANGE, { userId: "owner-1" });
    expect(mocks.transitionAction).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: "act-7", event: "UNDO_APPLY" }),
    );
  });

  it("does nothing for a change without an action", async () => {
    await onChangeUndone({ ...TITLE_CHANGE, seoActionId: null }, { userId: "u" });
    expect(mocks.getAction).not.toHaveBeenCalled();
  });
});
