import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = {
  parsedIntent: { card: Record<string, unknown>; other?: string };
  projectId: string;
  workId: string | null;
  replyText: string;
};

const mocks = vi.hoisted(() => ({
  rows: new Map<string, unknown>(),
  workStatus: { value: "ACTIVE" as string | null },
  isWorksEnabled: vi.fn(),
  isRateLimited: vi.fn(),
  requireUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  revalidate: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@/lib/rate-limit", () => ({ isRateLimited: mocks.isRateLimited }));
vi.mock("@/server/works/flag", () => ({
  isWorksEnabled: mocks.isWorksEnabled,
}));
vi.mock("@/server/security/tenant-context", () => ({
  requireUser: mocks.requireUser,
  requireProjectAccess: mocks.requireProjectAccess,
}));

// The real card writer (card-store.ts) runs on these rows.
vi.mock("@/lib/prisma", () => {
  const tx = {
    command: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        mocks.rows.get(where.id) ?? null,
      update: async (args: {
        where: { id: string };
        data: { parsedIntent: Row["parsedIntent"] };
      }) => {
        const row = mocks.rows.get(args.where.id) as Row;
        row.parsedIntent = args.data.parsedIntent;
        return row;
      },
    },
    work: {
      findFirst: async () =>
        mocks.workStatus.value ? { status: mocks.workStatus.value } : null,
    },
  };
  return {
    prisma: {
      command: {
        findUnique: async ({ where }: { where: { id: string } }) => {
          const row = mocks.rows.get(where.id) as Row | undefined;
          return row ? { projectId: row.projectId } : null;
        },
      },
      $transaction: async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
    },
  };
});

import { setPlanPostSkipAction } from "@/server/actions/plan-draft-actions";

function item(over: Record<string, unknown> = {}) {
  return {
    date: "2026-10-05",
    time: "12:00",
    channel: "instagram",
    formatKey: "instagram.post",
    topic: "Launch day",
    captionIdea: "Show the product in use.",
    ...over,
  };
}

// Instagram + Facebook with the Story switch on: three deliveries per post.
function draftCard(over: Record<string, unknown> = {}) {
  return {
    kind: "content-plan-draft",
    title: "Launch week",
    timezone: "Europe/Istanbul",
    state: "draft",
    platforms: ["instagram", "facebook"],
    instagramStory: true,
    items: [item(), item({ date: "2026-10-07", topic: "Second post" })],
    ...over,
  };
}

function setRow(card: Record<string, unknown>) {
  mocks.rows.set("cmd1", {
    parsedIntent: { card, other: "keep" },
    projectId: "p1",
    workId: "wk1",
    replyText: "Here is the plan.",
  });
}

function stored(): { items: Record<string, unknown>[] } {
  return (mocks.rows.get("cmd1") as Row).parsedIntent.card as {
    items: Record<string, unknown>[];
  };
}

beforeEach(() => {
  mocks.rows.clear();
  mocks.workStatus.value = "ACTIVE";
  mocks.isWorksEnabled.mockReset().mockReturnValue(true);
  mocks.isRateLimited.mockReset().mockReturnValue(false);
  mocks.requireUser.mockReset().mockResolvedValue({ userId: "u1" });
  mocks.requireProjectAccess
    .mockReset()
    .mockResolvedValue({ workspaceId: "ws1", defaultBrandId: "b1" });
  mocks.revalidate.mockReset();
});

describe("setPlanPostSkipAction: one channel of one draft post", () => {
  it("leaves the channel out of that post only, and keeps the rest of the card", async () => {
    setRow(draftCard());

    const result = await setPlanPostSkipAction(
      "cmd1",
      [0],
      "Launch day",
      "facebook.post",
      true,
    );

    expect(result).toEqual({ ok: true });
    expect(stored().items[0]?.skipFormats).toEqual(["facebook.post"]);
    expect(stored().items[1]).not.toHaveProperty("skipFormats");
    const row = mocks.rows.get("cmd1") as Row;
    expect(row.parsedIntent.other).toBe("keep");
    expect(row.parsedIntent.card).toMatchObject({
      state: "draft",
      platforms: ["instagram", "facebook"],
      instagramStory: true,
    });
    expect(mocks.revalidate).toHaveBeenCalledWith("/projects/p1");
  });

  it("takes it back in: the list goes once it is empty", async () => {
    setRow(
      draftCard({
        items: [
          item({ skipFormats: ["facebook.post"] }),
          item({ date: "2026-10-07", topic: "Second post" }),
        ],
      }),
    );

    const result = await setPlanPostSkipAction(
      "cmd1",
      [0],
      "Launch day",
      "facebook.post",
      false,
    );

    expect(result).toEqual({ ok: true });
    expect(stored().items[0]).not.toHaveProperty("skipFormats");
  });

  it("every item of the post carries the same list", async () => {
    // A plan whose items name their channels: one post, two items.
    setRow(
      draftCard({
        platforms: undefined,
        instagramStory: undefined,
        items: [
          item(),
          item({ channel: "linkedin", formatKey: "linkedin.post" }),
        ],
      }),
    );

    const result = await setPlanPostSkipAction(
      "cmd1",
      [0, 1],
      "Launch day",
      "linkedin.post",
      true,
    );

    expect(result).toEqual({ ok: true });
    expect(stored().items.map((entry) => entry.skipFormats)).toEqual([
      ["linkedin.post"],
      ["linkedin.post"],
    ]);
  });

  it("a post keeps at least one channel", async () => {
    setRow(
      draftCard({
        items: [item({ skipFormats: ["instagram.story", "facebook.post"] })],
      }),
    );
    const before = JSON.stringify(stored());

    const result = await setPlanPostSkipAction(
      "cmd1",
      [0],
      "Launch day",
      "instagram.post",
      true,
    );

    expect(result).toEqual({
      ok: false,
      code: "RANGE",
      message: "A post keeps at least one channel.",
    });
    expect(JSON.stringify(stored())).toBe(before);
  });

  it("refuses a format the post is not made in, or one outside the catalog", async () => {
    setRow(draftCard());
    for (const formatKey of ["linkedin.post", "instagram.nope", ""]) {
      expect(
        await setPlanPostSkipAction("cmd1", [0], "Launch day", formatKey, true),
        formatKey,
      ).toMatchObject({ ok: false, code: "RANGE" });
    }
    expect(stored().items[0]).not.toHaveProperty("skipFormats");
  });

  it("a post that changed since the screen showed it is STALE", async () => {
    setRow(draftCard());
    expect(
      await setPlanPostSkipAction(
        "cmd1",
        [0],
        "Another idea",
        "facebook.post",
        true,
      ),
    ).toMatchObject({ ok: false, code: "STALE" });
    // Bad positions are refused before anything is read.
    for (const indices of [[], [0, 0], [-1], [1.5]]) {
      expect(
        await setPlanPostSkipAction(
          "cmd1",
          indices,
          "Launch day",
          "facebook.post",
          true,
        ),
        JSON.stringify(indices),
      ).toMatchObject({ ok: false, code: "RANGE" });
    }
  });

  it("a saved plan is LOCKED: its channels are left out on the made post instead", async () => {
    setRow(draftCard({ state: "saved" }));
    expect(
      await setPlanPostSkipAction(
        "cmd1",
        [0],
        "Launch day",
        "facebook.post",
        true,
      ),
    ).toMatchObject({ ok: false, code: "LOCKED" });
    expect(stored().items[0]).not.toHaveProperty("skipFormats");
  });

  it("a completed Work changes nothing", async () => {
    setRow(draftCard());
    mocks.workStatus.value = "COMPLETED";
    expect(
      await setPlanPostSkipAction(
        "cmd1",
        [0],
        "Launch day",
        "facebook.post",
        true,
      ),
    ).toMatchObject({ ok: false, code: "WORK" });
    expect(stored().items[0]).not.toHaveProperty("skipFormats");
  });

  it("Works off, or a plan that is not there, changes nothing", async () => {
    setRow(draftCard());
    mocks.isWorksEnabled.mockReturnValue(false);
    expect(
      await setPlanPostSkipAction(
        "cmd1",
        [0],
        "Launch day",
        "facebook.post",
        true,
      ),
    ).toMatchObject({ ok: false, code: "DISABLED" });
    mocks.isWorksEnabled.mockReturnValue(true);
    expect(
      await setPlanPostSkipAction(
        "missing",
        [0],
        "Launch day",
        "facebook.post",
        true,
      ),
    ).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });
});
