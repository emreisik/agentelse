import { beforeEach, describe, expect, it, vi } from "vitest";

// placeSeoArticle over the REAL post writer (save-plan-core createPostsInTx):
// the transaction client is an in-memory stand-in, so what reaches each table
// is what production would write.

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  creativeFindFirst: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    creative: { findFirst: mocks.creativeFindFirst },
  },
}));

import { placeSeoArticle, seoPieceStatus } from "./calendar";

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
  tx.creative.findFirst.mockResolvedValue(null);
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
