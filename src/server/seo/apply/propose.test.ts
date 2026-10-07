import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SEO_APPLY_REFUSAL_MESSAGES } from "@/lib/seo/apply/copy";
import { SEO_APPLY_APPROVAL_TTL_MS } from "@/lib/seo/apply/lifecycle";
import { changeFixture, siteFixture } from "@/lib/seo/apply/test-support";
import type { WpObject } from "@/lib/seo/apply/wp/wp-types";

import type { ProposeSeoChangeInput } from "./types";

// Bu dosyanın kanıtladığı: öneri kapıdan (gateApplySite) geçer ve her ret kodu
// sabit metinle döner; her tür için mutlu yol ve her ret (page_not_found,
// page_ambiguous, builder_page, anchor_not_found, seo_plugin_unsupported,
// already_done, already_open) doğru koddan çıkar; aynı konu ikinci Task açmaz
// (mevcut açık değişiklik döner, reddedilmiş olan kapanıp taze doğar);
// PUBLISH_LIVE expectModified, draftEditedSince ve creativeId'yi taslak
// değişikliğinden taşır; SeoChange.expiresAt ile Approval.expiresAt aynı değerdir;
// onay satırlarında gizli bilgi yoktur; propose WordPress'e ASLA yazmaz.
// Saf P1/P2 modülleri (planChange, matchWpObject, doğrulayıcılar) gerçektir.

const NOW = new Date("2026-10-07T09:00:00.000Z");
const ORIGIN = "https://example.com";

const mocks = vi.hoisted(() => ({
  changeFindFirst: vi.fn(),
  changeCreate: vi.fn(),
  changeUpdate: vi.fn(),
  changeUpdateMany: vi.fn(),
  brandFindFirst: vi.fn(),
  gate: vi.fn(),
  loadArticle: vi.fn(),
  clientFor: vi.fn(),
  ensureAccepted: vi.fn(),
  syncState: vi.fn(),
  audit: vi.fn(),
  taskApproval: vi.fn(),
  findObjects: vi.fn(),
  getObject: vi.fn(),
  createPost: vi.fn(),
  updateObject: vi.fn(),
  trashObject: vi.fn(),
  rankMathUpdateMeta: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    seoChange: {
      findFirst: mocks.changeFindFirst,
      create: mocks.changeCreate,
      update: mocks.changeUpdate,
      updateMany: mocks.changeUpdateMany,
    },
    brand: { findFirst: mocks.brandFindFirst },
  },
}));
vi.mock("./site", () => ({ gateApplySite: mocks.gate }));
vi.mock("./articles", () => ({ loadArticleForPublish: mocks.loadArticle }));
vi.mock("./deps", () => ({
  resolveApplyDeps: (deps: { now?: Date; mock?: boolean } = {}) => ({
    now: deps.now ?? new Date(),
    mock: deps.mock ?? false,
    clientFor: mocks.clientFor,
  }),
}));
vi.mock("./action-link", () => ({ ensureActionAccepted: mocks.ensureAccepted }));
vi.mock("./approval-hook", () => ({
  syncSeoChangeApprovalState: mocks.syncState,
}));
vi.mock("./audit", () => ({ recordSeoApplyAudit: mocks.audit }));
vi.mock("./task-approval", () => ({
  createSeoApplyTaskApproval: mocks.taskApproval,
}));

const { proposeSeoChange } = await import("./propose");

const SCOPE = {
  kind: "VERIFIED_DOMAIN" as const,
  root: "example.com",
  prefix: null,
  key: "VERIFIED_DOMAIN:example.com:",
};
const FIELDS_META = {
  plugin: "YOAST" as const,
  titleVia: "META" as const,
  descriptionVia: "META" as const,
  verifiable: true,
};
const CAPS = {
  draftPosts: true,
  publishPosts: true,
  editPublishedPosts: true,
  editPages: true,
  editPublishedPages: true,
  editOthers: true,
  deletePosts: true,
};

function gateOk(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    site: siteFixture(),
    scope: SCOPE,
    fields: FIELDS_META,
    capabilities: CAPS,
    ...overrides,
  };
}

function wpObject(overrides: Partial<WpObject> = {}): WpObject {
  return {
    id: 101,
    type: "page",
    status: "publish",
    link: "https://example.com/pricing/",
    slug: "pricing",
    modified: "2026-10-01T08:00:00.000Z",
    title: "Pricing",
    excerpt: "",
    content:
      "<!-- wp:paragraph -->\n<p>We explain our pricing plans for small teams here.</p>\n<!-- /wp:paragraph -->",
    meta: {
      _yoast_wpseo_title: "Old SEO title",
      _yoast_wpseo_metadesc: "Old description",
    },
    ...overrides,
  };
}

function words(count: number): string {
  return Array.from({ length: count }, (_, index) => `word${index}`).join(" ");
}

const ARTICLE = {
  creativeId: "cr-1",
  versionId: "v-1",
  title: "How to price a plan",
  metaDescription: "A short description.",
  markdown: `Intro.\n\n${words(200)}`,
  language: "en",
  words: 201,
};

const DRAFT_ROW = changeFixture({
  id: "draft-1",
  kind: "PUBLISH_ARTICLE",
  status: "VERIFIED",
  siteId: "site_1",
  noop: false,
  wpId: 55,
  wpType: "post",
  creativeId: "cr-1",
  params: {
    kind: "PUBLISH_ARTICLE",
    creativeId: "cr-1",
    versionId: "v-1",
    title: "How to price a plan",
    metaDescription: "A short description.",
    markdown: "x",
    language: "en",
  },
  after: {
    exists: true,
    type: "post",
    id: 55,
    status: "draft",
    link: "https://example.com/?p=55",
    modified: "2026-10-01T09:00:00.000Z",
    title: "How to price a plan",
    excerpt: "",
    seoTitle: null,
    seoDescription: null,
    contentHash: null,
    contentWords: 200,
    contentRaw: null,
  },
});

type Where = {
  openKey?: string;
  status?: string;
  dedupeKey?: string;
  id?: string;
};
let state: {
  open: ReturnType<typeof changeFixture> | null;
  done: ReturnType<typeof changeFixture> | null;
  draft: ReturnType<typeof changeFixture> | null;
};

function base(overrides: Record<string, unknown> = {}): ProposeSeoChangeInput {
  return {
    projectId: "proj_1",
    userId: "user_1",
    ...overrides,
  } as ProposeSeoChangeInput;
}

function writeCalls(): number {
  return (
    mocks.createPost.mock.calls.length +
    mocks.updateObject.mock.calls.length +
    mocks.trashObject.mock.calls.length +
    mocks.rankMathUpdateMeta.mock.calls.length
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  state = { open: null, done: null, draft: null };
  mocks.gate.mockResolvedValue(gateOk());
  mocks.clientFor.mockResolvedValue({
    findObjects: mocks.findObjects,
    getObject: mocks.getObject,
    createPost: mocks.createPost,
    updateObject: mocks.updateObject,
    trashObject: mocks.trashObject,
    rankMathUpdateMeta: mocks.rankMathUpdateMeta,
  });
  mocks.changeFindFirst.mockImplementation(({ where }: { where: Where }) => {
    if (where.openKey) return Promise.resolve(state.open);
    if (where.status === "VERIFIED") return Promise.resolve(state.done);
    if (where.id) return Promise.resolve(state.draft);
    return Promise.resolve(null);
  });
  mocks.changeCreate.mockImplementation(({ data }: { data: object }) =>
    Promise.resolve({ id: "chg-1", taskId: null, approvalId: null, ...data }),
  );
  mocks.changeUpdate.mockImplementation(
    ({ data }: { data: object }) =>
      Promise.resolve({ ...changeFixture({ id: "chg-1" }), ...data }),
  );
  mocks.changeUpdateMany.mockResolvedValue({ count: 1 });
  mocks.brandFindFirst.mockResolvedValue({ id: "brand-1" });
  mocks.taskApproval.mockResolvedValue({ taskId: "task-1", approvalId: "appr-1" });
  mocks.ensureAccepted.mockResolvedValue(true);
  mocks.syncState.mockResolvedValue("PROPOSED");
  mocks.loadArticle.mockResolvedValue({ ok: true, article: { ...ARTICLE } });
  mocks.findObjects.mockResolvedValue([wpObject()]);
  mocks.getObject.mockResolvedValue(null);
});

afterEach(() => {
  // Hiçbir testte WordPress'e yazma çağrısı yapılmaz.
  expect(writeCalls()).toBe(0);
});

describe("gating", () => {
  it.each([
    "not_enabled",
    "not_connected",
    "site_unhealthy",
    "domain_mismatch",
    "no_permission",
    "not_allowed_here",
  ] as const)("returns the gate refusal %s with its fixed message", async (refusal) => {
    mocks.gate.mockResolvedValue({ ok: false, code: "not_enabled", refusal });
    const result = await proposeSeoChange(
      base({ kind: "TITLE_META", url: `${ORIGIN}/pricing`, title: "New title" }),
      { now: NOW, mock: false },
    );
    expect(result).toEqual({
      ok: false,
      code: refusal,
      message: SEO_APPLY_REFUSAL_MESSAGES[refusal],
    });
    expect(mocks.clientFor).not.toHaveBeenCalled();
    expect(mocks.changeCreate).not.toHaveBeenCalled();
  });

  it("asks the gate for the kind and, for PUBLISH_LIVE, the post type", async () => {
    mocks.gate.mockResolvedValue({ ok: false, code: "not_enabled", refusal: "not_enabled" });
    await proposeSeoChange(
      base({ kind: "PUBLISH_LIVE", draftChangeId: "draft-1" }),
      { now: NOW, mock: false },
    );
    expect(mocks.gate).toHaveBeenCalledWith("proj_1", "PUBLISH_LIVE", {
      mock: false,
      wpType: "post",
      anyWpType: false,
    });
  });

  it("does not demand both post and page rights before the type is known", async () => {
    mocks.gate.mockResolvedValue({ ok: false, code: "not_enabled", refusal: "not_enabled" });
    await proposeSeoChange(
      base({ kind: "TITLE_META", url: `${ORIGIN}/pricing`, title: "New title" }),
      { now: NOW, mock: false },
    );
    expect(mocks.gate).toHaveBeenCalledWith("proj_1", "TITLE_META", {
      mock: false,
      wpType: null,
      anyWpType: true,
    });
  });

  it("refuses with not_connected when the credential cannot be opened", async () => {
    mocks.clientFor.mockResolvedValue(null);
    const result = await proposeSeoChange(
      base({ kind: "TITLE_META", url: `${ORIGIN}/pricing`, title: "New title" }),
      { now: NOW },
    );
    expect(result).toMatchObject({ ok: false, code: "not_connected" });
  });

  it("refuses when the page capability does not allow the page type", async () => {
    mocks.gate.mockResolvedValue(
      gateOk({ capabilities: { ...CAPS, editPublishedPages: false } }),
    );
    const result = await proposeSeoChange(
      base({ kind: "TITLE_META", url: `${ORIGIN}/pricing`, title: "New title" }),
      { now: NOW },
    );
    expect(result).toMatchObject({ ok: false, code: "no_permission" });
  });

  it("refuses with not_allowed_here when the project has no default brand", async () => {
    mocks.brandFindFirst.mockResolvedValue(null);
    const result = await proposeSeoChange(
      base({ kind: "TITLE_META", url: `${ORIGIN}/pricing`, title: "New title" }),
      { now: NOW },
    );
    expect(result).toMatchObject({ ok: false, code: "not_allowed_here" });
    expect(mocks.changeCreate).not.toHaveBeenCalled();
  });
});

describe("PUBLISH_ARTICLE", () => {
  it("creates a PROPOSED change, a Task and an Approval with ONE shared expiry", async () => {
    const result = await proposeSeoChange(
      base({ kind: "PUBLISH_ARTICLE", creativeId: "cr-1" }),
      { now: NOW },
    );
    expect(result).toMatchObject({
      ok: true,
      changeId: "chg-1",
      status: "PROPOSED",
      created: true,
      approvalId: "appr-1",
    });

    const expiresAt = new Date(NOW.getTime() + SEO_APPLY_APPROVAL_TTL_MS);
    const data = mocks.changeCreate.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      workspaceId: "ws_1",
      projectId: "proj_1",
      siteId: "site_1",
      kind: "PUBLISH_ARTICLE",
      status: "PROPOSED",
      source: "ARTICLE",
      title: "Create a WordPress draft",
      creativeId: "cr-1",
      dedupeKey: "publish:cr-1:v-1",
      openKey: "publish:cr-1:v-1",
      proposedByType: "USER",
      proposedByUserId: "user_1",
      wpType: null,
      wpId: null,
    });
    expect(data.expiresAt).toEqual(expiresAt);
    expect(data.params).toMatchObject({
      kind: "PUBLISH_ARTICLE",
      creativeId: "cr-1",
      versionId: "v-1",
      title: "How to price a plan",
    });

    const task = mocks.taskApproval.mock.calls[0]![0];
    expect(task).toMatchObject({
      workspaceId: "ws_1",
      projectId: "proj_1",
      brandId: "brand-1",
      userId: "user_1",
      changeId: "chg-1",
      kind: "PUBLISH_ARTICLE",
      now: NOW,
    });
    // Aynı değer: tek hesaplanan expiresAt iki satıra da gider.
    expect(task.expiresAt).toEqual(data.expiresAt);
    expect(task.expiresAt.getTime()).toBe(expiresAt.getTime());

    expect(mocks.changeUpdate).toHaveBeenCalledWith({
      where: { id: "chg-1" },
      data: { taskId: "task-1", approvalId: "appr-1" },
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      "seo_change.proposed",
      { changeId: "chg-1", kind: "PUBLISH_ARTICLE", source: "ARTICLE" },
      { workspaceId: "ws_1", projectId: "proj_1", userId: "user_1" },
    );
  });

  it("shows what happens and where in the approver rows, with no secret", async () => {
    const result = await proposeSeoChange(
      base({ kind: "PUBLISH_ARTICLE", creativeId: "cr-1" }),
      { now: NOW },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rows = Object.fromEntries(result.preview.map((r) => [r.label, r.value]));
    expect(rows["What happens"]).toMatch(/draft/i);
    expect(rows.Where).toBe("example.com");
    expect(rows.Length).toBe("201 words");
    expect(rows.Undo).toBe("Undo moves the draft to the WordPress Trash.");
    const text = JSON.stringify(result.preview) + JSON.stringify(mocks.taskApproval.mock.calls);
    expect(text).not.toMatch(/password|secret|authorization|basic /i);
  });

  it.each([
    ["not_found", "article_missing"],
    ["not_article", "article_missing"],
    ["not_reviewed", "article_missing"],
    ["no_version", "article_missing"],
  ])("maps article reason %s to %s", async (reason, code) => {
    mocks.loadArticle.mockResolvedValue({ ok: false, reason });
    expect(
      await proposeSeoChange(base({ kind: "PUBLISH_ARTICLE", creativeId: "cr-1" }), {
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code });
    expect(mocks.changeCreate).not.toHaveBeenCalled();
  });

  it("a short article is invalid and carries the validator message", async () => {
    mocks.loadArticle.mockResolvedValue({
      ok: false,
      reason: "too_short",
      message: "The article needs at least 150 words.",
    });
    expect(
      await proposeSeoChange(base({ kind: "PUBLISH_ARTICLE", creativeId: "cr-1" }), {
        now: NOW,
      }),
    ).toEqual({
      ok: false,
      code: "invalid",
      message: "The article needs at least 150 words.",
    });
  });

  it("is already_done when this version already sits on the site", async () => {
    state.done = changeFixture({ id: "done-1", status: "VERIFIED" });
    expect(
      await proposeSeoChange(base({ kind: "PUBLISH_ARTICLE", creativeId: "cr-1" }), {
        now: NOW,
      }),
    ).toEqual({
      ok: false,
      code: "already_done",
      message: SEO_APPLY_REFUSAL_MESSAGES.already_done,
      existingChangeId: "done-1",
    });
  });
});

describe("PUBLISH_LIVE", () => {
  const live = (overrides: Partial<WpObject> = {}) =>
    wpObject({
      id: 55,
      type: "post",
      status: "draft",
      link: "https://example.com/?p=55",
      slug: "how-to-price-a-plan",
      modified: "2026-10-01T10:00:00.000Z",
      title: "How to price a plan",
      ...overrides,
    });

  beforeEach(() => {
    state.draft = { ...DRAFT_ROW };
    mocks.getObject.mockResolvedValue(live());
  });

  it("carries expectModified, draftEditedSince and the creativeId from the draft change", async () => {
    const result = await proposeSeoChange(
      base({ kind: "PUBLISH_LIVE", draftChangeId: "draft-1" }),
      { now: NOW },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(mocks.getObject).toHaveBeenCalledWith("post", 55);
    const data = mocks.changeCreate.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      kind: "PUBLISH_LIVE",
      source: "DRAFT",
      title: "Publish a WordPress draft",
      creativeId: "cr-1",
      wpType: "post",
      wpId: 55,
      dedupeKey: "live:draft-1",
    });
    expect(data.params).toMatchObject({
      kind: "PUBLISH_LIVE",
      draftChangeId: "draft-1",
      wpType: "post",
      wpId: 55,
      // Canlı taslağın o anki değişiklik zamanı.
      expectModified: "2026-10-01T10:00:00.000Z",
      creativeId: "cr-1",
    });
    // Taslak, Agentelse oluşturduktan sonra (09:00) düzenlenmiş (10:00).
    const rows = Object.fromEntries(result.preview.map((r) => [r.label, r.value]));
    expect(rows.Warning).toBe(
      "The draft was edited in WordPress after Agentelse created it.",
    );
    expect(rows["What happens"]).toMatch(/visible to everyone/i);
  });

  it("shows no edited warning when the draft is untouched", async () => {
    mocks.getObject.mockResolvedValue(live({ modified: "2026-10-01T09:00:00.000Z" }));
    const result = await proposeSeoChange(
      base({ kind: "PUBLISH_LIVE", draftChangeId: "draft-1" }),
      { now: NOW },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.map((r) => r.label)).not.toContain("Warning");
  });

  it.each([
    ["no row", null],
    ["not verified", { ...DRAFT_ROW, status: "FAILED" }],
    ["a noop change", { ...DRAFT_ROW, noop: true }],
    ["no wordpress id", { ...DRAFT_ROW, wpId: null }],
    ["another site", { ...DRAFT_ROW, siteId: "site_other" }],
    ["a different kind", { ...DRAFT_ROW, kind: "TITLE_META" }],
  ])("refuses with draft_missing for %s", async (_name, row) => {
    state.draft = row as typeof state.draft;
    expect(
      await proposeSeoChange(base({ kind: "PUBLISH_LIVE", draftChangeId: "draft-1" }), {
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "draft_missing" });
    expect(mocks.changeCreate).not.toHaveBeenCalled();
  });

  it("refuses with draft_missing when WordPress no longer has the draft", async () => {
    mocks.getObject.mockResolvedValue(null);
    expect(
      await proposeSeoChange(base({ kind: "PUBLISH_LIVE", draftChangeId: "draft-1" }), {
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "draft_missing" });
  });

  it("is already_done when the post is public already", async () => {
    mocks.getObject.mockResolvedValue(live({ status: "publish" }));
    expect(
      await proposeSeoChange(base({ kind: "PUBLISH_LIVE", draftChangeId: "draft-1" }), {
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "already_done", existingChangeId: "draft-1" });
  });

  it("refuses without the publish capability", async () => {
    mocks.gate.mockResolvedValue(
      gateOk({ capabilities: { ...CAPS, publishPosts: false } }),
    );
    expect(
      await proposeSeoChange(base({ kind: "PUBLISH_LIVE", draftChangeId: "draft-1" }), {
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "no_permission" });
  });
});

describe("TITLE_META", () => {
  const input = (overrides: Record<string, unknown> = {}) =>
    base({
      kind: "TITLE_META",
      url: `${ORIGIN}/pricing`,
      title: "Pricing for small teams",
      metaDescription: "Simple plans for small teams.",
      ...overrides,
    });

  it("creates the change for the matched page and shows before and after", async () => {
    const result = await proposeSeoChange(input(), { now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(mocks.findObjects).toHaveBeenCalledWith("https://example.com/pricing");
    const data = mocks.changeCreate.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      kind: "TITLE_META",
      source: "ACTION",
      title: "Change a page title and description on WordPress",
      targetUrl: "https://example.com/pricing",
      wpType: "page",
      wpId: 101,
      creativeId: null,
      dedupeKey: "meta:page:101",
    });
    expect(data.params).toMatchObject({
      kind: "TITLE_META",
      wpType: "page",
      wpId: 101,
      expectModified: "2026-10-01T08:00:00.000Z",
      title: "Pricing for small teams",
      metaDescription: "Simple plans for small teams.",
    });
    const rows = Object.fromEntries(result.preview.map((r) => [r.label, r.value]));
    expect(rows.Page).toBe("/pricing");
    expect(rows["Title before"]).toBe("Old SEO title");
    expect(rows["Title after"]).toBe("Pricing for small teams");
    expect(rows["Description before"]).toBe("Old description");
    expect(rows["Description after"]).toBe("Simple plans for small teams.");
  });

  it("notes the page heading when the title falls back to the post title", async () => {
    mocks.gate.mockResolvedValue(
      gateOk({
        fields: { plugin: "NONE", titleVia: "POST_TITLE", descriptionVia: "NONE", verifiable: false },
      }),
    );
    const result = await proposeSeoChange(
      input({ metaDescription: null }),
      { now: NOW },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rows = Object.fromEntries(result.preview.map((r) => [r.label, r.value]));
    expect(rows.Note).toBe("This also changes the page heading on most themes.");
    expect(rows.Before).toBe("Pricing");
  });

  it("is invalid without any text", async () => {
    expect(
      await proposeSeoChange(input({ title: "", metaDescription: "" }), { now: NOW }),
    ).toMatchObject({ ok: false, code: "invalid" });
    expect(mocks.findObjects).not.toHaveBeenCalled();
  });

  it("refuses an address outside the verified site", async () => {
    expect(
      await proposeSeoChange(input({ url: "https://other-site.org/pricing" }), {
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "domain_mismatch" });
    expect(mocks.findObjects).not.toHaveBeenCalled();
    expect(
      await proposeSeoChange(input({ url: "not a url" }), { now: NOW }),
    ).toMatchObject({ ok: false, code: "invalid" });
  });

  it("page_not_found when WordPress has no such page", async () => {
    mocks.findObjects.mockResolvedValue([]);
    expect(await proposeSeoChange(input(), { now: NOW })).toMatchObject({
      ok: false,
      code: "page_not_found",
    });
  });

  it("page_ambiguous when two objects share the address", async () => {
    mocks.findObjects.mockResolvedValue([
      wpObject(),
      wpObject({ id: 202, type: "post" }),
    ]);
    expect(await proposeSeoChange(input(), { now: NOW })).toMatchObject({
      ok: false,
      code: "page_ambiguous",
    });
  });

  it("seo_plugin_unsupported when only the description can change but the plugin hides it", async () => {
    mocks.gate.mockResolvedValue(
      gateOk({
        fields: { plugin: "YOAST", titleVia: "POST_TITLE", descriptionVia: "NONE", verifiable: false },
      }),
    );
    expect(
      await proposeSeoChange(input({ title: null }), { now: NOW }),
    ).toMatchObject({ ok: false, code: "seo_plugin_unsupported" });
  });

  it("already_done when the page already has the text", async () => {
    mocks.findObjects.mockResolvedValue([
      wpObject({
        meta: {
          _yoast_wpseo_title: "Pricing for small teams",
          _yoast_wpseo_metadesc: "Simple plans for small teams.",
        },
      }),
    ]);
    expect(await proposeSeoChange(input(), { now: NOW })).toMatchObject({
      ok: false,
      code: "already_done",
    });
    expect(mocks.changeCreate).not.toHaveBeenCalled();
  });

  it("surfaces a WordPress read failure as site_unavailable", async () => {
    mocks.findObjects.mockRejectedValue(new Error("timeout"));
    expect(await proposeSeoChange(input(), { now: NOW })).toMatchObject({
      ok: false,
      code: "site_unavailable",
    });
  });
});

describe("INTERNAL_LINKS", () => {
  const input = (overrides: Record<string, unknown> = {}) =>
    base({
      kind: "INTERNAL_LINKS",
      url: `${ORIGIN}/pricing`,
      links: [{ toUrl: `${ORIGIN}/plans`, anchor: "pricing plans" }],
      ...overrides,
    });

  it("creates the change and lists each link as a row", async () => {
    const result = await proposeSeoChange(input(), { now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = mocks.changeCreate.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      kind: "INTERNAL_LINKS",
      title: "Add internal links on WordPress",
      dedupeKey: "links:page:101",
    });
    expect(data.params.links).toEqual([
      { toUrl: "https://example.com/plans", anchor: "pricing plans" },
    ]);
    expect(result.preview).toContainEqual({
      label: "Link 1",
      value: '"pricing plans" to /plans',
    });
  });

  it("builder_page for a page built with a page builder", async () => {
    mocks.findObjects.mockResolvedValue([
      wpObject({ content: '<div data-elementor-type="wp-page"><p>pricing plans</p></div>' }),
    ]);
    expect(await proposeSeoChange(input(), { now: NOW })).toMatchObject({
      ok: false,
      code: "builder_page",
    });
  });

  it("builder_page when the content cannot be read", async () => {
    mocks.findObjects.mockResolvedValue([wpObject({ content: null })]);
    expect(await proposeSeoChange(input(), { now: NOW })).toMatchObject({
      ok: false,
      code: "builder_page",
    });
  });

  it("anchor_not_found when the words are not in the text", async () => {
    expect(
      await proposeSeoChange(
        input({ links: [{ toUrl: `${ORIGIN}/plans`, anchor: "enterprise rollout" }] }),
        { now: NOW },
      ),
    ).toMatchObject({ ok: false, code: "anchor_not_found" });
  });

  it("already_done when the link is already in the text", async () => {
    mocks.findObjects.mockResolvedValue([
      wpObject({
        content:
          '<!-- wp:paragraph -->\n<p>We explain our <a href="https://example.com/plans">pricing plans</a> here.</p>\n<!-- /wp:paragraph -->',
      }),
    ]);
    expect(await proposeSeoChange(input(), { now: NOW })).toMatchObject({
      ok: false,
      code: "already_done",
    });
  });

  it("is invalid for more than three links or a target outside the site", async () => {
    const many = Array.from({ length: 4 }, (_, index) => ({
      toUrl: `${ORIGIN}/p${index}`,
      anchor: `anchor ${index}`,
    }));
    expect(await proposeSeoChange(input({ links: many }), { now: NOW })).toMatchObject({
      ok: false,
      code: "invalid",
    });
    expect(
      await proposeSeoChange(
        input({ links: [{ toUrl: "https://elsewhere.org/x", anchor: "pricing plans" }] }),
        { now: NOW },
      ),
    ).toMatchObject({ ok: false, code: "invalid" });
    expect(mocks.findObjects).not.toHaveBeenCalled();
  });
});

describe("one open change per subject", () => {
  const input = () =>
    base({
      kind: "TITLE_META",
      url: `${ORIGIN}/pricing`,
      title: "Pricing for small teams",
    });

  it("returns the existing PROPOSED change and opens no second Task", async () => {
    state.open = changeFixture({ id: "open-1", approvalId: "apr-open" });
    const result = await proposeSeoChange(input(), { now: NOW });
    expect(result).toMatchObject({
      ok: true,
      changeId: "open-1",
      status: "PROPOSED",
      created: false,
      approvalId: "apr-open",
    });
    expect(mocks.syncState).toHaveBeenCalledWith("open-1", { now: NOW });
    expect(mocks.changeCreate).not.toHaveBeenCalled();
    expect(mocks.taskApproval).not.toHaveBeenCalled();
  });

  it("returns an APPROVED change as is", async () => {
    state.open = changeFixture({ id: "open-1", status: "APPROVED" });
    expect(await proposeSeoChange(input(), { now: NOW })).toMatchObject({
      ok: true,
      changeId: "open-1",
      status: "APPROVED",
      created: false,
    });
    expect(mocks.syncState).not.toHaveBeenCalled();
  });

  it.each(["APPLYING", "APPLIED"])("answers already_open while %s", async (status) => {
    state.open = changeFixture({ id: "open-1", status });
    expect(await proposeSeoChange(input(), { now: NOW })).toEqual({
      ok: false,
      code: "already_open",
      message: SEO_APPLY_REFUSAL_MESSAGES.already_open,
      existingChangeId: "open-1",
    });
  });

  it("an open row whose approval was rejected in chat closes and a fresh change is created", async () => {
    state.open = changeFixture({ id: "open-1" });
    mocks.syncState.mockResolvedValue("REJECTED");
    const result = await proposeSeoChange(input(), { now: NOW });
    expect(result).toMatchObject({ ok: true, changeId: "chg-1", created: true });
    expect(mocks.changeCreate).toHaveBeenCalledTimes(1);
  });

  it("adopts the winner of a concurrent proposal (unique violation)", async () => {
    mocks.changeCreate.mockRejectedValue(Object.assign(new Error("dup"), { code: "P2002" }));
    // İlk bakışta yok, çakışmadan sonra var.
    mocks.changeFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(changeFixture({ id: "winner-1" }));
    expect(await proposeSeoChange(input(), { now: NOW })).toMatchObject({
      ok: true,
      changeId: "winner-1",
      created: false,
    });
    expect(mocks.taskApproval).not.toHaveBeenCalled();
  });
});

describe("Task and Approval failures, SC-F6 link", () => {
  const input = (overrides: Record<string, unknown> = {}) =>
    base({
      kind: "TITLE_META",
      url: `${ORIGIN}/pricing`,
      title: "Pricing for small teams",
      ...overrides,
    });

  it("expires the row and refuses when the approval cannot be requested", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.taskApproval.mockRejectedValue(new Error("db down"));
    expect(await proposeSeoChange(input(), { now: NOW })).toMatchObject({
      ok: false,
      code: "not_allowed_here",
    });
    expect(mocks.changeUpdateMany).toHaveBeenCalledWith({
      where: { id: "chg-1", status: "PROPOSED" },
      data: { status: "EXPIRED", openKey: null },
    });
    expect(mocks.audit).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("accepts the SC-F6 action and stores its id on the change", async () => {
    const result = await proposeSeoChange(input({ actionId: "act-1" }), { now: NOW });
    expect(result.ok).toBe(true);
    expect(mocks.ensureAccepted).toHaveBeenCalledWith("proj_1", "act-1", "user_1");
    expect(mocks.changeUpdate).toHaveBeenCalledWith({
      where: { id: "chg-1" },
      data: { seoActionId: "act-1" },
    });
  });

  it("does not store the action id when it cannot be accepted", async () => {
    mocks.ensureAccepted.mockResolvedValue(false);
    await proposeSeoChange(input({ actionId: "act-1" }), { now: NOW });
    expect(mocks.changeUpdate).not.toHaveBeenCalledWith({
      where: { id: "chg-1" },
      data: { seoActionId: "act-1" },
    });
  });

  it("makes no SC-F6 call without an action id", async () => {
    await proposeSeoChange(input(), { now: NOW });
    expect(mocks.ensureAccepted).not.toHaveBeenCalled();
  });
});
