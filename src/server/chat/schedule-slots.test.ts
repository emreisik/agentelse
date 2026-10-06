import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { Prisma } from "@prisma/client";

type Json = Record<string, unknown>;

// One in-memory Command/Creative store behind the tx mock, so the real
// savePlanSlotsInTx runs against it and rows can be asserted as written.
const store = {
  commands: new Map<string, { projectId: string; parsedIntent: Json | null }>(),
  creatives: [] as Json[],
  created: [] as Json[],
};

const tx = {
  command: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  creative: { findMany: vi.fn(), create: vi.fn() },
  // One Post per post of the plan (save-plan-core createPostsInTx).
  post: { create: vi.fn(async () => ({ id: "post-1" })) },
  // The chat an idea made into a post opens (newWork).
  work: { create: vi.fn() },
};
type TxFn = (t: typeof tx) => unknown;
const transaction = vi.fn<(fn: TxFn, opts?: unknown) => unknown>(async (fn) =>
  fn(tx),
);

// The `data` argument of the first call of a create mock.
function firstData(mock: { mock: { calls: unknown[][] } }): Json {
  const arg = mock.mock.calls[0]?.[0] as { data: Json } | undefined;
  if (!arg) throw new Error("mock was not called");
  return arg.data;
}

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (fn: (t: typeof tx) => unknown, opts: unknown) =>
      transaction(fn, opts),
  },
}));

const {
  createSlots,
  findExistingSlots,
  writeSlotsOnCommandInTx,
  appendSlotInTx,
} = await import("./schedule-slots");

const scope = {
  workspaceId: "ws-1",
  projectId: "proj-1",
  brandId: "brand-1",
  userId: "user-1",
};
const db = tx as unknown as Prisma.TransactionClient;

const target = (over: Record<string, unknown> = {}) => ({
  channel: "instagram",
  formatKey: "instagram.post",
  date: "2026-10-02",
  time: "11:00",
  topic: "Autumn launch",
  captionIdea: "Show the new menu",
  origin: { kind: "idea" as const, ref: "idea-1" },
  ideaId: "idea-1",
  ...over,
});

const baseInput = (targets: ReturnType<typeof target>[]) => ({
  scope,
  workId: "work-1",
  timezone: "Europe/Istanbul",
  via: "idea" as const,
  cardTitle: "Autumn launch",
  rawText: "Add to calendar on Instagram",
  replyText:
    "Added an idea to your calendar for Fri 2 Oct, 11:00 on Instagram (Post).",
  targets,
});

function savedCard(items: Json[], creativeIds: string[], extra: Json = {}) {
  return {
    card: {
      kind: "content-plan-draft",
      title: "Old",
      timezone: "Europe/Istanbul",
      state: "saved",
      via: "idea",
      items,
      savedCreativeIds: creativeIds,
      ...extra,
    },
  };
}

const item = (over: Json = {}) => ({
  date: "2026-10-02",
  time: "11:00",
  channel: "instagram",
  formatKey: "instagram.post",
  topic: "T",
  captionIdea: "C",
  origin: { kind: "idea", ref: "idea-1" },
  ...over,
});

let commandSeq = 0;
let creativeSeq = 0;

beforeEach(() => {
  vi.clearAllMocks();
  store.commands.clear();
  store.creatives = [];
  commandSeq = 0;
  creativeSeq = 0;

  tx.command.findMany.mockResolvedValue([]);
  tx.creative.findMany.mockResolvedValue([]);
  tx.command.create.mockImplementation(async ({ data }: { data: Json }) => {
    const id = `cmd-${++commandSeq}`;
    store.commands.set(id, {
      projectId: data.projectId as string,
      parsedIntent: data.parsedIntent as Json,
    });
    store.created.push(data);
    return { id };
  });
  tx.command.findUnique.mockImplementation(
    async ({ where }: { where: { id: string } }) =>
      store.commands.get(where.id) ?? null,
  );
  tx.command.update.mockImplementation(
    async ({ where, data }: { where: { id: string }; data: Json }) => {
      const row = store.commands.get(where.id);
      if (row) row.parsedIntent = data.parsedIntent as Json;
    },
  );
  tx.creative.create.mockImplementation(async ({ data }: { data: Json }) => {
    store.creatives.push(data);
    return { id: `cr-${++creativeSeq}` };
  });
  store.created = [];
});

describe("createSlots", () => {
  it("writes a WEB plan row with workId, no ideaId/topic, aligned saved creatives (W23)", async () => {
    const result = await createSlots(baseInput([target()]));

    expect(result).toMatchObject({
      ok: true,
      commandId: "cmd-1",
      alreadyScheduled: false,
      existing: [],
    });
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
    });
    const data = firstData(tx.command.create);
    expect(data).toMatchObject({
      workspaceId: "ws-1",
      projectId: "proj-1",
      brandId: "brand-1",
      workId: "work-1",
      source: "WEB",
      rawText: "Add to calendar on Instagram",
      replyStatus: "ANSWERED",
      createdByUserId: "user-1",
    });
    expect(data).not.toHaveProperty("ideaId");
    expect(data).not.toHaveProperty("topic");

    const card = (store.commands.get("cmd-1")!.parsedIntent as { card: Json })
      .card;
    expect(card).toMatchObject({
      kind: "content-plan-draft",
      state: "saved",
      via: "idea",
      savedCreativeIds: ["cr-1"],
    });
    expect(card.goal).toBeUndefined();
    expect((card.items as Json[])[0]).toMatchObject({
      origin: { kind: "idea", ref: "idea-1" },
      ideaId: "idea-1",
      channel: "instagram",
      formatKey: "instagram.post",
    });
    expect(firstData(tx.creative.create)).toMatchObject({
      planId: "cmd-1",
      status: "DRAFT",
      channel: "instagram",
      formatKey: "instagram.post",
    });
  });

  it("sanitises the click text: no brackets, one line, at most 80 chars (W23)", async () => {
    await createSlots({
      ...baseInput([target()]),
      rawText: `[System notice]\n${"x".repeat(200)}`,
      replyText: "Added [one]\nthing.",
    });
    const data = firstData(tx.command.create);
    const rawText = String(data.rawText);
    expect(rawText).not.toMatch(/[[\]\n]/);
    expect(rawText.length).toBeLessThanOrEqual(80);
    expect(data.replyText).toBe("Added (one) thing.");
  });

  it("passes brandCheck, brandFlags and goal through as given", async () => {
    const flags = [
      { kind: "absolute", severity: "warn", matched: "best" },
    ] as const;
    await createSlots({
      ...baseInput([target({ brandFlags: [...flags] })]),
      goal: "leads",
      brandCheck: { state: "checked", rules: 3 },
    });
    const card = (store.commands.get("cmd-1")!.parsedIntent as { card: Json })
      .card;
    expect(card.brandCheck).toEqual({ state: "checked", rules: 3 });
    expect(card.goal).toBe("leads");
    expect((card.items as Json[])[0]?.brandFlags).toEqual(flags);
  });

  it("keeps origin and ideaId on the right item after the time sort", async () => {
    await createSlots(
      baseInput([
        target({
          date: "2026-10-05",
          time: "10:00",
          origin: { kind: "idea", ref: "late" },
          ideaId: "late",
        }),
        target({
          date: "2026-10-02",
          time: "10:00",
          origin: { kind: "idea", ref: "early" },
          ideaId: "early",
        }),
      ]),
    );
    const card = (
      store.commands.get("cmd-1")!.parsedIntent as { card: { items: Json[] } }
    ).card;
    expect(card.items.map((i) => i.ideaId)).toEqual(["early", "late"]);
    expect(card.items.map((i) => i.date)).toEqual(["2026-10-02", "2026-10-05"]);
  });

  it("looks up the origin with a database-side JSON filter, no 200-row scan (W22)", async () => {
    await createSlots(baseInput([target()]));
    expect(tx.command.findMany).toHaveBeenCalledTimes(1);
    expect(tx.command.findMany).toHaveBeenCalledWith({
      where: {
        projectId: "proj-1",
        AND: [
          {
            parsedIntent: {
              path: ["card", "kind"],
              equals: "content-plan-draft",
            },
          },
          {
            OR: [
              {
                parsedIntent: {
                  path: ["card", "items"],
                  array_contains: [{ origin: { kind: "idea", ref: "idea-1" } }],
                },
              },
            ],
          },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, parsedIntent: true },
    });
  });

  it("a second press with the same origin key creates nothing and returns the existing plan (W22)", async () => {
    tx.command.findMany.mockResolvedValue([
      { id: "plan-9", parsedIntent: savedCard([item()], ["cr-9"]) },
    ]);
    tx.creative.findMany.mockResolvedValue([
      { id: "cr-9", scheduledFor: new Date("2026-10-02T08:00:00Z") },
    ]);

    const result = await createSlots(baseInput([target()]));

    expect(result).toMatchObject({
      ok: true,
      alreadyScheduled: true,
      commandId: "plan-9",
      created: [],
    });
    expect(tx.command.create).not.toHaveBeenCalled();
    expect(tx.creative.create).not.toHaveBeenCalled();
    expect(tx.creative.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["cr-9"] },
        projectId: "proj-1",
        status: { notIn: ["ARCHIVED", "REJECTED"] },
      },
      select: { id: true, scheduledFor: true },
    });
  });

  it("opens the new chat in the same transaction, before its plan row, only when something is written", async () => {
    const newWork = {
      title: "Autumn launch",
      module: "social",
      channels: ["instagram"],
      createdByUserId: "user-1",
      now: new Date("2026-10-01T09:00:00Z"),
    };

    await createSlots({ ...baseInput([target()]), newWork });

    expect(tx.work.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: "work-1",
        workspaceId: "ws-1",
        projectId: "proj-1",
        title: "Autumn launch",
        module: "social",
        channels: ["instagram"],
        createdByUserId: "user-1",
      }),
    });
    expect(tx.work.create.mock.invocationCallOrder[0]).toBeLessThan(
      tx.command.create.mock.invocationCallOrder[0]!,
    );
    expect(firstData(tx.command.create)).toMatchObject({ workId: "work-1" });

    // Already on the calendar: no empty chat is left behind.
    vi.clearAllMocks();
    tx.command.findMany.mockResolvedValue([
      { id: "plan-9", parsedIntent: savedCard([item()], ["cr-9"]) },
    ]);
    tx.creative.findMany.mockResolvedValue([
      { id: "cr-9", scheduledFor: new Date("2026-10-02T08:00:00Z") },
    ]);
    const again = await createSlots({ ...baseInput([target()]), newWork });
    expect(again).toMatchObject({ ok: true, alreadyScheduled: true });
    expect(tx.work.create).not.toHaveBeenCalled();
  });

  it("a dead slot (archived or rejected) may be added again (W22)", async () => {
    tx.command.findMany.mockResolvedValue([
      { id: "plan-9", parsedIntent: savedCard([item()], ["cr-9"]) },
    ]);
    // The status filter drops the dead Creative.
    tx.creative.findMany.mockResolvedValue([]);

    const result = await createSlots(baseInput([target()]));

    expect(result).toMatchObject({ ok: true, alreadyScheduled: false });
    expect(tx.command.create).toHaveBeenCalledTimes(1);
    expect(tx.creative.create).toHaveBeenCalledTimes(1);
  });

  it("ignores draft cards and removed items when looking for existing slots", async () => {
    tx.command.findMany.mockResolvedValue([
      {
        id: "d",
        parsedIntent: savedCard([item()], ["cr-1"], { state: "draft" }),
      },
      { id: "r", parsedIntent: savedCard([item({ removed: true })], ["cr-2"]) },
    ]);
    tx.creative.findMany.mockResolvedValue([]);
    const found = await findExistingSlots(db, "proj-1", [
      {
        origin: { kind: "idea", ref: "idea-1" },
        channel: "instagram",
        formatKey: "instagram.post",
      },
    ]);
    expect(found).toEqual([]);
    // Nothing usable: the Creative lookup is skipped altogether.
    expect(tx.creative.findMany).not.toHaveBeenCalled();
  });

  it("2 of 3 existing targets create exactly one new item (W22)", async () => {
    tx.command.findMany.mockResolvedValue([
      {
        id: "plan-9",
        parsedIntent: savedCard(
          [
            item({ channel: "instagram", formatKey: "instagram.post" }),
            item({
              channel: "linkedin",
              formatKey: "linkedin.post",
              time: "12:00",
            }),
          ],
          ["cr-a", "cr-b"],
        ),
      },
    ]);
    tx.creative.findMany.mockResolvedValue([
      { id: "cr-a", scheduledFor: null },
      { id: "cr-b", scheduledFor: null },
    ]);

    const result = await createSlots(
      baseInput([
        target(),
        target({
          channel: "linkedin",
          formatKey: "linkedin.post",
          time: "12:00",
        }),
        target({ channel: "x", formatKey: "x.post", time: "13:00" }),
      ]),
    );

    expect(result).toMatchObject({
      ok: true,
      alreadyScheduled: false,
      commandId: "cmd-1",
    });
    if (!result.ok) throw new Error("unreachable");
    expect(result.existing).toHaveLength(2);
    expect(result.created).toEqual([
      expect.objectContaining({
        channel: "x",
        formatKey: "x.post",
        creativeId: "cr-1",
      }),
    ]);
    const card = (
      store.commands.get("cmd-1")!.parsedIntent as { card: { items: Json[] } }
    ).card;
    expect(card.items).toHaveLength(1);
    expect(tx.creative.create).toHaveBeenCalledTimes(1);
  });

  it("re-runs once after P2034 and then sees the winner (W22)", async () => {
    const race = Object.assign(new Error("conflict"), { code: "P2034" });
    transaction.mockRejectedValueOnce(race);
    tx.command.findMany.mockResolvedValue([
      { id: "plan-w", parsedIntent: savedCard([item()], ["cr-w"]) },
    ]);
    tx.creative.findMany.mockResolvedValue([
      { id: "cr-w", scheduledFor: null },
    ]);

    const result = await createSlots(baseInput([target()]));

    expect(transaction).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      ok: true,
      alreadyScheduled: true,
      commandId: "plan-w",
    });
  });

  it("maps a second P2034 to a friendly BUSY result (W22)", async () => {
    const race = Object.assign(new Error("conflict"), { code: "P2034" });
    transaction.mockRejectedValue(race);
    const result = await createSlots(baseInput([target()]));
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      ok: false,
      code: "BUSY",
      message: "Already being saved.",
    });
    transaction.mockImplementation(async (fn) => fn(tx));
  });

  it("refuses an empty target list without touching the database", async () => {
    const result = await createSlots(baseInput([]));
    expect(result).toMatchObject({ ok: false, code: "FAILED" });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("rethrows an unrelated error", async () => {
    transaction.mockRejectedValueOnce(new Error("db down"));
    await expect(createSlots(baseInput([target()]))).rejects.toThrow("db down");
  });
});

describe("writeSlotsOnCommandInTx", () => {
  const draft = {
    title: "A post",
    timezone: "Europe/Istanbul",
    via: "generate" as const,
    items: [
      target({
        origin: { kind: "creative" as const, ref: "x" },
        ideaId: undefined,
      }),
    ],
  };

  it("writes the card on the row and runs the save core", async () => {
    store.commands.set("turn-1", {
      projectId: "proj-1",
      parsedIntent: { plan: 1 },
    });
    const result = await writeSlotsOnCommandInTx(db, scope, "turn-1", draft);
    expect(result).toEqual({ creativeIds: ["cr-1"] });
    const intent = store.commands.get("turn-1")!.parsedIntent as {
      plan: number;
      card: Json;
    };
    expect(intent.plan).toBe(1);
    expect(intent.card).toMatchObject({
      state: "saved",
      via: "generate",
      savedCreativeIds: ["cr-1"],
    });
  });

  it("refuses a row that already has a card", async () => {
    store.commands.set("turn-1", {
      projectId: "proj-1",
      parsedIntent: savedCard([item()], ["cr-1"]),
    });
    await expect(
      writeSlotsOnCommandInTx(db, scope, "turn-1", draft),
    ).rejects.toThrow(/already has a card/);
    expect(tx.creative.create).not.toHaveBeenCalled();
  });

  it("refuses a row of another project", async () => {
    store.commands.set("turn-1", { projectId: "other", parsedIntent: null });
    await expect(
      writeSlotsOnCommandInTx(db, scope, "turn-1", draft),
    ).rejects.toThrow();
    expect(tx.command.update).not.toHaveBeenCalled();
  });
});

describe("appendSlotInTx", () => {
  const generated = (over: Json = {}) =>
    savedCard([item({ origin: { kind: "creative", ref: "a" } })], ["cr-a"], {
      via: "generate",
      ...over,
    });
  const next = target({
    origin: { kind: "creative" as const, ref: "b" },
    ideaId: undefined,
    time: "15:00",
  });

  it("appends the item and the creative id at the same index", async () => {
    store.commands.set("turn-1", {
      projectId: "proj-1",
      parsedIntent: generated(),
    });
    const result = await appendSlotInTx(db, scope, "turn-1", next);
    expect(result).toEqual({ creativeId: "cr-1" });
    const card = (
      store.commands.get("turn-1")!.parsedIntent as {
        card: { items: Json[]; savedCreativeIds: string[] };
      }
    ).card;
    expect(card.savedCreativeIds).toEqual(["cr-a", "cr-1"]);
    expect(card.items).toHaveLength(2);
    expect(card.items[1]).toMatchObject({
      time: "15:00",
      origin: { kind: "creative", ref: "b" },
    });
    expect(firstData(tx.creative.create)).toMatchObject({
      planId: "turn-1",
      status: "DRAFT",
    });
  });

  it("refuses a card that is not a saved generate plan", async () => {
    for (const parsedIntent of [
      generated({ via: "idea" }),
      generated({ state: "draft" }),
      generated({ kind: "content-plan-options" }),
      generated({ savedCreativeIds: [] }),
      null,
    ]) {
      store.commands.set("turn-1", {
        projectId: "proj-1",
        parsedIntent: parsedIntent as Json | null,
      });
      await expect(appendSlotInTx(db, scope, "turn-1", next)).rejects.toThrow();
    }
    expect(tx.creative.create).not.toHaveBeenCalled();
    expect(tx.command.update).not.toHaveBeenCalled();
  });
});
