import { beforeEach, describe, expect, it, vi } from "vitest";

// DB-less: a tiny in-memory stand-in for the two delegates the repository uses.
type Row = Record<string, unknown> & { id: string; projectId: string };
const store = vi.hoisted(() => ({
  works: [] as Row[],
  commands: [] as Row[],
  creatives: [] as Row[],
  creativeQueries: 0,
  txOptions: [] as unknown[],
  raceOnce: false,
}));

function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === "AND") {
      return (value as Record<string, unknown>[]).every((part) => matches(row, part));
    }
    if (key === "NOT") {
      const parts = (Array.isArray(value) ? value : [value]) as Record<string, unknown>[];
      return parts.every((part) => !matches(row, part));
    }
    if (key === "commands") {
      const has = store.commands.some((c) => c.workId === row.id);
      return (value as { none?: object }).none ? !has : has;
    }
    if (key === "id" && value && typeof value === "object") {
      const { startsWith, lt, not } = value as {
        startsWith?: string;
        lt?: string;
        not?: string;
      };
      return (
        (startsWith === undefined || row.id.startsWith(startsWith)) &&
        (lt === undefined || row.id < lt) &&
        (not === undefined || row.id !== not)
      );
    }
    if (key === "status" && value && typeof value === "object") {
      return row.status !== (value as { not: unknown }).not;
    }
    if (value && typeof value === "object" && "equals" in value) {
      // A Json column compared with a value.
      return (
        JSON.stringify(row[key]) ===
        JSON.stringify((value as { equals: unknown }).equals)
      );
    }
    if (value && typeof value === "object" && "in" in value) {
      return (value as { in: unknown[] }).in.includes(row[key]);
    }
    return row[key] === value;
  });
}

// The real helper lives in a module with heavy imports; same duck-typing.
vi.mock("@/server/guided-setup/store", () => ({
  isUniqueViolation: (e: unknown) => (e as { code?: unknown })?.code === "P2002",
}));

vi.mock("@/lib/prisma", () => {
  const work = {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      if (store.works.some((r) => r.id === data.id)) {
        throw Object.assign(new Error("unique"), { code: "P2002" });
      }
      if (store.raceOnce && typeof data.id === "string") {
        // Another tab wins between our read and our insert.
        store.raceOnce = false;
        store.works.push({ ...data, summary: null, status: "ACTIVE", lastActivityAt: new Date("2026-10-01T10:00:00Z") } as unknown as Row);
        throw Object.assign(new Error("unique"), { code: "P2002" });
      }
      const row = {
        id: `w${store.works.length + 1}`,
        summary: null,
        status: "ACTIVE",
        lastActivityAt: new Date("2026-10-01T10:00:00Z"),
        ...data,
      } as unknown as Row;
      store.works.push(row);
      return row;
    },
    findFirst: async ({ where }: { where: Record<string, unknown> }) =>
      store.works.find((r) => matches(r, where)) ?? null,
    findMany: async ({ where }: { where: Record<string, unknown> }) =>
      store.works.filter((r) => matches(r, where)),
    count: async ({ where }: { where: Record<string, unknown> }) =>
      store.works.filter((r) => matches(r, where)).length,
    updateMany: async ({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      const rows = store.works.filter((r) => matches(r, where));
      rows.forEach((r) => Object.assign(r, data));
      return { count: rows.length };
    },
    deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
      const before = store.works.length;
      store.works = store.works.filter((r) => !matches(r, where));
      return { count: before - store.works.length };
    },
  };
  const command = {
    findMany: async ({ where }: { where: Record<string, unknown> }) =>
      store.commands.filter(
        (r) =>
          r.projectId === where.projectId &&
          r.workId === where.workId &&
          r.kind === "content-plan-draft",
      ),
    deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
      const before = store.commands.length;
      store.commands = store.commands.filter((r) => !matches(r, where));
      return { count: before - store.commands.length };
    },
  };
  const creative = {
    count: async ({
      where,
    }: {
      where: {
        projectId: string;
        planId: { in: string[] };
        status: { notIn: string[] };
      };
    }) => {
      store.creativeQueries += 1;
      return store.creatives.filter(
        (r) =>
          r.projectId === where.projectId &&
          where.planId.in.includes(r.planId as string) &&
          !where.status.notIn.includes(r.status as string),
      ).length;
    },
  };
  const transaction = async (
    arg: Promise<unknown>[] | ((tx: unknown) => Promise<unknown>),
    options?: { isolationLevel?: string },
  ) => {
    store.txOptions.push(options);
    // createOrReuseBlank takes an advisory lock first: one caller at a time here.
    const $executeRaw = async () => 1;
    return typeof arg === "function"
      ? arg({ work, command, creative, $executeRaw })
      : Promise.all(arg);
  };
  return {
    prisma: { work, command, creative, $transaction: transaction },
  };
});

const { WorkRepository } = await import("./work.repository");

beforeEach(() => {
  store.works = [];
  store.commands = [];
  store.creatives = [];
  store.creativeQueries = 0;
  store.txOptions = [];
  store.raceOnce = false;
});

describe("WorkRepository", () => {
  it("creates with a default title and parses stored channels", async () => {
    const work = await WorkRepository.create({
      workspaceId: "ws",
      projectId: "p1",
      channels: ["instagram"],
    });
    expect(work.title).toBe("New Chat");
    expect(work.channels).toEqual(["instagram"]);
    expect(work.status).toBe("ACTIVE");
  });

  it("never reads or writes another project's Work", async () => {
    const work = await WorkRepository.create({ workspaceId: "ws", projectId: "p1" });
    expect(await WorkRepository.get("p2", work.id)).toBeNull();
    expect(await WorkRepository.rename("p2", work.id, "x")).toBe(false);
    expect(await WorkRepository.setStatus("p2", work.id, "DONE")).toBe(false);
    expect(await WorkRepository.remove("p2", work.id)).toBe(false);
    expect((await WorkRepository.get("p1", work.id))?.title).toBe("New Chat");
  });

  it("an untitled Work from before the rename reads as New Chat, a real title as stored", async () => {
    const legacy = await WorkRepository.create({ workspaceId: "ws", projectId: "p1", title: "New Work" });
    const named = await WorkRepository.create({ workspaceId: "ws", projectId: "p1", title: "Autumn push" });
    expect((await WorkRepository.get("p1", legacy.id))?.title).toBe("New Chat");
    expect((await WorkRepository.get("p1", named.id))?.title).toBe("Autumn push");
    // Only the screen reads it differently: the stored row is left as it was.
    expect(store.works.find((r) => r.id === legacy.id)?.title).toBe("New Work");
  });

  it("lists recent works without the archived ones", async () => {
    const a = await WorkRepository.create({ workspaceId: "ws", projectId: "p1", title: "A" });
    await WorkRepository.create({ workspaceId: "ws", projectId: "p1", title: "B" });
    await WorkRepository.setStatus("p1", a.id, "ARCHIVED");
    const list = await WorkRepository.listRecent("p1");
    expect(list.map((w) => w.title)).toEqual(["B"]);
  });

  it("recents: a chat joins with its first message; the blank one is not listed", async () => {
    const blank = await WorkRepository.create({ workspaceId: "ws", projectId: "p1" });
    const legacyBlank = await WorkRepository.create({ workspaceId: "ws", projectId: "p1", title: "New Work" });
    expect(await WorkRepository.recents("p1")).toEqual([]);
    store.commands.push({ id: "c1", projectId: "p1", workId: blank.id });
    expect((await WorkRepository.recents("p1")).map((w) => w.id)).toEqual([blank.id]);
    expect((await WorkRepository.recents("p1")).map((w) => w.id)).not.toContain(legacyBlank.id);
  });

  it("recents lists an empty chat the person renamed or completed (they kept it on purpose)", async () => {
    const renamed = await WorkRepository.create({ workspaceId: "ws", projectId: "p1", title: "Ideas for May" });
    const done = await WorkRepository.create({ workspaceId: "ws", projectId: "p1" });
    await WorkRepository.setStatus("p1", done.id, "DONE");
    const archived = await WorkRepository.create({ workspaceId: "ws", projectId: "p1", title: "Old" });
    await WorkRepository.setStatus("p1", archived.id, "ARCHIVED");
    expect((await WorkRepository.recents("p1")).map((w) => w.id).sort()).toEqual([renamed.id, done.id].sort());
  });

  it("isUntouched: only an ACTIVE, untitled Work with no chat row of this project, never Today", async () => {
    const blank = await WorkRepository.create({ workspaceId: "ws", projectId: "p1" });
    const legacy = await WorkRepository.create({ workspaceId: "ws", projectId: "p1", title: "New Work" });
    const renamed = await WorkRepository.create({ workspaceId: "ws", projectId: "p1", title: "Ideas" });
    const done = await WorkRepository.create({ workspaceId: "ws", projectId: "p1" });
    await WorkRepository.setStatus("p1", done.id, "DONE");
    expect(await WorkRepository.isUntouched("p1", blank.id)).toBe(true);
    expect(await WorkRepository.isUntouched("p1", legacy.id)).toBe(true);
    expect(await WorkRepository.isUntouched("p1", renamed.id)).toBe(false);
    expect(await WorkRepository.isUntouched("p1", done.id)).toBe(false);
    expect(await WorkRepository.isUntouched("p2", blank.id)).toBe(false);
    expect(await WorkRepository.isUntouched("p1", "missing")).toBe(false);
    store.commands.push({ id: "c1", projectId: "p1", workId: blank.id });
    expect(await WorkRepository.isUntouched("p1", blank.id)).toBe(false);
  });

  it("touch sets the title only while it is still the default", async () => {
    const work = await WorkRepository.create({ workspaceId: "ws", projectId: "p1" });
    await WorkRepository.touch("p1", work.id, {
      titleIfDefault: "Weekly plan",
      summary: "first",
    });
    await WorkRepository.touch("p1", work.id, {
      titleIfDefault: "Other",
      summary: "second",
    });
    const got = await WorkRepository.get("p1", work.id);
    expect(got?.title).toBe("Weekly plan");
    expect(got?.summary).toBe("second");
  });

  it("touch also titles an untitled Work from before the rename", async () => {
    const work = await WorkRepository.create({ workspaceId: "ws", projectId: "p1", title: "New Work" });
    await WorkRepository.touch("p1", work.id, { titleIfDefault: "Weekly plan" });
    expect((await WorkRepository.get("p1", work.id))?.title).toBe("Weekly plan");
  });

  it("setChannels stores the choice and the acknowledged-unconnected subset", async () => {
    const work = await WorkRepository.create({ workspaceId: "ws", projectId: "p1" });
    await WorkRepository.setChannels("p1", work.id, ["instagram", "x"], ["x"]);
    const got = await WorkRepository.get("p1", work.id);
    expect(got?.channels).toEqual(["instagram", "x"]);
    expect(got?.acknowledgedUnconnected).toEqual(["x"]);
  });

  it("setInitialChannels stores a new chat's channels, once: a stored choice is never overwritten", async () => {
    const blank = await WorkRepository.create({ workspaceId: "ws", projectId: "p1" });
    expect(
      await WorkRepository.setInitialChannels("p1", blank.id, ["instagram", "x"], ["x"]),
    ).toBe(true);
    const got = await WorkRepository.get("p1", blank.id);
    expect(got?.channels).toEqual(["instagram", "x"]);
    expect(got?.acknowledgedUnconnected).toEqual(["x"]);
    // A card or another tab got there first.
    expect(await WorkRepository.setInitialChannels("p1", blank.id, ["linkedin"], [])).toBe(false);
    expect((await WorkRepository.get("p1", blank.id))?.channels).toEqual(["instagram", "x"]);
  });

  it("setInitialChannels gives defaults to an ACTIVE Work that has none, used or not; never to a completed or foreign one", async () => {
    const used = await WorkRepository.create({ workspaceId: "ws", projectId: "p1" });
    store.commands.push({ id: "c1", projectId: "p1", workId: used.id });
    const renamed = await WorkRepository.create({ workspaceId: "ws", projectId: "p1", title: "Ideas" });
    const done = await WorkRepository.create({ workspaceId: "ws", projectId: "p1" });
    await WorkRepository.setStatus("p1", done.id, "DONE");
    const blank = await WorkRepository.create({ workspaceId: "ws", projectId: "p1" });
    // An older chat that never got channels (it asked for one before chats were free) is given them.
    for (const id of [used.id, renamed.id]) {
      expect(await WorkRepository.setInitialChannels("p1", id, ["instagram"], [])).toBe(true);
      expect((await WorkRepository.get("p1", id))?.channels).toEqual(["instagram"]);
    }
    expect(await WorkRepository.setInitialChannels("p1", done.id, ["instagram"], [])).toBe(false);
    expect((await WorkRepository.get("p1", done.id))?.channels).toEqual([]);
    expect(await WorkRepository.setInitialChannels("p2", blank.id, ["instagram"], [])).toBe(false);
    expect(await WorkRepository.setInitialChannels("p1", "missing", ["instagram"], [])).toBe(false);
    expect((await WorkRepository.get("p1", blank.id))?.channels).toEqual([]);
  });

  it("remove deletes the Work and only its own chat rows", async () => {
    const work = await WorkRepository.create({ workspaceId: "ws", projectId: "p1" });
    store.commands.push(
      { id: "c1", projectId: "p1", workId: work.id },
      { id: "c2", projectId: "p1", workId: "other" },
    );
    expect(await WorkRepository.remove("p1", work.id)).toBe(true);
    expect(store.commands.map((c) => c.id)).toEqual(["c2"]);
  });

  it("countLiveSlots is 0 without plans and skips the creative query", async () => {
    expect(await WorkRepository.countLiveSlots("p1", "w1")).toBe(0);
    expect(store.creativeQueries).toBe(0);
  });

  it("countLiveSlots counts only live slots of this Work's plans", async () => {
    store.commands.push(
      { id: "plan1", projectId: "p1", workId: "w1", kind: "content-plan-draft" },
      { id: "plan2", projectId: "p1", workId: "w2", kind: "content-plan-draft" },
      { id: "chat1", projectId: "p1", workId: "w1", kind: "chat" },
    );
    const slot = (id: string, planId: string, status: string) =>
      store.creatives.push({ id, projectId: "p1", planId, status });
    slot("a", "plan1", "DRAFT");
    slot("b", "plan1", "IN_REVIEW");
    slot("c", "plan1", "APPROVED");
    slot("d", "plan1", "ARCHIVED");
    slot("e", "plan1", "REJECTED");
    slot("f", "plan1", "PUBLISHED");
    slot("g", "plan2", "DRAFT");
    slot("h", "chat1", "DRAFT");
    expect(await WorkRepository.countLiveSlots("p1", "w1")).toBe(3);
  });

  describe("removeUnlessLive", () => {
    const plan = { id: "plan1", projectId: "p1", workId: "w1", kind: "content-plan-draft" };

    it("refuses with LIVE while a live slot exists and deletes nothing", async () => {
      const work = await WorkRepository.create({ workspaceId: "ws", projectId: "p1" });
      store.commands.push({ ...plan, workId: work.id });
      store.creatives.push({ id: "a", projectId: "p1", planId: "plan1", status: "DRAFT" });
      expect(await WorkRepository.removeUnlessLive("p1", work.id)).toBe("LIVE");
      expect(store.commands).toHaveLength(1);
      expect(store.works).toHaveLength(1);
    });

    it("deletes the Work and its chat rows when no slot is live, in one Serializable tx", async () => {
      const work = await WorkRepository.create({ workspaceId: "ws", projectId: "p1" });
      store.commands.push({ ...plan, workId: work.id }, { id: "c2", projectId: "p1", workId: "other" });
      store.creatives.push({ id: "a", projectId: "p1", planId: "plan1", status: "ARCHIVED" });
      expect(await WorkRepository.removeUnlessLive("p1", work.id)).toBe("REMOVED");
      expect(store.commands.map((c) => c.id)).toEqual(["c2"]);
      expect(store.txOptions).toEqual([{ isolationLevel: "Serializable" }]);
    });

    it("answers NOT_FOUND for another project's Work", async () => {
      const work = await WorkRepository.create({ workspaceId: "ws", projectId: "p1" });
      expect(await WorkRepository.removeUnlessLive("p2", work.id)).toBe("NOT_FOUND");
      expect(store.works).toHaveLength(1);
    });
  });

  describe("Today Work (W101)", () => {
    const today = (dayKey: string, extra: Record<string, unknown> = {}) => ({
      workspaceId: "ws",
      projectId: "p1",
      dayKey,
      channels: ["instagram" as const],
      acknowledgedUnconnected: [],
      ...extra,
    });

    it("ensureToday is idempotent and creates the deterministic row", async () => {
      const a = await WorkRepository.ensureToday(today("2026-10-01"));
      const b = await WorkRepository.ensureToday(today("2026-10-01"));
      expect(a.id).toBe("today_p1_2026-10-01");
      expect(b.id).toBe(a.id);
      expect(a.title).toBe("Today");
      expect(a.summary).toBeNull();
      expect(store.works).toHaveLength(1);
    });

    it("converges on one row when create raises P2002 (two tabs)", async () => {
      store.raceOnce = true;
      const view = await WorkRepository.ensureToday(today("2026-10-01"));
      expect(view.id).toBe("today_p1_2026-10-01");
      expect(store.works).toHaveLength(1);
    });

    it("reopens a DONE or ARCHIVED Today row", async () => {
      await WorkRepository.ensureToday(today("2026-10-01"));
      for (const status of ["DONE", "ARCHIVED"] as const) {
        await WorkRepository.setStatus("p1", "today_p1_2026-10-01", status);
        const view = await WorkRepository.ensureToday(today("2026-10-01"));
        expect(view.status).toBe("ACTIVE");
        expect(store.works[0]?.status).toBe("ACTIVE");
      }
    });

    it("a Today Work is never the new chat, even untitled and empty", async () => {
      await WorkRepository.ensureToday(today("2026-10-01"));
      store.works[0]!.title = "New Chat";
      expect(await WorkRepository.isUntouched("p1", "today_p1_2026-10-01")).toBe(false);
    });

    it("does not touch another project's Today row", async () => {
      await WorkRepository.ensureToday(today("2026-10-01", { projectId: "p2" }));
      expect(await WorkRepository.findToday("p1", "2026-10-01")).toBeNull();
      expect((await WorkRepository.findToday("p2", "2026-10-01"))?.id).toBe(
        "today_p2_2026-10-01",
      );
    });

    it("recents never lists a Today Work, of any day; listRecent still has every live one", async () => {
      await WorkRepository.ensureToday(today("2026-09-30"));
      await WorkRepository.ensureToday(today("2026-10-01"));
      await WorkRepository.create({ workspaceId: "ws", projectId: "p1", title: "Chat" });
      expect((await WorkRepository.recents("p1")).map((w) => w.id)).toEqual(["w3"]);
      expect(await WorkRepository.listRecent("p1")).toHaveLength(3);
    });

    it("channelCoverage returns id, channels and status of non-archived Works", async () => {
      const a = await WorkRepository.create({ workspaceId: "ws", projectId: "p1", channels: ["x"] });
      const b = await WorkRepository.create({ workspaceId: "ws", projectId: "p1" });
      await WorkRepository.setStatus("p1", b.id, "ARCHIVED");
      expect(await WorkRepository.channelCoverage("p1")).toEqual([
        { id: a.id, channels: ["x"], status: "ACTIVE" },
      ]);
    });
  });

  // Modules (src/lib/modules): a Work remembers what it is for; null is a
  // general chat. Only an untouched Work changes module.
  describe("module", () => {
    const open = (extra: Record<string, unknown> = {}) =>
      WorkRepository.createOrReuseBlank({
        workspaceId: "ws",
        projectId: "p1",
        ...extra,
      });

    it("reads a stored module, and anything it does not know as a general chat", async () => {
      const row = (id: string, module?: unknown): Row => ({
        id,
        workspaceId: "ws",
        projectId: "p1",
        title: "Chat",
        summary: null,
        status: "ACTIVE",
        channels: [],
        acknowledgedUnconnected: [],
        lastActivityAt: new Date("2026-10-01T10:00:00Z"),
        ...(module === undefined ? {} : { module }),
      });
      store.works.push(
        row("wA", "ads"),
        row("wB", "Social"),
        row("wC", "general"),
        row("wD", null),
        row("wE"),
      );
      const modules = await Promise.all(
        ["wA", "wB", "wC", "wD", "wE"].map(
          async (id) => (await WorkRepository.get("p1", id))?.module,
        ),
      );
      expect(modules).toEqual(["ads", null, null, null, null]);
    });

    it("a new chat opened for a module is that module's; a plain one is a general chat", async () => {
      const social = await open({ module: "social" });
      expect(social).toMatchObject({ reused: false, work: { module: "social" } });
      expect(store.works[0]?.module).toBe("social");
      store.works = [];
      const plain = await open();
      expect(plain.work.module).toBeNull();
      expect(store.works[0]?.module).toBeNull();
    });

    it("the reused blank chat takes the module asked for, and a plain New Chat makes it general again", async () => {
      const first = await open({ module: "social" });
      const seo = await open({ module: "seo" });
      expect(seo).toMatchObject({ reused: true, work: { id: first.work.id, module: "seo" } });
      const plain = await open();
      expect(plain).toMatchObject({ reused: true, work: { id: first.work.id, module: null } });
      expect(store.works).toHaveLength(1);
    });

    it("a chat that has started is never reused, so it keeps its module", async () => {
      const first = await open({ module: "social" });
      store.commands.push({ id: "c1", projectId: "p1", workId: first.work.id });
      const next = await open({ module: "ads" });
      expect(next.reused).toBe(false);
      expect(next.work.module).toBe("ads");
      expect((await WorkRepository.get("p1", first.work.id))?.module).toBe("social");
    });

    it("setModule sets and clears the module of an untouched Work", async () => {
      const blank = await WorkRepository.create({ workspaceId: "ws", projectId: "p1" });
      expect(await WorkRepository.setModule("p1", blank.id, "social")).toBe(true);
      expect((await WorkRepository.get("p1", blank.id))?.module).toBe("social");
      expect(await WorkRepository.setModule("p1", blank.id, null)).toBe(true);
      expect((await WorkRepository.get("p1", blank.id))?.module).toBeNull();
    });

    it("setModule writes nothing once the chat has started, or to a Work that is not a new chat", async () => {
      const started = await WorkRepository.create({ workspaceId: "ws", projectId: "p1" });
      store.commands.push({ id: "c1", projectId: "p1", workId: started.id });
      const renamed = await WorkRepository.create({ workspaceId: "ws", projectId: "p1", title: "Ideas" });
      const done = await WorkRepository.create({ workspaceId: "ws", projectId: "p1" });
      await WorkRepository.setStatus("p1", done.id, "DONE");
      const today = await WorkRepository.ensureToday({
        workspaceId: "ws",
        projectId: "p1",
        dayKey: "2026-10-01",
        channels: [],
        acknowledgedUnconnected: [],
      });
      store.works.find((row) => row.id === today.id)!.title = "New Chat";
      const blank = await WorkRepository.create({ workspaceId: "ws", projectId: "p1" });
      for (const id of [started.id, renamed.id, done.id, today.id, "missing"]) {
        expect(await WorkRepository.setModule("p1", id, "ads")).toBe(false);
      }
      // Another project's blank Work.
      expect(await WorkRepository.setModule("p2", blank.id, "ads")).toBe(false);
      expect(store.works.every((row) => row.module === undefined)).toBe(true);
    });
  });
});

