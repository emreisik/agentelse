import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { SEO_CHANGE_ERROR_MESSAGES } from "@/lib/seo/apply/copy";
import {
  mockWpCalls,
  mockWpEdit,
  seedMockWordPress,
  setMockWpFault,
  setMockWpReadBackLie,
} from "@/server/integrations/wordpress/mock-site";
import { WordPressApiError } from "@/server/integrations/wordpress/errors";
import { TaskRepository } from "@/server/repositories/task.repository";

import { onChangeVerified } from "./action-link";
import { applySeoChange } from "./apply";
import {
  ALL_CAPABILITIES,
  BASE_MODIFIED,
  ENV_KEYS,
  NOW,
  ORIGIN,
  RANKMATH_SPLIT_FIELDS,
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

// Bu dosyanın kanıtladığı (SC-F8 uygulama motoru): onay yokken, bayrak
// kapalıyken, kapı düşmüşken siteye HİÇ yazma çağrısı gitmez; her yazma
// geri okunur; geri okuma yalanı FAILED readback_mismatch olur ve ikinci bir
// yazma yapılmaz; zaman aşımına uğrayan yazma yeniden denemede kopya üretmez
// (taslak sahiplenilir, güncelleme "page_changed" sayılmaz); çok yazmalı
// değişiklik kaldığı yerden devam eder; yazısı inmiş FAILED satır geri alınabilir.

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

function later(minutes: number): Date {
  return new Date(NOW.getTime() + minutes * MINUTE);
}

function postCalls(): number {
  return mockWpCalls().filter((call) => call.method === "POST").length;
}

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

function setup(overrides: Record<string, unknown>) {
  addChange(overrides);
  return makeClient();
}

function titleMetaChange(extra: Record<string, unknown> = {}) {
  return setup({
    kind: "TITLE_META",
    params: titleMetaParams(),
    dedupeKey: dedupeOf("TITLE_META", "page:102"),
    openKey: dedupeOf("TITLE_META", "page:102"),
    ...extra,
  });
}

function linksChange(extra: Record<string, unknown> = {}) {
  return setup({
    kind: "INTERNAL_LINKS",
    params: linksParams(),
    dedupeKey: dedupeOf("INTERNAL_LINKS", "page:101"),
    openKey: dedupeOf("INTERNAL_LINKS", "page:101"),
    ...extra,
  });
}

function articleChange(extra: Record<string, unknown> = {}) {
  return setup({
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
}

describe("happy paths", () => {
  it("TITLE_META: reads, writes the Yoast fields, reads back and verifies", async () => {
    const { client, writes } = titleMetaChange();

    const result = await applySeoChange("chg-1", {
      client,
      now: NOW,
      mock: true,
    });

    expect(result.state).toBe("verified");
    expect(writes).toEqual(["updateObject"]);
    const row = change();
    expect(row.status).toBe("VERIFIED");
    expect(row.noop).toBe(false);
    expect(row.openKey).toBeNull();
    expect(row.leaseOwner).toBeNull();
    expect(row.appliedAt).toEqual(NOW);
    expect(row.verifiedAt).toEqual(NOW);
    expect(row.error).toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.before).toMatchObject({ exists: true, title: "About us" });
    expect(row.after).toMatchObject({ seoTitle: "About our small team" });

    const live = await client.getObject("page", 102);
    expect(live?.meta["_yoast_wpseo_title"]).toBe("About our small team");
    // Canlı okuma, tek yazma, geri okuma.
    expect(mockWpCalls().map((call) => call.method)).toEqual([
      "GET",
      "POST",
      "GET",
      "GET",
    ]);
  });

  it("INTERNAL_LINKS: inserts the link, keeps the raw content only in before", async () => {
    const { client, writes } = linksChange();

    const result = await applySeoChange("chg-1", {
      client,
      now: NOW,
      mock: true,
    });

    expect(result.state).toBe("verified");
    expect(writes).toEqual(["updateObject"]);
    const row = change();
    const before = row.before as { contentRaw: string | null };
    const after = row.after as { contentRaw: string | null };
    expect(before.contentRaw).toContain("Our pricing plans are simple");
    expect(after.contentRaw).toBeNull();
    const live = await client.getObject("page", 101);
    expect(live?.content).toContain(
      `<a href="${ORIGIN}/about">pricing plans</a>`,
    );
  });

  it("PUBLISH_ARTICLE: creates a draft only and stores wpId and the link", async () => {
    const { client, writes } = articleChange();

    const result = await applySeoChange("chg-1", {
      client,
      now: NOW,
      mock: true,
    });

    expect(result.state).toBe("verified");
    expect(writes).toEqual(["createPost"]);
    const row = change();
    expect(row.status).toBe("VERIFIED");
    expect(row.noop).toBe(false);
    expect(row.wpType).toBe("post");
    expect(typeof row.wpId).toBe("number");
    expect(row.liveUrl).toBeNull();
    expect(String(row.targetUrl)).toContain(ORIGIN);
    expect(row.before).toMatchObject({ exists: false });
    expect(row.after).toMatchObject({ status: "draft" });
    const live = await client.getObject("post", row.wpId as number);
    expect(live?.status).toBe("draft");
  });

  it("PUBLISH_LIVE: publishes the draft, stores liveUrl and syncs the draft change after-snapshot", async () => {
    seedMockWordPress(ORIGIN, {
      objects: [
        {
          id: 250,
          type: "post",
          status: "draft",
          slug: "local-tips",
          title: "Local tips",
          content: "<!-- wp:paragraph -->\n<p>Text</p>\n<!-- /wp:paragraph -->",
        },
      ],
    });
    addChange({
      id: "chg-article",
      kind: "PUBLISH_ARTICLE",
      status: "VERIFIED",
      params: articleParams(),
      wpId: 250,
      appliedAt: NOW,
      verifiedAt: NOW,
      after: { id: 250, status: "draft", modified: BASE_MODIFIED, link: null },
    });
    const { client, writes } = setup({
      id: "chg-live",
      kind: "PUBLISH_LIVE",
      params: liveParams({ wpId: 250, draftChangeId: "chg-article" }),
      dedupeKey: dedupeOf("PUBLISH_LIVE", "chg-article"),
      openKey: dedupeOf("PUBLISH_LIVE", "chg-article"),
      creativeId: "cr-1",
    });

    const result = await applySeoChange("chg-live", {
      client,
      now: NOW,
      mock: true,
    });

    expect(result.state).toBe("verified");
    expect(writes).toEqual(["updateObject"]);
    const row = change("chg-live");
    expect(row.status).toBe("VERIFIED");
    expect(row.liveUrl).toBe(`${ORIGIN}/local-tips`);
    const draft = change("chg-article");
    expect(draft.after).toMatchObject({ status: "publish" });
    expect((draft.after as { modified: string }).modified).not.toBe(
      BASE_MODIFIED,
    );
  });
});

describe("noop versus landedEarlier", () => {
  it("a plain noop writes nothing, is not counted and is not undoable", async () => {
    seedMockWordPress(ORIGIN, {
      objects: [{ id: 250, type: "post", status: "publish", title: "Live" }],
    });
    const { client, writes } = setup({
      kind: "PUBLISH_LIVE",
      params: liveParams({ wpId: 250 }),
      creativeId: "cr-1",
    });

    const result = await applySeoChange("chg-1", {
      client,
      now: NOW,
      mock: true,
    });

    expect(result.state).toBe("noop");
    expect(writes).toEqual([]);
    const row = change();
    expect(row.status).toBe("VERIFIED");
    expect(row.noop).toBe(true);
    expect(row.appliedAt).toBeNull();
    expect(row.before).toEqual(row.after);
    expect(isIndexNowReady).not.toHaveBeenCalled();
  });

  it("an already linked page is a noop for INTERNAL_LINKS", async () => {
    mockWpEdit(ORIGIN, 101, {
      content: `<!-- wp:paragraph -->\n<p>Our <a href="${ORIGIN}/about">pricing plans</a> are simple.</p>\n<!-- /wp:paragraph -->`,
    });
    const { client, writes } = linksChange({
      params: linksParams({ expectModified: "2026-09-20T10:01:00Z" }),
    });

    const result = await applySeoChange("chg-1", {
      client,
      now: NOW,
      mock: true,
    });

    expect(result.state).toBe("noop");
    expect(writes).toEqual([]);
    expect(change().noop).toBe(true);
  });

  it("a timed-out update that really landed becomes a counted, undoable change (not page_changed)", async () => {
    const { client, writes } = titleMetaChange();
    setMockWpFault("update", { status: 503, after: true });

    const first = await applySeoChange("chg-1", {
      client,
      now: NOW,
      mock: true,
    });
    expect(first.state).toBe("retry");
    expect(change().status).toBe("APPROVED");
    expect(change().attempts).toBe(1);
    expect(change().before).toMatchObject({ title: "About us" });
    expect(change().nextAttemptAt).toEqual(later(2));

    setMockWpFault("update", null);
    const second = await applySeoChange("chg-1", {
      client,
      now: later(3),
      mock: true,
    });

    expect(second.state).toBe("verified");
    expect(writes).toEqual(["updateObject"]);
    const row = change();
    expect(row.status).toBe("VERIFIED");
    expect(row.noop).toBe(false);
    expect(row.appliedAt).toEqual(later(3));
    expect(row.before).toMatchObject({ seoTitle: "" });
    expect(row.after).toMatchObject({ seoTitle: "About our small team" });
  });

  it("a timed-out create is adopted: one draft, noop=false, make-live stays possible", async () => {
    const { client, writes } = articleChange();
    setMockWpFault("create", { status: 503, after: true });

    const first = await applySeoChange("chg-1", {
      client,
      now: NOW,
      mock: true,
    });
    expect(first.state).toBe("retry");

    setMockWpFault("create", null);
    const second = await applySeoChange("chg-1", {
      client,
      now: later(3),
      mock: true,
    });

    expect(second.state).toBe("verified");
    expect(writes).toEqual(["createPost"]);
    expect(postCalls()).toBe(1);
    const row = change();
    expect(row.status).toBe("VERIFIED");
    expect(row.noop).toBe(false);
    expect(row.appliedAt).toEqual(later(3));
    expect(typeof row.wpId).toBe("number");
    expect(row.before).toMatchObject({ exists: false });
    expect(row.after).toMatchObject({ status: "draft" });
  });
});

describe("gates: the writer is never called", () => {
  async function expectNoWrite(
    state: string,
    code?: string,
    status = "FAILED",
  ): Promise<void> {
    const { client, writes } = makeClient();
    const result = await applySeoChange("chg-1", {
      client,
      now: NOW,
      mock: true,
    });
    expect(result.state).toBe(state);
    expect(writes).toEqual([]);
    expect(change().status).toBe(status);
    if (code) {
      expect((change().error as { code: string }).code).toBe(code);
    }
  }

  it("does not touch a PROPOSED row", async () => {
    addChange({ status: "PROPOSED", params: titleMetaParams() });
    await expectNoWrite("skipped", undefined, "PROPOSED");
  });

  it("refuses without an approval id", async () => {
    addChange({ params: titleMetaParams(), approvalId: null });
    await expectNoWrite("failed", "approval_missing");
  });

  it.each(["PENDING", "REJECTED", "EXPIRED", "CANCELLED"])(
    "refuses when the Approval is %s",
    async (status) => {
      addChange({ params: titleMetaParams() });
      fake.approval = { id: "appr-1", status, expiresAt: null };
      await expectNoWrite("failed", "approval_missing");
      expect((change().error as { message: string }).message).toBe(
        SEO_CHANGE_ERROR_MESSAGES.approval_missing,
      );
    },
  );

  it("applies an APPROVED approval even when its expiresAt has passed", async () => {
    addChange({ params: titleMetaParams() });
    fake.approval = {
      id: "appr-1",
      status: "APPROVED",
      expiresAt: new Date("2020-01-01T00:00:00Z"),
    };
    const { client } = makeClient();
    const result = await applySeoChange("chg-1", {
      client,
      now: NOW,
      mock: true,
    });
    expect(result.state).toBe("verified");
  });

  it("leaves the row alone when the flag is off", async () => {
    process.env.SEO_APPLY = "false";
    addChange({ params: titleMetaParams() });
    await expectNoWrite("skipped", undefined, "APPROVED");
    expect(change().attempts).toBe(0);
  });

  it("leaves a real-site row alone in a mock process (and vice versa)", async () => {
    addChange({ params: titleMetaParams(), isMock: false });
    await expectNoWrite("skipped", undefined, "APPROVED");
  });

  it("restricts a dev process to SEO_DEV_PROJECTS", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@db.example.com:5432/live");
    vi.stubEnv("SEO_DEV_PROJECTS", "other-project");
    try {
      addChange({ params: titleMetaParams() });
      await expectNoWrite("skipped", undefined, "APPROVED");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    "not_connected",
    "site_unhealthy",
    "reconnect",
    "domain_mismatch",
    "scope_changed",
  ] as const)("fails with the gate code %s", async (code) => {
    gateConfig.fail = code;
    addChange({ params: titleMetaParams() });
    await expectNoWrite("failed", code);
  });

  it("fails with no_permission when the capability is missing", async () => {
    gateConfig.capabilities = { ...ALL_CAPABILITIES, editOthers: false };
    addChange({ params: titleMetaParams() });
    await expectNoWrite("failed", "no_permission");
  });

  it("fails with reconnect when the credential cannot be opened", async () => {
    addChange({ params: titleMetaParams() });
    const result = await applySeoChange("chg-1", {
      clientFor: async () => null,
      now: NOW,
      mock: true,
    });
    expect(result.state).toBe("failed");
    expect((change().error as { code: string }).code).toBe("reconnect");
  });

  it("is busy while another run holds the lease", async () => {
    addChange({
      params: titleMetaParams(),
      leaseUntil: later(1),
      leaseOwner: "other",
    });
    const { client, writes } = makeClient();
    const result = await applySeoChange("chg-1", {
      client,
      now: NOW,
      mock: true,
    });
    expect(result.state).toBe("busy");
    expect(writes).toEqual([]);
    expect(change().leaseOwner).toBe("other");
  });

  it("returns gone for an unknown id", async () => {
    const result = await applySeoChange("nope", { now: NOW, mock: true });
    expect(result.state).toBe("gone");
  });
});

describe("rate window", () => {
  it("waits (stays APPROVED, attempts unchanged) when the daily limit is used up", async () => {
    fake.setting = { dailyLimit: 1 };
    const appliedAt = new Date(NOW.getTime() - 60 * MINUTE);
    addChange({
      id: "chg-old",
      status: "VERIFIED",
      appliedAt,
      verifiedAt: appliedAt,
      noop: false,
    });
    const { client, writes } = titleMetaChange();

    const result = await applySeoChange("chg-1", {
      client,
      now: NOW,
      mock: true,
    });

    expect(result.state).toBe("waiting");
    expect(writes).toEqual([]);
    const row = change();
    expect(row.status).toBe("APPROVED");
    expect(row.attempts).toBe(0);
    expect(row.leaseOwner).toBeNull();
    expect(row.nextAttemptAt).toEqual(
      new Date(appliedAt.getTime() + 24 * 60 * MINUTE),
    );

    // Pencere açıldığında kendiliğinden uygulanır.
    const next = await applySeoChange("chg-1", {
      client,
      now: new Date(appliedAt.getTime() + 24 * 60 * MINUTE),
      mock: true,
    });
    expect(next.state).toBe("verified");
  });

  it("does not count noops or rows outside the window", async () => {
    fake.setting = { dailyLimit: 1 };
    addChange({
      id: "chg-noop",
      status: "VERIFIED",
      noop: true,
      appliedAt: NOW,
    });
    addChange({
      id: "chg-ancient",
      status: "VERIFIED",
      appliedAt: new Date(NOW.getTime() - 48 * 60 * MINUTE),
    });
    const { client } = titleMetaChange();
    const result = await applySeoChange("chg-1", {
      client,
      now: NOW,
      mock: true,
    });
    expect(result.state).toBe("verified");
  });
});

describe("retry, backoff and the third attempt", () => {
  it("retries a retryable error with backoff and ends FAILED at the third attempt", async () => {
    const { client, writes } = titleMetaChange();
    setMockWpFault("update", { status: 503 });

    const first = await applySeoChange("chg-1", {
      client,
      now: NOW,
      mock: true,
    });
    expect(first.state).toBe("retry");
    expect(change().status).toBe("APPROVED");
    expect(change().nextAttemptAt).toEqual(later(2));
    const beforeStored = change().before;
    expect(beforeStored).not.toBeNull();

    // Vade gelmeden claim edilemez.
    const tooEarly = await applySeoChange("chg-1", {
      client,
      now: later(1),
      mock: true,
    });
    expect(tooEarly.state).toBe("busy");

    const second = await applySeoChange("chg-1", {
      client,
      now: later(3),
      mock: true,
    });
    expect(second.state).toBe("retry");
    expect(change().attempts).toBe(2);
    expect(change().nextAttemptAt).toEqual(later(13));
    expect(change().before).toEqual(beforeStored);

    const third = await applySeoChange("chg-1", {
      client,
      now: later(14),
      mock: true,
    });
    expect(third.state).toBe("failed");
    const row = change();
    expect(row.status).toBe("FAILED");
    expect(row.openKey).toBeNull();
    expect(row.attempts).toBe(3);
    expect((row.error as { code: string }).code).toBe("site_unavailable");
    expect(writes.length).toBe(3);
    // Task'a yalnız sabit metin gider.
    expect(TaskRepository.transition).toHaveBeenLastCalledWith(
      "task-1",
      "proj-1",
      "FAILED",
      { failureReason: SEO_CHANGE_ERROR_MESSAGES.site_unavailable },
    );
  });

  it("fails a non-retryable error at once with a fixed message", async () => {
    const { client } = titleMetaChange();
    setMockWpFault("update", { status: 403, code: "rest_cannot_edit" });

    const result = await applySeoChange("chg-1", {
      client,
      now: NOW,
      mock: true,
    });

    expect(result.state).toBe("failed");
    const row = change();
    expect(row.status).toBe("FAILED");
    expect(row.appliedAt).toBeNull();
    expect(row.error).toEqual({
      code: "no_permission",
      message: SEO_CHANGE_ERROR_MESSAGES.no_permission,
      retryable: false,
    });
  });

  it("marks the site health AUTH and fails with reconnect on a 401", async () => {
    const { client, writes } = titleMetaChange();
    setMockWpFault("get", { status: 401, code: "rest_forbidden_context" });

    const result = await applySeoChange("chg-1", {
      client,
      now: NOW,
      mock: true,
    });

    expect(result.state).toBe("failed");
    expect(writes).toEqual([]);
    expect((change().error as { code: string }).code).toBe("reconnect");
    expect(fake.site.health).toBe("AUTH");
    expect(fakePrisma.cmsSite.updateMany).toHaveBeenCalled();
  });
});

describe("multi-write TITLE_META resumes with only the remaining write", () => {
  function splitSetup() {
    gateConfig.fields = RANKMATH_SPLIT_FIELDS;
    seedMockWordPress(ORIGIN, { seoPlugin: "RANK_MATH_ENDPOINT" });
    return titleMetaChange();
  }

  it("is APPLIED after the first write, then resumes and verifies", async () => {
    const { client, writes } = splitSetup();
    setMockWpFault("rankmath", { status: 503 });

    const first = await applySeoChange("chg-1", {
      client,
      now: NOW,
      mock: true,
    });
    expect(first.state).toBe("retry");
    expect(writes).toEqual(["updateObject", "rankMathUpdateMeta"]);
    expect(change().status).toBe("APPLIED");
    expect(change().appliedAt).toEqual(NOW);
    expect(change().openKey).not.toBeNull();
    expect(change().nextAttemptAt).toEqual(later(2));

    setMockWpFault("rankmath", null);
    const second = await applySeoChange("chg-1", {
      client,
      now: later(3),
      mock: true,
    });

    expect(second.state).toBe("verified");
    // Güncelleme yeniden gönderilmedi: yalnız kalan yazma.
    expect(writes).toEqual([
      "updateObject",
      "rankMathUpdateMeta",
      "rankMathUpdateMeta",
    ]);
    expect(change().status).toBe("VERIFIED");
    expect(change().appliedAt).toEqual(NOW);
    expect(change().noop).toBe(false);
  });

  it("ends FAILED at the third attempt with appliedAt kept (undoable)", async () => {
    const { client } = splitSetup();
    setMockWpFault("rankmath", { status: 503 });

    await applySeoChange("chg-1", { client, now: NOW, mock: true });
    await applySeoChange("chg-1", { client, now: later(3), mock: true });
    const third = await applySeoChange("chg-1", {
      client,
      now: later(14),
      mock: true,
    });

    expect(third.state).toBe("failed");
    const row = change();
    expect(row.status).toBe("FAILED");
    expect(row.appliedAt).toEqual(NOW);
    expect(row.openKey).toBeNull();
    expect(row.before).toMatchObject({ title: "About us" });
  });
});

describe("read-back", () => {
  it("a mismatch ends FAILED readback_mismatch without a second write and stores what was read", async () => {
    const { client, writes } = titleMetaChange();
    setMockWpReadBackLie("update", true);

    const result = await applySeoChange("chg-1", {
      client,
      now: NOW,
      mock: true,
    });

    expect(result.state).toBe("failed");
    expect(writes).toEqual(["updateObject"]);
    const row = change();
    expect(row.status).toBe("FAILED");
    expect((row.error as { code: string }).code).toBe("readback_mismatch");
    expect(row.appliedAt).toEqual(NOW);
    expect(row.after).toMatchObject({ exists: true });
    expect((row.after as { seoTitle: string }).seoTitle).toContain("[changed]");
  });

  it("an error in the read-back call retries without writing again and then verifies", async () => {
    const { client, writes } = titleMetaChange();
    // İlk GET (canlı okuma) geçer; yazmadan sonraki ilk GET (geri okuma) düşer.
    let reads = 0;
    const flaky = {
      ...client,
      getObject: async (...args: Parameters<typeof client.getObject>) => {
        reads += 1;
        if (reads === 2) throw new WordPressApiError("TRANSIENT");
        return client.getObject(...args);
      },
    };

    const first = await applySeoChange("chg-1", {
      client: flaky,
      now: NOW,
      mock: true,
    });
    expect(first.state).toBe("retry");
    expect(change().status).toBe("APPLIED");
    expect(change().appliedAt).toEqual(NOW);
    expect(change().nextAttemptAt).toEqual(later(2));

    const second = await applySeoChange("chg-1", {
      client: flaky,
      now: later(3),
      mock: true,
    });
    expect(second.state).toBe("verified");
    expect(writes).toEqual(["updateObject"]);
    const row = change();
    expect(row.status).toBe("VERIFIED");
    expect(row.noop).toBe(false);
    expect(row.appliedAt).toEqual(NOW);
    expect(row.before).toMatchObject({ seoTitle: "" });
  });

  it("gives up after the third failed read-back with site_unavailable and keeps appliedAt (undoable)", async () => {
    const { client, writes } = titleMetaChange();
    let writtenAlready = false;
    const flaky = {
      ...client,
      updateObject: async (...args: Parameters<typeof client.updateObject>) => {
        writtenAlready = true;
        return client.updateObject(...args);
      },
      getObject: async (...args: Parameters<typeof client.getObject>) => {
        if (writtenAlready) throw new WordPressApiError("TRANSIENT");
        return client.getObject(...args);
      },
    };

    await applySeoChange("chg-1", { client: flaky, now: NOW, mock: true });
    await applySeoChange("chg-1", { client: flaky, now: later(3), mock: true });
    const third = await applySeoChange("chg-1", {
      client: flaky,
      now: later(14),
      mock: true,
    });

    expect(third.state).toBe("failed");
    // Yazma yalnız bir kez gitti; sonraki denemeler yalnız okudu.
    expect(writes).toEqual(["updateObject"]);
    const row = change();
    expect(row.status).toBe("FAILED");
    expect((row.error as { code: string }).code).toBe("site_unavailable");
    expect(row.appliedAt).toEqual(NOW);
  });
});

describe("stale protection", () => {
  it("refuses with page_changed when the page was edited after approval", async () => {
    const { client, writes } = titleMetaChange();
    mockWpEdit(ORIGIN, 102, { content: "Changed by a human." });

    const result = await applySeoChange("chg-1", {
      client,
      now: NOW,
      mock: true,
    });

    expect(result.state).toBe("failed");
    expect(writes).toEqual([]);
    expect((change().error as { code: string }).code).toBe("page_changed");
  });

  it("refuses PUBLISH_LIVE when the draft was edited after the proposal", async () => {
    seedMockWordPress(ORIGIN, {
      objects: [{ id: 250, type: "post", status: "draft", title: "Draft" }],
    });
    const { client, writes } = setup({
      kind: "PUBLISH_LIVE",
      params: liveParams({ wpId: 250 }),
      creativeId: "cr-1",
    });
    mockWpEdit(ORIGIN, 250, { title: "Edited in WordPress" });

    const result = await applySeoChange("chg-1", {
      client,
      now: NOW,
      mock: true,
    });

    expect(result.state).toBe("failed");
    expect(writes).toEqual([]);
    expect((change().error as { code: string }).code).toBe("page_changed");
  });

  it("refuses a builder page for INTERNAL_LINKS", async () => {
    seedMockWordPress(ORIGIN, { builderPageIds: [101] });
    const { client, writes } = linksChange();
    const result = await applySeoChange("chg-1", {
      client,
      now: NOW,
      mock: true,
    });
    expect(result.state).toBe("failed");
    expect(writes).toEqual([]);
    expect((change().error as { code: string }).code).toBe("builder_page");
  });

  it("refuses when the page is gone", async () => {
    const { client, writes } = titleMetaChange({
      params: titleMetaParams({ wpId: 999 }),
    });
    const result = await applySeoChange("chg-1", {
      client,
      now: NOW,
      mock: true,
    });
    expect(result.state).toBe("failed");
    expect(writes).toEqual([]);
    expect((change().error as { code: string }).code).toBe("page_not_found");
  });
});

describe("post-steps", () => {
  it("links the SC-F6 action, queues IndexNow and completes the Task after VERIFIED", async () => {
    vi.mocked(isIndexNowReady).mockResolvedValue(true);
    const { client } = titleMetaChange({ seoActionId: "act-1" });

    await applySeoChange("chg-1", { client, now: NOW, mock: true });

    expect(onChangeVerified).toHaveBeenCalledTimes(1);
    expect(onChangeVerified).toHaveBeenCalledWith(
      expect.objectContaining({ id: "chg-1", status: "VERIFIED" }),
      { userId: "owner-1" },
    );
    expect(change().indexNow).toEqual({
      state: "PENDING",
      at: NOW.toISOString(),
    });
    expect(TaskRepository.transition).toHaveBeenLastCalledWith(
      "task-1",
      "proj-1",
      "COMPLETED",
      undefined,
    );
    expect(recordSeoApplyAudit).toHaveBeenCalledWith(
      "seo_change.verified",
      expect.objectContaining({ changeId: "chg-1", kind: "TITLE_META" }),
      { workspaceId: "ws-1", projectId: "proj-1" },
    );
  });

  it("does not link or queue IndexNow when there is nothing to link or IndexNow is not ready", async () => {
    const { client } = titleMetaChange();
    await applySeoChange("chg-1", { client, now: NOW, mock: true });
    expect(onChangeVerified).not.toHaveBeenCalled();
    expect(change().indexNow).toBeNull();
  });

  it("never queues IndexNow for a created draft", async () => {
    vi.mocked(isIndexNowReady).mockResolvedValue(true);
    const { client } = articleChange();
    await applySeoChange("chg-1", { client, now: NOW, mock: true });
    expect(change().indexNow).toBeNull();
    // Makale döngüsü creativeId ile bağlanır.
    expect(onChangeVerified).toHaveBeenCalledTimes(1);
  });

  it("records only fixed texts in the audit and Task on failure", async () => {
    const { client } = titleMetaChange();
    setMockWpFault("update", { status: 403, code: "rest_cannot_edit" });
    await applySeoChange("chg-1", { client, now: NOW, mock: true });
    expect(recordSeoApplyAudit).toHaveBeenCalledWith(
      "seo_change.failed",
      {
        changeId: "chg-1",
        kind: "TITLE_META",
        source: "ACTION",
        code: "no_permission",
      },
      { workspaceId: "ws-1", projectId: "proj-1" },
    );
    expect(fakeGate).toHaveBeenCalled();
  });
});
