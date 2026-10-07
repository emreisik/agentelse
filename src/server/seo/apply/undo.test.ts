import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { SEO_CHANGE_ERROR_MESSAGES } from "@/lib/seo/apply/copy";
import {
  mockWpCalls,
  mockWpEdit,
  seedMockWordPress,
  setMockWpFault,
  setMockWpReadBackLie,
} from "@/server/integrations/wordpress/mock-site";

import { onChangeUndone } from "./action-link";
import { applySeoChange } from "./apply";
import {
  ENV_KEYS,
  NOW,
  ORIGIN,
  addChange,
  articleParams,
  change,
  dedupeOf,
  fake,
  fakeGate,
  fakePrisma,
  freshWordPress,
  gateConfig,
  linksParams,
  liveParams,
  makeClient,
  resetFake,
  resetGate,
  titleMetaParams,
} from "./apply.testkit";
import { recordSeoApplyAudit } from "./audit";
import { isIndexNowReady } from "./indexnow";
import { undoSeoChange } from "./undo";

// Bu dosyanın kanıtladığı (SC-F8 geri alma): her tür "önce" durumuna döner;
// sayfa sonradan düzenlendiyse dokunulmaz (cannot_undo, sabit metin);
// yalnız OWNER/ADMIN geri alır (Telegram sözde kullanıcısı sorgusuz reddedilir);
// noop geri alınamaz; yazısı inmiş FAILED satır geri alınabilir; makale ->
// yayına al -> yayından kaldır -> makaleyi geri al zinciri çalışır; çöpe
// taşımada 404 "zaten yok" sayılır; başarısız geri alma geldiği duruma döner
// (error.undo = true).

vi.mock("@/lib/prisma", async () => ({
  prisma: (await import("./apply.testkit")).fakePrisma,
}));
vi.mock("./site", async () => ({
  gateApplySite: (await import("./apply.testkit")).fakeGate,
}));
vi.mock("./audit", () => ({
  recordSeoApplyAudit: vi.fn(async () => undefined),
}));
vi.mock("./action-link", () => ({
  onChangeVerified: vi.fn(async () => undefined),
  onChangeUndone: vi.fn(async () => undefined),
}));
vi.mock("./indexnow", () => ({
  isIndexNowReady: vi.fn(async () => false),
}));
vi.mock("@/server/repositories/task.repository", () => ({
  TaskRepository: { transition: vi.fn(async () => ({})) },
}));

const saved: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) saved[key] = process.env[key];

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const MINUTE = 60_000;
const UNDO_AT = new Date(NOW.getTime() + 10 * MINUTE);
const OWNER = { projectId: "proj-1", changeId: "chg-1", userId: "owner-1" };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SEO_APPLY = "true";
  process.env.SEO_HEALTH = "true";
  process.env.AGENTELSE_PROVIDER_MODE = "mock";
  delete process.env.SEO_DEV_PROJECTS;
  delete process.env.SEO_ROLLOUT_PROJECTS;
  vi.mocked(isIndexNowReady).mockResolvedValue(false);
  freshWordPress();
  resetGate();
  resetFake({ change: null });
});

function titleMetaChange(extra: Record<string, unknown> = {}) {
  addChange({
    kind: "TITLE_META",
    params: titleMetaParams(),
    dedupeKey: dedupeOf("TITLE_META", "page:102"),
    openKey: dedupeOf("TITLE_META", "page:102"),
    ...extra,
  });
  return makeClient();
}

function linksChange() {
  addChange({
    kind: "INTERNAL_LINKS",
    params: linksParams(),
    dedupeKey: dedupeOf("INTERNAL_LINKS", "page:101"),
    openKey: dedupeOf("INTERNAL_LINKS", "page:101"),
  });
  return makeClient();
}

function articleChange(extra: Record<string, unknown> = {}) {
  addChange({
    kind: "PUBLISH_ARTICLE",
    params: articleParams(),
    dedupeKey: dedupeOf("PUBLISH_ARTICLE", "cr-1:ver-1"),
    openKey: dedupeOf("PUBLISH_ARTICLE", "cr-1:ver-1"),
    creativeId: "cr-1",
    wpId: null,
    wpType: null,
    targetUrl: null,
    ...extra,
  });
  return makeClient();
}

async function applied(
  client: ReturnType<typeof makeClient>["client"],
  id = "chg-1",
): Promise<void> {
  const result = await applySeoChange(id, { client, now: NOW, mock: true });
  expect(["verified", "failed"]).toContain(result.state);
}

describe("undo restores the before state", () => {
  it("TITLE_META: writes the stored before values back and verifies", async () => {
    const { client, writes } = titleMetaChange();
    await applied(client);
    expect(writes).toEqual(["updateObject"]);

    const result = await undoSeoChange(OWNER, {
      client,
      now: UNDO_AT,
      mock: true,
    });

    expect(result).toEqual({ ok: true });
    expect(writes).toEqual(["updateObject", "updateObject"]);
    const row = change();
    expect(row.status).toBe("UNDONE");
    expect(row.rolledBackAt).toEqual(UNDO_AT);
    expect(row.undoneByUserId).toBe("owner-1");
    expect(row.openKey).toBeNull();
    expect(row.error).toBeNull();
    expect(row.leaseOwner).toBeNull();
    const live = await client.getObject("page", 102);
    // Sayfa 102'nin Yoast başlığı ve açıklaması başlangıçta boştu.
    expect(live?.meta["_yoast_wpseo_title"]).toBe("");
    expect(live?.meta["_yoast_wpseo_metadesc"]).toBe("");
    expect(recordSeoApplyAudit).toHaveBeenCalledWith(
      "seo_change.undone",
      { changeId: "chg-1", kind: "TITLE_META", source: "ACTION" },
      { workspaceId: "ws-1", projectId: "proj-1", userId: "owner-1" },
    );
  });

  it("INTERNAL_LINKS: restores the original content", async () => {
    const { client } = linksChange();
    const original = (await client.getObject("page", 101))?.content;
    await applied(client);
    expect((await client.getObject("page", 101))?.content).not.toBe(original);

    const result = await undoSeoChange(OWNER, {
      client,
      now: UNDO_AT,
      mock: true,
    });

    expect(result).toEqual({ ok: true });
    expect((await client.getObject("page", 101))?.content).toBe(original);
    expect(change().status).toBe("UNDONE");
  });

  it("PUBLISH_ARTICLE: moves the draft to the Trash", async () => {
    const { client } = articleChange();
    await applied(client);
    const id = change().wpId as number;

    const result = await undoSeoChange(OWNER, {
      client,
      now: UNDO_AT,
      mock: true,
    });

    expect(result).toEqual({ ok: true });
    expect((await client.getObject("post", id))?.status).toBe("trash");
    expect(change().status).toBe("UNDONE");
  });

  it("calls the SC-F6 link and queues IndexNow for page changes when ready", async () => {
    vi.mocked(isIndexNowReady).mockResolvedValue(true);
    const { client } = titleMetaChange({ seoActionId: "act-1" });
    await applied(client);

    await undoSeoChange(OWNER, { client, now: UNDO_AT, mock: true });

    expect(onChangeUndone).toHaveBeenCalledWith(
      expect.objectContaining({ id: "chg-1" }),
      { userId: "owner-1" },
    );
    expect(change().indexNow).toEqual({
      state: "PENDING",
      at: UNDO_AT.toISOString(),
    });
  });
});

describe("refusals", () => {
  it("refuses with a fixed cannot_undo message when the page was edited since", async () => {
    const { client, writes } = titleMetaChange();
    await applied(client);
    mockWpEdit(ORIGIN, 102, { content: "A human changed it again." });

    const result = await undoSeoChange(OWNER, {
      client,
      now: UNDO_AT,
      mock: true,
    });

    expect(result).toEqual({
      ok: false,
      message: SEO_CHANGE_ERROR_MESSAGES.cannot_undo,
    });
    expect(writes).toEqual(["updateObject"]);
    const row = change();
    expect(row.status).toBe("VERIFIED");
    expect(row.error).toMatchObject({ code: "cannot_undo", undo: true });
    expect(row.leaseOwner).toBeNull();
  });

  it("never trashes an article draft that was edited in WordPress", async () => {
    const { client, writes } = articleChange();
    await applied(client);
    mockWpEdit(ORIGIN, change().wpId as number, { title: "Edited by a human" });

    const result = await undoSeoChange(OWNER, {
      client,
      now: UNDO_AT,
      mock: true,
    });

    expect(result.ok).toBe(false);
    expect(writes).toEqual(["createPost"]);
    expect(change().status).toBe("VERIFIED");
  });

  it("refuses a member and never calls the site", async () => {
    const { client, writes } = titleMetaChange();
    await applied(client);
    const callsBefore = mockWpCalls().length;

    const result = await undoSeoChange(
      { ...OWNER, userId: "member-1" },
      { client, now: UNDO_AT, mock: true },
    );

    expect(result).toEqual({
      ok: false,
      message: "Only a workspace owner or admin can undo this.",
    });
    expect(writes).toEqual(["updateObject"]);
    expect(mockWpCalls().length).toBe(callsBefore);
    expect(change().status).toBe("VERIFIED");
  });

  it("denies a telegram pseudo user without a membership query", async () => {
    const { client } = titleMetaChange();
    await applied(client);
    fakePrisma.workspaceMember.findUnique.mockClear();

    const result = await undoSeoChange(
      { ...OWNER, userId: "telegram:99" },
      { client, now: UNDO_AT, mock: true },
    );

    expect(result.ok).toBe(false);
    expect(fakePrisma.workspaceMember.findUnique).not.toHaveBeenCalled();
  });

  it("refuses an unknown change", async () => {
    const result = await undoSeoChange(
      { ...OWNER, changeId: "nope" },
      { now: UNDO_AT, mock: true },
    );
    expect(result).toEqual({
      ok: false,
      message: "This change was not found.",
    });
  });

  it("never undoes a noop (nothing was written)", async () => {
    const { client, writes } = titleMetaChange({
      status: "VERIFIED",
      noop: true,
      appliedAt: null,
      verifiedAt: NOW,
    });
    const result = await undoSeoChange(OWNER, {
      client,
      now: UNDO_AT,
      mock: true,
    });
    expect(result).toEqual({
      ok: false,
      message: "This change can't be undone.",
    });
    expect(writes).toEqual([]);
  });

  it("refuses after the 90 day window", async () => {
    const { client, writes } = titleMetaChange({
      status: "VERIFIED",
      appliedAt: new Date(NOW.getTime() - 100 * 24 * 60 * MINUTE),
      verifiedAt: NOW,
    });
    const result = await undoSeoChange(OWNER, {
      client,
      now: UNDO_AT,
      mock: true,
    });
    expect(result.ok).toBe(false);
    expect(writes).toEqual([]);
  });

  it("refuses rows that are not VERIFIED or written FAILED", async () => {
    const { client } = titleMetaChange({ status: "APPROVED" });
    const result = await undoSeoChange(OWNER, {
      client,
      now: UNDO_AT,
      mock: true,
    });
    expect(result.ok).toBe(false);
    expect(change().status).toBe("APPROVED");
  });

  it("refuses when the site gate fails and leaves the status alone", async () => {
    const { client, writes } = titleMetaChange();
    await applied(client);
    gateConfig.fail = "site_unhealthy";

    const result = await undoSeoChange(OWNER, {
      client,
      now: UNDO_AT,
      mock: true,
    });

    expect(result).toEqual({
      ok: false,
      message: SEO_CHANGE_ERROR_MESSAGES.site_unhealthy,
    });
    expect(writes).toEqual(["updateObject"]);
    expect(change().status).toBe("VERIFIED");
    expect(fakeGate).toHaveBeenCalled();
  });

  it("is busy while another run holds the lease", async () => {
    const { client, writes } = titleMetaChange();
    await applied(client);
    change().leaseUntil = new Date(UNDO_AT.getTime() + MINUTE);

    const result = await undoSeoChange(OWNER, {
      client,
      now: UNDO_AT,
      mock: true,
    });

    expect(result.ok).toBe(false);
    expect(writes).toEqual(["updateObject"]);
    expect(change().status).toBe("VERIFIED");
  });

  it("refuses when the flag is off", async () => {
    const { client } = titleMetaChange();
    await applied(client);
    process.env.SEO_APPLY = "false";

    const result = await undoSeoChange(OWNER, {
      client,
      now: UNDO_AT,
      mock: true,
    });

    expect(result).toEqual({
      ok: false,
      message: SEO_CHANGE_ERROR_MESSAGES.not_enabled,
    });
    expect(change().status).toBe("VERIFIED");
  });
});

describe("a written FAILED row can be undone", () => {
  it("restores after a read-back mismatch", async () => {
    const { client } = titleMetaChange();
    setMockWpReadBackLie("update", true);
    await applied(client);
    expect(change().status).toBe("FAILED");
    setMockWpReadBackLie("update", false);

    const result = await undoSeoChange(OWNER, {
      client,
      now: UNDO_AT,
      mock: true,
    });

    expect(result).toEqual({ ok: true });
    expect(change().status).toBe("UNDONE");
    const live = await client.getObject("page", 102);
    expect(live?.meta["_yoast_wpseo_title"]).toBe("");
  });

  it("a failed undo of a FAILED row returns to FAILED (not VERIFIED)", async () => {
    const { client } = titleMetaChange();
    setMockWpReadBackLie("update", true);
    await applied(client);
    setMockWpReadBackLie("update", false);
    setMockWpFault("update", { status: 503 });

    const result = await undoSeoChange(OWNER, {
      client,
      now: UNDO_AT,
      mock: true,
    });

    expect(result.ok).toBe(false);
    const row = change();
    expect(row.status).toBe("FAILED");
    expect(row.verifiedAt).toBeNull();
    expect(row.error).toMatchObject({ code: "site_unavailable", undo: true });
  });

  it("adopts a draft with an unknown id for PUBLISH_ARTICLE and trashes it", async () => {
    seedMockWordPress(ORIGIN, {
      objects: [
        {
          id: 250,
          type: "post",
          status: "draft",
          title: "Local marketing tips for small teams",
          content: "x",
        },
      ],
    });
    const { client } = articleChange({
      status: "FAILED",
      appliedAt: NOW,
      after: null,
      error: { code: "site_unavailable", message: "x" },
    });

    const result = await undoSeoChange(OWNER, {
      client,
      now: UNDO_AT,
      mock: true,
    });

    expect(result).toEqual({ ok: true });
    expect((await client.getObject("post", 250))?.status).toBe("trash");
    expect(change().status).toBe("UNDONE");
  });

  it("is cannot_undo when no draft can be identified", async () => {
    const { client, writes } = articleChange({
      status: "FAILED",
      appliedAt: NOW,
      after: null,
    });

    const result = await undoSeoChange(OWNER, {
      client,
      now: UNDO_AT,
      mock: true,
    });

    expect(result).toEqual({
      ok: false,
      message: SEO_CHANGE_ERROR_MESSAGES.cannot_undo,
    });
    expect(writes).toEqual([]);
    expect(change().status).toBe("FAILED");
  });
});

describe("article -> make live -> undo live -> undo article", () => {
  it("keeps the draft after-snapshot in sync across the whole chain", async () => {
    const { client } = articleChange();
    await applied(client);
    const article = change();
    const wpId = article.wpId as number;
    const draftModified = (await client.getObject("post", wpId))?.modified;
    expect(draftModified).toBeTruthy();

    addChange({
      id: "chg-live",
      kind: "PUBLISH_LIVE",
      params: liveParams({
        draftChangeId: "chg-1",
        wpId,
        expectModified: draftModified,
      }),
      dedupeKey: dedupeOf("PUBLISH_LIVE", "chg-1"),
      openKey: dedupeOf("PUBLISH_LIVE", "chg-1"),
      creativeId: "cr-1",
      wpId,
      wpType: "post",
    });
    const live = await applySeoChange("chg-live", {
      client,
      now: NOW,
      mock: true,
    });
    expect(live.state).toBe("verified");
    expect(change("chg-1").after).toMatchObject({ status: "publish" });
    expect((await client.getObject("post", wpId))?.status).toBe("publish");

    // Yayındayken makaleyi geri almak güvenli değil.
    const blocked = await undoSeoChange(OWNER, {
      client,
      now: UNDO_AT,
      mock: true,
    });
    expect(blocked).toEqual({
      ok: false,
      message: SEO_CHANGE_ERROR_MESSAGES.cannot_undo,
    });
    expect(change("chg-1").status).toBe("VERIFIED");

    const unpublished = await undoSeoChange(
      { ...OWNER, changeId: "chg-live" },
      { client, now: UNDO_AT, mock: true },
    );
    expect(unpublished).toEqual({ ok: true });
    expect((await client.getObject("post", wpId))?.status).toBe("draft");
    expect(change("chg-live").status).toBe("UNDONE");
    expect(change("chg-1").after).toMatchObject({ status: "draft" });

    const trashed = await undoSeoChange(OWNER, {
      client,
      now: UNDO_AT,
      mock: true,
    });
    expect(trashed).toEqual({ ok: true });
    expect((await client.getObject("post", wpId))?.status).toBe("trash");
    expect(change("chg-1").status).toBe("UNDONE");
  });
});

describe("failure handling", () => {
  it("treats a 404 on the trash call as already gone", async () => {
    const { client } = articleChange();
    await applied(client);
    // Yazma indi, yanıt 404: çöpe taşıma gerçekleşti.
    setMockWpFault("trash", {
      status: 404,
      code: "rest_post_invalid_id",
      after: true,
    });

    const result = await undoSeoChange(OWNER, {
      client,
      now: UNDO_AT,
      mock: true,
    });

    expect(result).toEqual({ ok: true });
    expect(change().status).toBe("UNDONE");
  });

  it("returns a failed undo to VERIFIED with error.undo", async () => {
    const { client } = titleMetaChange();
    await applied(client);
    setMockWpFault("update", { status: 503 });

    const result = await undoSeoChange(OWNER, {
      client,
      now: UNDO_AT,
      mock: true,
    });

    expect(result).toEqual({
      ok: false,
      message: SEO_CHANGE_ERROR_MESSAGES.site_unavailable,
    });
    const row = change();
    expect(row.status).toBe("VERIFIED");
    expect(row.error).toEqual({
      code: "site_unavailable",
      message: SEO_CHANGE_ERROR_MESSAGES.site_unavailable,
      retryable: true,
      undo: true,
    });
    expect(row.leaseOwner).toBeNull();
    expect(row.leaseUntil).toBeNull();

    // Hata geçince aynı satır yeniden geri alınabilir.
    setMockWpFault("update", null);
    const again = await undoSeoChange(OWNER, {
      client,
      now: UNDO_AT,
      mock: true,
    });
    expect(again).toEqual({ ok: true });
    expect(change().status).toBe("UNDONE");
  });

  it("returns to VERIFIED with readback_mismatch when the restore did not stick", async () => {
    const { client } = titleMetaChange();
    await applied(client);
    setMockWpReadBackLie("update", true);

    const result = await undoSeoChange(OWNER, {
      client,
      now: UNDO_AT,
      mock: true,
    });

    expect(result).toEqual({
      ok: false,
      message: SEO_CHANGE_ERROR_MESSAGES.readback_mismatch,
    });
    expect(change().status).toBe("VERIFIED");
    expect(change().error).toMatchObject({
      code: "readback_mismatch",
      undo: true,
    });
  });

  it("marks the health AUTH on a 401 while undoing", async () => {
    const { client } = titleMetaChange();
    await applied(client);
    setMockWpFault("get", { status: 401, code: "rest_forbidden_context" });

    const result = await undoSeoChange(OWNER, {
      client,
      now: UNDO_AT,
      mock: true,
    });

    expect(result.ok).toBe(false);
    expect(fake.site.health).toBe("AUTH");
    expect(change().status).toBe("VERIFIED");
  });
});
