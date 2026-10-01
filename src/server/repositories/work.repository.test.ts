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
    if (key === "NOT") return !matches(row, value as Record<string, unknown>);
    if (key === "id" && value && typeof value === "object") {
      const { startsWith, lt } = value as { startsWith?: string; lt?: string };
      return (
        (startsWith === undefined || row.id.startsWith(startsWith)) &&
        (lt === undefined || row.id < lt)
      );
    }
    if (key === "status" && value && typeof value === "object") {
      return row.status !== (value as { not: unknown }).not;
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
    return typeof arg === "function"
      ? arg({ work, command, creative })
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
    expect(work.title).toBe("New Work");
    expect(work.channels).toEqual(["instagram"]);
    expect(work.status).toBe("ACTIVE");
  });

  it("never reads or writes another project's Work", async () => {
    const work = await WorkRepository.create({ workspaceId: "ws", projectId: "p1" });
    expect(await WorkRepository.get("p2", work.id)).toBeNull();
    expect(await WorkRepository.rename("p2", work.id, "x")).toBe(false);
    expect(await WorkRepository.setStatus("p2", work.id, "DONE")).toBe(false);
    expect(await WorkRepository.remove("p2", work.id)).toBe(false);
    expect((await WorkRepository.get("p1", work.id))?.title).toBe("New Work");
  });

  it("lists recent works without the archived ones", async () => {
    const a = await WorkRepository.create({ workspaceId: "ws", projectId: "p1", title: "A" });
    await WorkRepository.create({ workspaceId: "ws", projectId: "p1", title: "B" });
    await WorkRepository.setStatus("p1", a.id, "ARCHIVED");
    const list = await WorkRepository.listRecent("p1");
    expect(list.map((w) => w.title)).toEqual(["B"]);
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

  it("setChannels stores the choice and the acknowledged-unconnected subset", async () => {
    const work = await WorkRepository.create({ workspaceId: "ws", projectId: "p1" });
    await WorkRepository.setChannels("p1", work.id, ["instagram", "x"], ["x"]);
    const got = await WorkRepository.get("p1", work.id);
    expect(got?.channels).toEqual(["instagram", "x"]);
    expect(got?.acknowledgedUnconnected).toEqual(["x"]);
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

    it("does not touch another project's Today row", async () => {
      await WorkRepository.ensureToday(today("2026-10-01", { projectId: "p2" }));
      expect(await WorkRepository.findToday("p1", "2026-10-01")).toBeNull();
      expect((await WorkRepository.findToday("p2", "2026-10-01"))?.id).toBe(
        "today_p2_2026-10-01",
      );
    });

    it("listRecent hides earlier Today Works and keeps today's", async () => {
      await WorkRepository.ensureToday(today("2026-09-30"));
      await WorkRepository.ensureToday(today("2026-10-01"));
      await WorkRepository.create({ workspaceId: "ws", projectId: "p1", title: "Chat" });
      const hidden = await WorkRepository.listRecent("p1", 12, { todayKey: "2026-10-01" });
      expect(hidden.map((w) => w.id).sort()).toEqual(["today_p1_2026-10-01", "w3"]);
      // Default call is unchanged: everything non-archived.
      expect(await WorkRepository.listRecent("p1")).toHaveLength(3);
    });

    it("latestActive excludes Today Works only on request", async () => {
      await WorkRepository.create({ workspaceId: "ws", projectId: "p1", title: "Chat" });
      await WorkRepository.ensureToday(today("2026-10-01"));
      const plain = await WorkRepository.latestActive("p1");
      expect(plain).not.toBeNull();
      store.works = store.works.filter((r) => r.id.startsWith("today_"));
      expect(await WorkRepository.latestActive("p1", { excludeToday: true })).toBeNull();
      expect((await WorkRepository.latestActive("p1"))?.id).toBe("today_p1_2026-10-01");
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
});
