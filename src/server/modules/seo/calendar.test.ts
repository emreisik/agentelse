import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// placeSeoArticle over the REAL post writer (save-plan-core createPostsInTx):
// the transaction client is an in-memory stand-in, so what reaches each table
// is what production would write.

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  creativeFindFirst: vi.fn(),
  primaryLink: vi.fn(),
  countInMonth: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    creative: { findFirst: mocks.creativeFindFirst },
  },
}));

// SC-F7 (aylık SEO planı) bağımlılıkları: bayrak kapalıyken hiçbiri çağrılmaz.
vi.mock("@/server/seo/store", () => ({ primaryGscLink: mocks.primaryLink }));
vi.mock("@/server/seo/content-plan/pieces", () => ({
  countSeoPiecesInMonth: mocks.countInMonth,
}));
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: mocks.audit },
}));

import {
  placeSeoArticle,
  SeoMonthlyCapError,
  seoPieceStatus,
} from "./calendar";

const SCHEDULED = new Date("2026-10-09T07:00:00.000Z");

const tx = {
  creative: {
    findFirst: vi.fn(),
    create: vi.fn(async () => ({ id: "cr-1" })),
    findUniqueOrThrow: vi.fn(async () => ({
      postId: "post-1",
      scheduledFor: SCHEDULED,
    })),
    update: vi.fn(async () => ({})),
  },
  creativeVersion: { create: vi.fn(async () => ({ id: "v-1" })) },
  post: {
    create: vi.fn(async () => ({ id: "post-1" })),
    update: vi.fn(async () => ({})),
  },
  seoContentSetting: { findUnique: vi.fn() },
};

const ARTICLE = {
  title: "How to choose running shoes",
  metaDescription: "Pick running shoes that fit.",
  markdown: "Intro.\n\n## Section",
  writtenAt: "2026-10-05T09:00:00.000Z",
  rewrites: 0,
};

const input = {
  scope: { workspaceId: "ws1", projectId: "p1", brandId: "b1" },
  userId: "u1",
  commandId: "cmd1",
  workId: "w1",
  timezone: "Europe/Istanbul",
  when: "2026-10-09T10:00",
  article: ARTICLE,
  brief: {
    topic: "Running shoes",
    siteUrl: "https://example.com",
    language: "en",
    audience: "",
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  // mockReset: önceki testten kalan "once" değerleri de temizlenir.
  tx.creative.findFirst.mockReset();
  tx.creative.findFirst.mockResolvedValue(null);
  tx.seoContentSetting.findUnique.mockResolvedValue(null);
  mocks.transaction.mockImplementation(
    async (run: (client: typeof tx) => Promise<unknown>) => run(tx),
  );
});

describe("placeSeoArticle", () => {
  it("writes ONE Post with ONE approved Blog/SEO delivery carrying the article", async () => {
    const placed = await placeSeoArticle(input);
    expect(placed).toEqual({
      postId: "post-1",
      creativeId: "cr-1",
      scheduledFor: SCHEDULED,
      reused: false,
    });

    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
    });
    expect(tx.post.create).toHaveBeenCalledTimes(1);
    expect(tx.post.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "ws1",
        projectId: "p1",
        brandId: "b1",
        workId: "w1",
        planId: "cmd1",
        topic: ARTICLE.title,
        idea: ARTICLE.metaDescription,
        goal: "traffic",
        // 10:00 in Istanbul (UTC+3).
        scheduledFor: SCHEDULED,
        timezone: "Europe/Istanbul",
      }),
      select: { id: true },
    });
    expect(tx.creative.create).toHaveBeenCalledTimes(1);
    expect(tx.creative.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "COPY",
        channel: "seo",
        formatKey: "seo.article",
        planId: "cmd1",
        postId: "post-1",
        title: ARTICLE.title,
        brief: ARTICLE.metaDescription,
        status: "DRAFT",
        scheduledFor: SCHEDULED,
      }),
      select: { id: true },
    });
    expect(tx.creativeVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        creativeId: "cr-1",
        version: 1,
        copy: ARTICLE.markdown,
      }),
      select: { id: true },
    });
    expect(tx.creative.update).toHaveBeenCalledWith({
      where: { id: "cr-1" },
      data: { status: "APPROVED", currentVersionId: "v-1" },
    });
    expect(tx.post.update).toHaveBeenCalledWith({
      where: { id: "post-1" },
      data: { approvedAt: expect.any(Date), approvedByUserId: "u1" },
    });
  });

  it("finds the card's piece from an earlier attempt instead of adding one", async () => {
    tx.creative.findFirst.mockResolvedValue({
      id: "cr-0",
      postId: "post-0",
      scheduledFor: SCHEDULED,
    });
    expect(await placeSeoArticle(input)).toEqual({
      postId: "post-0",
      creativeId: "cr-0",
      scheduledFor: SCHEDULED,
      reused: true,
    });
    expect(tx.creative.findFirst).toHaveBeenCalledWith({
      where: {
        projectId: "p1",
        planId: "cmd1",
        formatKey: "seo.article",
        status: { not: "ARCHIVED" },
      },
      select: { id: true, postId: true, scheduledFor: true },
    });
    expect(tx.post.create).not.toHaveBeenCalled();
    expect(tx.creative.create).not.toHaveBeenCalled();
  });
});

describe("seoPieceStatus", () => {
  it("reads the piece in the project, null when it is gone", async () => {
    mocks.creativeFindFirst.mockResolvedValueOnce({ status: "PUBLISHED" });
    expect(await seoPieceStatus("p1", "cr-1")).toBe("PUBLISHED");
    mocks.creativeFindFirst.mockResolvedValueOnce({ status: "ARCHIVED" });
    expect(await seoPieceStatus("p1", "cr-1")).toBeNull();
    mocks.creativeFindFirst.mockResolvedValueOnce(null);
    expect(await seoPieceStatus("p1", "cr-1")).toBeNull();
    expect(mocks.creativeFindFirst).toHaveBeenCalledWith({
      where: { id: "cr-1", projectId: "p1" },
      select: { status: true },
    });
  });
});

// ---------------------------------------------------------------------------
// SC-F7: aylık sınır ve slot tüketimi (docs/search-content-plan.md)
// ---------------------------------------------------------------------------

const PLAN_ENV = [
  "SEO_CONTENT_PLAN",
  "GSC_SYNC",
  "SEO_INSIGHTS",
  "GSC_SEARCH_PAGE",
  "GSC_ROLLOUT_PROJECTS",
] as const;
const savedEnv: Record<string, string | undefined> = {};

function planOn() {
  process.env.SEO_CONTENT_PLAN = "true";
  process.env.GSC_SYNC = "true";
  process.env.SEO_INSIGHTS = "on";
  process.env.GSC_SEARCH_PAGE = "true";
  delete process.env.GSC_ROLLOUT_PROJECTS;
}

// Ekim ayında planlanmış, dokunulmamış slot (10:00 İstanbul).
const SLOT = {
  id: "cr-slot",
  postId: "post-slot",
  scheduledFor: new Date("2026-10-12T07:00:00.000Z"),
};

// İlk findFirst idempotans aramasıdır, ikincisi slot aramasıdır.
function withSlot(slot: typeof SLOT | null) {
  tx.creative.findFirst
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(slot);
}

describe("placeSeoArticle with SEO_CONTENT_PLAN off", () => {
  beforeEach(() => {
    for (const key of PLAN_ENV) savedEnv[key] = process.env[key];
    for (const key of PLAN_ENV) delete process.env[key];
  });
  afterEach(() => {
    for (const key of PLAN_ENV) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("runs the current code path: no link read, no setting, no slot lookup, no cap", async () => {
    mocks.countInMonth.mockResolvedValue(99);
    await placeSeoArticle({ ...input, ideaId: "idea-1" });
    expect(mocks.primaryLink).not.toHaveBeenCalled();
    expect(tx.seoContentSetting.findUnique).not.toHaveBeenCalled();
    expect(mocks.countInMonth).not.toHaveBeenCalled();
    // Yalnız idempotans araması.
    expect(tx.creative.findFirst).toHaveBeenCalledTimes(1);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(tx.post.create).toHaveBeenCalledTimes(1);
  });

  it("does not retry a serialization failure (current behaviour)", async () => {
    mocks.transaction.mockRejectedValueOnce({ code: "P2034" });
    await expect(placeSeoArticle(input)).rejects.toMatchObject({
      code: "P2034",
    });
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
  });
});

describe("placeSeoArticle with the plan active", () => {
  beforeEach(() => {
    for (const key of PLAN_ENV) savedEnv[key] = process.env[key];
    planOn();
    mocks.primaryLink.mockResolvedValue({ id: "link-1" });
    mocks.countInMonth.mockResolvedValue(1);
    mocks.audit.mockResolvedValue({});
  });
  afterEach(() => {
    for (const key of PLAN_ENV) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("makes no cap check and no extra query for a project without a Search Console link", async () => {
    mocks.primaryLink.mockResolvedValue(null);
    mocks.countInMonth.mockResolvedValue(99);
    await placeSeoArticle({ ...input, ideaId: "idea-1" });
    expect(mocks.primaryLink).toHaveBeenCalledWith("p1");
    expect(tx.seoContentSetting.findUnique).not.toHaveBeenCalled();
    expect(mocks.countInMonth).not.toHaveBeenCalled();
    expect(tx.creative.findFirst).toHaveBeenCalledTimes(1);
  });

  it("places a new article below the cap with the counted month and the default cap", async () => {
    withSlot(null);
    await placeSeoArticle({ ...input, ideaId: "idea-1" });
    expect(tx.seoContentSetting.findUnique).toHaveBeenCalledWith({
      where: { projectId: "p1" },
    });
    expect(mocks.countInMonth).toHaveBeenCalledWith(tx, {
      projectId: "p1",
      month: "2026-10",
      timezone: "Europe/Istanbul",
      excludeCreativeId: undefined,
    });
    expect(tx.post.create).toHaveBeenCalledTimes(1);
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
    });
  });

  it("looks the slot up by the idea with the untouched-slot filter", async () => {
    withSlot(null);
    await placeSeoArticle({ ...input, ideaId: "idea-1" });
    expect(tx.creative.findFirst).toHaveBeenNthCalledWith(2, {
      where: {
        projectId: "p1",
        formatKey: "seo.article",
        status: "DRAFT",
        planId: null,
        excludedAt: null,
        versions: { none: {} },
        post: { ideaId: "idea-1" },
      },
      select: { id: true, postId: true, scheduledFor: true },
    });
  });

  it("refuses with SeoMonthlyCapError at the cap and writes nothing", async () => {
    mocks.countInMonth.mockResolvedValue(4);
    withSlot(null);
    const error = await placeSeoArticle({ ...input, ideaId: "idea-1" }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SeoMonthlyCapError);
    expect((error as SeoMonthlyCapError).cap).toBe(4);
    expect((error as Error).message).toBe(
      "The limit of 4 articles for that month is reached. Change the limit on the Search page, or pick another month.",
    );
    expect(tx.post.create).not.toHaveBeenCalled();
    expect(tx.post.update).not.toHaveBeenCalled();
    expect(tx.creative.create).not.toHaveBeenCalled();
    expect(tx.creative.update).not.toHaveBeenCalled();
    expect(tx.creativeVersion.create).not.toHaveBeenCalled();
  });

  it("uses the saved cap", async () => {
    tx.seoContentSetting.findUnique.mockResolvedValue({
      monthlyCap: 2,
      autoPlan: true,
    });
    mocks.countInMonth.mockResolvedValue(2);
    await expect(placeSeoArticle(input)).rejects.toMatchObject({ cap: 2 });
  });

  it("records cap_blocked after the rollback, best effort", async () => {
    mocks.countInMonth.mockResolvedValue(4);
    const order: string[] = [];
    mocks.transaction.mockImplementationOnce(
      async (run: (client: typeof tx) => Promise<unknown>) => {
        try {
          return await run(tx);
        } finally {
          order.push("rolled-back");
        }
      },
    );
    mocks.audit.mockImplementation(async () => {
      order.push("audit");
      throw new Error("audit down");
    });
    // Denetim yazılamasa da kullanıcı sınır hatasını görür.
    await expect(placeSeoArticle(input)).rejects.toBeInstanceOf(
      SeoMonthlyCapError,
    );
    expect(order).toEqual(["rolled-back", "audit"]);
    expect(mocks.audit).toHaveBeenCalledWith({
      workspaceId: "ws1",
      projectId: "p1",
      brandId: "b1",
      actorType: "USER",
      actorId: "u1",
      action: "seo_content_plan.cap_blocked",
      entityType: "Project",
      entityId: "p1",
      metadata: { cap: 4 },
    });
  });

  it("does not retry a cap refusal", async () => {
    mocks.countInMonth.mockResolvedValue(4);
    await expect(placeSeoArticle(input)).rejects.toBeInstanceOf(
      SeoMonthlyCapError,
    );
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
  });

  it("capExempt ('Mark as published') bypasses the cap and the setting read", async () => {
    mocks.countInMonth.mockResolvedValue(9);
    const placed = await placeSeoArticle({ ...input, capExempt: true });
    expect(placed.reused).toBe(false);
    expect(mocks.countInMonth).not.toHaveBeenCalled();
    expect(tx.seoContentSetting.findUnique).not.toHaveBeenCalled();
    expect(tx.post.create).toHaveBeenCalledTimes(1);
  });

  it("returns the earlier piece of the same commandId before any cap check", async () => {
    mocks.countInMonth.mockResolvedValue(9);
    tx.creative.findFirst.mockResolvedValue({
      id: "cr-0",
      postId: "post-0",
      scheduledFor: SCHEDULED,
    });
    expect(await placeSeoArticle(input)).toEqual({
      postId: "post-0",
      creativeId: "cr-0",
      scheduledFor: SCHEDULED,
      reused: true,
    });
    expect(mocks.countInMonth).not.toHaveBeenCalled();
    expect(tx.seoContentSetting.findUnique).not.toHaveBeenCalled();
    expect(tx.creative.findFirst).toHaveBeenCalledTimes(1);
  });

  it("retries one serialization failure and then succeeds", async () => {
    mocks.transaction.mockRejectedValueOnce({ code: "P2034" });
    withSlot(null);
    const placed = await placeSeoArticle({ ...input, ideaId: "idea-1" });
    expect(placed.reused).toBe(false);
    expect(mocks.transaction).toHaveBeenCalledTimes(2);
  });

  it("gives up after a second serialization failure", async () => {
    mocks.transaction.mockRejectedValue({ code: "P2034" });
    await expect(placeSeoArticle(input)).rejects.toMatchObject({
      code: "P2034",
    });
    expect(mocks.transaction).toHaveBeenCalledTimes(2);
  });
});

describe("placeSeoArticle consuming a planned slot", () => {
  beforeEach(() => {
    for (const key of PLAN_ENV) savedEnv[key] = process.env[key];
    planOn();
    mocks.primaryLink.mockResolvedValue({ id: "link-1" });
    mocks.countInMonth.mockResolvedValue(1);
    mocks.audit.mockResolvedValue({});
  });
  afterEach(() => {
    for (const key of PLAN_ENV) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("updates the slot's Post and Creative instead of creating new ones", async () => {
    withSlot(SLOT);
    const placed = await placeSeoArticle({ ...input, ideaId: "idea-1" });
    expect(placed).toEqual({
      postId: "post-slot",
      creativeId: "cr-slot",
      scheduledFor: SCHEDULED,
      reused: false,
    });
    expect(tx.post.create).not.toHaveBeenCalled();
    expect(tx.creative.create).not.toHaveBeenCalled();
    expect(tx.creative.findUniqueOrThrow).not.toHaveBeenCalled();

    expect(tx.post.update).toHaveBeenNthCalledWith(1, {
      where: { id: "post-slot" },
      data: {
        topic: ARTICLE.title,
        idea: ARTICLE.metaDescription,
        planId: "cmd1",
        workId: "w1",
        scheduledFor: SCHEDULED,
        timezone: "Europe/Istanbul",
      },
    });
    expect(tx.creative.update).toHaveBeenNthCalledWith(1, {
      where: { id: "cr-slot" },
      data: {
        planId: "cmd1",
        title: ARTICLE.title,
        brief: ARTICLE.metaDescription,
        scheduledFor: SCHEDULED,
        goal: "traffic",
      },
    });
  });

  it("writes version 1 and approves only after the version exists", async () => {
    withSlot(SLOT);
    await placeSeoArticle({ ...input, ideaId: "idea-1" });
    expect(tx.creativeVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        creativeId: "cr-slot",
        version: 1,
        copy: ARTICLE.markdown,
      }),
      select: { id: true },
    });
    expect(tx.creative.update).toHaveBeenNthCalledWith(2, {
      where: { id: "cr-slot" },
      data: { status: "APPROVED", currentVersionId: "v-1" },
    });
    expect(tx.post.update).toHaveBeenNthCalledWith(2, {
      where: { id: "post-slot" },
      data: { approvedAt: expect.any(Date), approvedByUserId: "u1" },
    });
    const approve = tx.creative.update.mock.invocationCallOrder[1]!;
    expect(tx.creativeVersion.create.mock.invocationCallOrder[0]).toBeLessThan(
      approve,
    );
    // Hiçbir yazma APPROVED'ı sürümden önce yapmaz.
    const statusWrites = (
      tx.creative.update.mock.calls as unknown as [
        { data: { status?: string } },
      ][]
    ).filter((call) => call[0].data.status);
    expect(statusWrites).toHaveLength(1);
  });

  it("does not count the slot itself and skips the cap check in the slot's own month", async () => {
    // Sınır sonradan 2'ye düşürüldü, ay 5 parça: slot kendi ayında yine de
    // tüketilir (planlanırken bütçelendi).
    tx.seoContentSetting.findUnique.mockResolvedValue({
      monthlyCap: 2,
      autoPlan: true,
    });
    mocks.countInMonth.mockResolvedValue(5);
    withSlot(SLOT);
    const placed = await placeSeoArticle({ ...input, ideaId: "idea-1" });
    expect(placed.creativeId).toBe("cr-slot");
    expect(mocks.countInMonth).not.toHaveBeenCalled();
  });

  it("refuses a slot moved to another month that is full, excluding the slot from the count", async () => {
    mocks.countInMonth.mockResolvedValue(4);
    withSlot(SLOT);
    await expect(
      placeSeoArticle({
        ...input,
        ideaId: "idea-1",
        when: "2026-11-05T10:00",
      }),
    ).rejects.toBeInstanceOf(SeoMonthlyCapError);
    expect(mocks.countInMonth).toHaveBeenCalledWith(tx, {
      projectId: "p1",
      month: "2026-11",
      timezone: "Europe/Istanbul",
      excludeCreativeId: "cr-slot",
    });
    expect(tx.post.update).not.toHaveBeenCalled();
    expect(tx.creative.update).not.toHaveBeenCalled();
  });

  it("consumes the slot in another month when that month has room", async () => {
    mocks.countInMonth.mockResolvedValue(1);
    withSlot(SLOT);
    const placed = await placeSeoArticle({
      ...input,
      ideaId: "idea-1",
      when: "2026-11-05T10:00",
    });
    expect(placed.creativeId).toBe("cr-slot");
    expect(tx.post.create).not.toHaveBeenCalled();
  });

  it("capExempt still consumes the slot", async () => {
    mocks.countInMonth.mockResolvedValue(9);
    withSlot(SLOT);
    const placed = await placeSeoArticle({
      ...input,
      ideaId: "idea-1",
      when: "2026-11-05T10:00",
      capExempt: true,
    });
    expect(placed.creativeId).toBe("cr-slot");
    expect(mocks.countInMonth).not.toHaveBeenCalled();
  });

  it("ignores a slot row without a post and creates a new piece", async () => {
    withSlot({ ...SLOT, postId: null } as unknown as typeof SLOT);
    await placeSeoArticle({ ...input, ideaId: "idea-1" });
    expect(tx.post.create).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: a second call with the same commandId finds the consumed slot", async () => {
    withSlot(SLOT);
    await placeSeoArticle({ ...input, ideaId: "idea-1" });
    // Tüketimden sonra Creative planId = commandId taşır.
    tx.creative.findFirst.mockReset();
    tx.creative.findFirst.mockResolvedValue({
      id: "cr-slot",
      postId: "post-slot",
      scheduledFor: SCHEDULED,
    });
    tx.post.update.mockClear();
    tx.creativeVersion.create.mockClear();
    expect(await placeSeoArticle({ ...input, ideaId: "idea-1" })).toEqual({
      postId: "post-slot",
      creativeId: "cr-slot",
      scheduledFor: SCHEDULED,
      reused: true,
    });
    expect(tx.post.update).not.toHaveBeenCalled();
    expect(tx.creativeVersion.create).not.toHaveBeenCalled();
  });
});
