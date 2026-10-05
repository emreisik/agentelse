import { beforeEach, describe, expect, it, vi } from "vitest";

const creativeFindMany = vi.fn();
const approvalFindMany = vi.fn();

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    creative: { findMany: (...args: unknown[]) => creativeFindMany(...args) },
    approval: { findMany: (...args: unknown[]) => approvalFindMany(...args) },
  },
}));

import { groupOutputs } from "@/lib/calendar/output-posts";

import { OUTPUTS_LIMIT, loadOutputs } from "./load-outputs";

const NOW = Date.parse("2026-10-04T08:00:00.000Z");

function creative(overrides: Record<string, unknown> = {}) {
  return {
    id: "c1",
    postId: "post-1",
    title: "Autumn launch",
    type: "SOCIAL_POST",
    status: "IN_REVIEW",
    platform: "INSTAGRAM",
    channel: "instagram",
    formatKey: "instagram.post",
    scheduledFor: null,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    versions: [
      {
        version: 1,
        caption: "  New season,   new colours ",
        copy: null,
        contentFormat: null,
        asset: {
          id: "a1",
          mimeType: "image/png",
          storageKey: "creatives/a1.png",
        },
      },
    ],
    ...overrides,
  };
}

type FindManyArgs = { where: Record<string, unknown> };

function whereOf(call: number): Record<string, unknown> {
  return (creativeFindMany.mock.calls[call]?.[0] as FindManyArgs).where;
}

beforeEach(() => {
  vi.clearAllMocks();
  approvalFindMany.mockResolvedValue([]);
});

describe("loadOutputs", () => {
  it("sends every channel with its post and pending approval", async () => {
    creativeFindMany.mockResolvedValueOnce([
      creative({
        id: "c2",
        formatKey: "instagram.story",
        createdAt: new Date(NOW + 1),
      }),
      creative(),
    ]);
    approvalFindMany.mockResolvedValue([
      { id: "ap2", entityId: "c2" },
      { id: "ap1", entityId: "c1" },
    ]);

    const payload = await loadOutputs({ projectId: "p1", timezone: "UTC" });

    // A channel left out of its post is not read at all.
    expect(whereOf(0)).toMatchObject({
      projectId: "p1",
      status: { not: "ARCHIVED" },
      excludedAt: null,
    });
    expect(creativeFindMany).toHaveBeenCalledTimes(1);
    expect(payload.truncated).toBe(false);
    expect(
      payload.items.map((item) => [item.id, item.postId, item.approvalId]),
    ).toEqual([
      ["c2", "post-1", "ap2"],
      ["c1", "post-1", "ap1"],
    ]);
    expect(payload.items[0]).toMatchObject({
      label: "Instagram · Story",
      kind: "story",
      phase: "review",
      preview: "New season, new colours",
      assetId: "a1",
    });
    // The panel makes them one card.
    expect(groupOutputs(payload.items)).toHaveLength(1);
  });

  it("never cuts a post at the limit: its other channels are read too", async () => {
    // Newest first, one post per row; the last row in the window shares its
    // post with the first row past the limit.
    const rows = Array.from({ length: OUTPUTS_LIMIT + 1 }, (_, index) =>
      creative({
        id: `c${index}`,
        postId: index >= OUTPUTS_LIMIT - 1 ? "post-cut" : `post-${index}`,
        createdAt: new Date(NOW - index * 60_000),
      }),
    );
    const boundary = rows[OUTPUTS_LIMIT - 1]!.createdAt;
    const story = rows[OUTPUTS_LIMIT]!;
    const facebook = creative({
      id: "c-fb",
      postId: "post-cut",
      channel: "facebook",
      platform: "FACEBOOK",
      formatKey: "facebook.post",
      createdAt: new Date(NOW - (OUTPUTS_LIMIT + 1) * 60_000),
    });
    creativeFindMany
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce([story, facebook]);

    const payload = await loadOutputs({ projectId: "p1", timezone: "UTC" });

    expect(payload.truncated).toBe(true);
    expect(creativeFindMany).toHaveBeenCalledTimes(2);
    expect(whereOf(1)).toMatchObject({
      projectId: "p1",
      status: { not: "ARCHIVED" },
      excludedAt: null,
      createdAt: { lte: boundary },
      id: { notIn: [`c${OUTPUTS_LIMIT - 1}`] },
    });
    expect((whereOf(1).postId as { in: string[] }).in).toContain("post-cut");

    expect(payload.items).toHaveLength(OUTPUTS_LIMIT + 2);
    const cut = groupOutputs(payload.items).find(
      (entry) => entry.postId === "post-cut",
    );
    expect(cut?.deliveries.map((d) => d.id).sort()).toEqual(
      [`c${OUTPUTS_LIMIT - 1}`, `c${OUTPUTS_LIMIT}`, "c-fb"].sort(),
    );
  });
});
