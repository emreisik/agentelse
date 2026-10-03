import { randomUUID } from "node:crypto";

import { afterAll, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { WORK_DEFAULT_TITLE, todayWorkId } from "@/lib/works/work";
import { WorkRepository } from "@/server/repositories/work.repository";
import { describeIntegration } from "@/test-support/integration-suite";

// "New Chat" never piles up empty rows. What the in-memory repository tests cannot
// prove, a REAL Postgres does: the relation filter that says "no chat row at all",
// the advisory lock that makes two simultaneous taps one, the ordering among older
// duplicates, and that tidying them away (archive) never touches a Work with content. Runs only with a dedicated TEST_DATABASE_URL (CI, or a local
// disposable database), never against the shared development database.

describeIntegration("WorkRepository.createOrReuseBlank on Postgres", () => {
  const runId = randomUUID().slice(0, 8);
  const workspaceId = `ws_work_it_${runId}`;
  let counter = 0;
  const newProject = () => `p_${runId}_${(counter += 1)}`;

  const open = (
    projectId: string,
    over: {
      channels?: ("instagram" | "linkedin")[];
      acknowledgedUnconnected?: ("instagram" | "linkedin")[];
      currentWorkId?: string;
    } = {},
  ) =>
    WorkRepository.createOrReuseBlank({
      workspaceId,
      projectId,
      createdByUserId: "usr_it",
      ...over,
    });
  const countOf = (projectId: string) =>
    prisma.work.count({ where: { projectId } });
  const statusOf = async (id: string) =>
    (await prisma.work.findUnique({ where: { id }, select: { status: true } }))
      ?.status;
  const writeIn = (
    projectId: string,
    workId: string,
    source: "WEB" | "SYSTEM" = "WEB",
  ) =>
    prisma.command.create({
      data: { workspaceId, projectId, workId, source, rawText: "hello" },
    });
  const insertWork = (
    projectId: string,
    data: {
      id?: string;
      title?: string;
      status?: "ACTIVE" | "DONE" | "ARCHIVED";
      lastActivityAt?: Date;
    } = {},
  ) =>
    prisma.work.create({
      data: {
        workspaceId,
        projectId,
        title: WORK_DEFAULT_TITLE,
        ...data,
      },
    });

  afterAll(async () => {
    await prisma.command.deleteMany({ where: { workspaceId } });
    await prisma.work.deleteMany({ where: { workspaceId } });
  });

  it("a second tap opens the same blank Work instead of another empty row", async () => {
    const projectId = newProject();
    const first = await open(projectId);
    expect(first.reused).toBe(false);
    expect(first.work.title).toBe(WORK_DEFAULT_TITLE);

    for (let tap = 0; tap < 3; tap += 1) {
      const again = await open(projectId);
      expect(again.reused).toBe(true);
      expect(again.work.id).toBe(first.work.id);
    }
    expect(await countOf(projectId)).toBe(1);
  });

  // Holds `count` connections open at once (pg_sleep), so the pool has that many
  // ready and every tap of a burst starts immediately. With one warm connection
  // the first tap finishes while the others are still being connected, and even a
  // lock-less version passes. $executeRaw: pg_sleep returns `void`, which
  // $queryRaw cannot deserialize.
  const warmPool = (count: number) =>
    Promise.all(
      Array.from(
        { length: count },
        () => prisma.$executeRaw`SELECT pg_sleep(0.1)`,
      ),
    );

  it("bursts of simultaneous taps (two tabs, a double click) each leave exactly one Work", async () => {
    const taps = 8;
    await warmPool(taps);
    // Several fresh projects: one burst can get lucky without the lock, five
    // in a row practically never.
    for (let round = 0; round < 5; round += 1) {
      const projectId = newProject();
      const results = await Promise.all(
        Array.from({ length: taps }, () => open(projectId)),
      );
      expect(new Set(results.map((r) => r.work.id)).size).toBe(1);
      expect(results.filter((r) => !r.reused)).toHaveLength(1);
      expect(await countOf(projectId)).toBe(1);
    }
  });

  // The deterministic proof that the advisory lock is what serialises two taps:
  // while another transaction holds the project's lock, a tap must WAIT (not
  // insert a row of its own), then carry on once it is released.
  it("a tap waits while another transaction holds the project's lock, then carries on", async () => {
    const projectId = newProject();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const holder = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${projectId}:blank-work`}))`;
      locked();
      await held;
    });
    await isLocked;

    let settled = false;
    const tap = open(projectId).then((result) => {
      settled = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(settled).toBe(false);
    expect(await countOf(projectId)).toBe(0);

    release();
    await holder;
    const out = await tap;
    expect(out.reused).toBe(false);
    expect(await countOf(projectId)).toBe(1);
  });

  it("once anything is written in it, the next tap starts a fresh Work (and then reuses that one)", async () => {
    const projectId = newProject();
    const first = await open(projectId);
    await writeIn(projectId, first.work.id);

    const second = await open(projectId);
    expect(second.reused).toBe(false);
    expect(second.work.id).not.toBe(first.work.id);

    const third = await open(projectId);
    expect(third.reused).toBe(true);
    expect(third.work.id).toBe(second.work.id);
    expect(await countOf(projectId)).toBe(2);
  });

  it("a card the pipeline wrote (a SYSTEM row) also counts as use", async () => {
    const projectId = newProject();
    const first = await open(projectId);
    await writeIn(projectId, first.work.id, "SYSTEM");
    const next = await open(projectId);
    expect(next.reused).toBe(false);
    expect(next.work.id).not.toBe(first.work.id);
  });

  it("never reuses a renamed, completed or archived Work", async () => {
    for (const change of [
      { title: "Weekly plan" },
      { status: "DONE" as const },
      { status: "ARCHIVED" as const },
    ]) {
      const projectId = newProject();
      await insertWork(projectId, change);
      const out = await open(projectId);
      expect(out.reused).toBe(false);
      expect(await countOf(projectId)).toBe(2);
    }
  });

  it("never reuses a Today Work, even one that still carries the default title", async () => {
    const projectId = newProject();
    await insertWork(projectId, { id: todayWorkId(projectId, "2026-10-02") });
    const out = await open(projectId);
    expect(out.reused).toBe(false);
    expect(out.work.id.startsWith("today_")).toBe(false);
    expect(await countOf(projectId)).toBe(2);
  });

  it("is per project: another project's blank Work is not touched or reused", async () => {
    const a = newProject();
    const b = newProject();
    const inA = await open(a);
    const inB = await open(b);
    expect(inB.reused).toBe(false);
    expect(inB.work.id).not.toBe(inA.work.id);
    expect(await countOf(a)).toBe(1);
    expect(await countOf(b)).toBe(1);
  });

  it("empty copies left from before: the most recently active one opens, the others are archived, not deleted", async () => {
    const projectId = newProject();
    const now = Date.now();
    const oldest = await insertWork(projectId, {
      lastActivityAt: new Date(now - 3 * 3_600_000),
    });
    const older = await insertWork(projectId, {
      lastActivityAt: new Date(now - 2 * 3_600_000),
    });
    const newer = await insertWork(projectId, {
      lastActivityAt: new Date(now - 1 * 3_600_000),
    });
    const out = await open(projectId);
    expect(out.reused).toBe(true);
    expect(out.work.id).toBe(newer.id);
    expect(out.archived).toBe(2);
    expect(await statusOf(oldest.id)).toBe("ARCHIVED");
    expect(await statusOf(older.id)).toBe("ARCHIVED");
    expect(await statusOf(newer.id)).toBe("ACTIVE");
    // Archived, not deleted: every row is still there, only one is listed.
    expect(await countOf(projectId)).toBe(3);
    const listed = await WorkRepository.listRecent(projectId);
    expect(listed.map((w) => w.id)).toEqual([newer.id]);

    // Nothing left to tidy: the next tap archives nothing.
    expect((await open(projectId)).archived).toBe(0);
  });

  it("a person already in an empty Work stays there; the other empty copies are archived", async () => {
    const projectId = newProject();
    const now = Date.now();
    const here = await insertWork(projectId, {
      lastActivityAt: new Date(now - 4 * 3_600_000),
    });
    const elsewhere = await insertWork(projectId, {
      lastActivityAt: new Date(now - 1 * 3_600_000),
    });
    const out = await open(projectId, { currentWorkId: here.id });
    expect(out.reused).toBe(true);
    expect(out.work.id).toBe(here.id);
    expect(await statusOf(here.id)).toBe("ACTIVE");
    expect(await statusOf(elsewhere.id)).toBe("ARCHIVED");
  });

  it("a current Work that is not empty (used, renamed, Today, another project's, unknown) is only a hint and is ignored", async () => {
    const otherProject = newProject();
    const elsewhereBlank = await insertWork(otherProject);
    for (const make of [
      async (projectId: string) => {
        const used = await insertWork(projectId);
        await writeIn(projectId, used.id);
        return used.id;
      },
      async (projectId: string) =>
        (await insertWork(projectId, { title: "Weekly plan" })).id,
      async (projectId: string) =>
        (await insertWork(projectId, { id: todayWorkId(projectId, "2026-10-02") }))
          .id,
      async () => elsewhereBlank.id,
      async () => "does_not_exist",
    ]) {
      const projectId = newProject();
      const blank = await insertWork(projectId, {
        lastActivityAt: new Date(Date.now() - 3_600_000),
      });
      const currentWorkId = await make(projectId);
      const out = await open(projectId, { currentWorkId });
      expect(out.work.id).toBe(blank.id);
      if (currentWorkId !== "does_not_exist") {
        // The ignored hint itself is left exactly as it was.
        expect(await statusOf(currentWorkId)).toBe("ACTIVE");
      }
    }
    expect(await statusOf(elsewhereBlank.id)).toBe("ACTIVE");
  });

  it("tidying up never touches a Work with content, a renamed, completed or Today Work, or another project's", async () => {
    const projectId = newProject();
    const otherProject = newProject();
    const now = Date.now();
    const at = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000);

    const emptyOld = await insertWork(projectId, { lastActivityAt: at(5) });
    const emptyNew = await insertWork(projectId, { lastActivityAt: at(1) });
    // Still untitled but something was written in it.
    const used = await insertWork(projectId, { lastActivityAt: at(6) });
    await writeIn(projectId, used.id);
    const renamed = await insertWork(projectId, {
      title: "Weekly plan",
      lastActivityAt: at(7),
    });
    const done = await insertWork(projectId, { status: "DONE", lastActivityAt: at(8) });
    const today = await insertWork(projectId, {
      id: todayWorkId(projectId, "2026-10-02"),
      lastActivityAt: at(9),
    });
    const otherBlank = await insertWork(otherProject, { lastActivityAt: at(10) });

    const out = await open(projectId);
    expect(out.work.id).toBe(emptyNew.id);
    expect(out.archived).toBe(1);
    expect(await statusOf(emptyOld.id)).toBe("ARCHIVED");
    expect(await statusOf(used.id)).toBe("ACTIVE");
    expect(await statusOf(renamed.id)).toBe("ACTIVE");
    expect(await statusOf(done.id)).toBe("DONE");
    expect(await statusOf(today.id)).toBe("ACTIVE");
    expect(await statusOf(otherBlank.id)).toBe("ACTIVE");
  });

  it("an untitled Work from before the rename (\"New Work\") is still an empty one: it opens, reads as New Chat, and its first message titles it", async () => {
    const projectId = newProject();
    const now = Date.now();
    const legacyOld = await insertWork(projectId, {
      title: "New Work",
      lastActivityAt: new Date(now - 3 * 3_600_000),
    });
    const legacyNew = await insertWork(projectId, {
      title: "New Work",
      lastActivityAt: new Date(now - 1 * 3_600_000),
    });
    const renamedAlready = await insertWork(projectId, {
      lastActivityAt: new Date(now - 2 * 3_600_000),
    });
    const out = await open(projectId);
    expect(out.reused).toBe(true);
    expect(out.work.id).toBe(legacyNew.id);
    expect(out.work.title).toBe(WORK_DEFAULT_TITLE);
    expect(out.archived).toBe(2);
    expect(await statusOf(legacyOld.id)).toBe("ARCHIVED");
    expect(await statusOf(renamedAlready.id)).toBe("ARCHIVED");

    await WorkRepository.touch(projectId, legacyNew.id, {
      titleIfDefault: "Weekly plan",
    });
    expect((await WorkRepository.get(projectId, legacyNew.id))?.title).toBe(
      "Weekly plan",
    );
  });

  it("opening it moves it to the top of the recent list", async () => {
    const projectId = newProject();
    const now = Date.now();
    const used = await insertWork(projectId, {
      title: "Weekly plan",
      lastActivityAt: new Date(now - 1 * 3_600_000),
    });
    const blank = await insertWork(projectId, {
      lastActivityAt: new Date(now - 5 * 3_600_000),
    });
    expect((await WorkRepository.listRecent(projectId))[0]?.id).toBe(used.id);

    const out = await open(projectId);
    expect(out.work.id).toBe(blank.id);
    expect((await WorkRepository.listRecent(projectId))[0]?.id).toBe(blank.id);
  });

  it("recents: the blank chat and Today are not listed; one with a message, a renamed or a completed one is", async () => {
    const projectId = newProject();
    const now = Date.now();
    const at = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000);
    const blank = await insertWork(projectId, { lastActivityAt: at(1) });
    await insertWork(projectId, { title: "New Work", lastActivityAt: at(2) });
    const used = await insertWork(projectId, { lastActivityAt: at(3) });
    await writeIn(projectId, used.id);
    const renamed = await insertWork(projectId, {
      title: "Ideas for May",
      lastActivityAt: at(4),
    });
    const done = await insertWork(projectId, {
      status: "DONE",
      lastActivityAt: at(5),
    });
    await insertWork(projectId, {
      title: "Old",
      status: "ARCHIVED",
      lastActivityAt: at(0.5),
    });
    const today = await insertWork(projectId, {
      id: todayWorkId(projectId, "2026-10-02"),
      title: "Today",
      lastActivityAt: at(0.2),
    });
    await writeIn(projectId, today.id);
    await insertWork(newProject(), { title: "Another project's chat" });

    const ids = async (limit?: number) =>
      (await WorkRepository.recents(projectId, limit)).map((w) => w.id);
    expect(await ids()).toEqual([used.id, renamed.id, done.id]);

    // Its first message moves the blank chat into Recents.
    await writeIn(projectId, blank.id);
    expect(await ids()).toEqual([blank.id, used.id, renamed.id, done.id]);
    expect(await ids(2)).toEqual([blank.id, used.id]);
  });

  it("isUntouched agrees with New Chat's reuse rule, row by row", async () => {
    const projectId = newProject();
    const blank = await insertWork(projectId);
    const legacy = await insertWork(projectId, { title: "New Work" });
    const used = await insertWork(projectId);
    await writeIn(projectId, used.id, "SYSTEM");
    const renamed = await insertWork(projectId, { title: "Ideas for May" });
    const done = await insertWork(projectId, { status: "DONE" });
    const archived = await insertWork(projectId, { status: "ARCHIVED" });
    const today = await insertWork(projectId, {
      id: todayWorkId(projectId, "2026-10-02"),
    });
    const verdict = async (id: string, project = projectId) =>
      WorkRepository.isUntouched(project, id);
    expect(await verdict(blank.id)).toBe(true);
    expect(await verdict(legacy.id)).toBe(true);
    for (const id of [used.id, renamed.id, done.id, archived.id, today.id]) {
      expect(await verdict(id)).toBe(false);
    }
    expect(await verdict(blank.id, newProject())).toBe(false);
    expect(await verdict("does_not_exist")).toBe(false);
    // The Work New Chat reuses is exactly an untouched one.
    const reused = await open(projectId, { currentWorkId: legacy.id });
    expect(reused.reused).toBe(true);
    expect(await verdict(reused.work.id)).toBe(true);
  });

  it("explicitly requested channels replace the blank Work's; asking for none keeps its own", async () => {
    const projectId = newProject();
    const first = await open(projectId, { channels: ["instagram"] });
    expect(first.work.channels).toEqual(["instagram"]);

    const plain = await open(projectId);
    expect(plain.reused).toBe(true);
    expect(plain.work.channels).toEqual(["instagram"]);

    const switched = await open(projectId, {
      channels: ["linkedin"],
      acknowledgedUnconnected: ["linkedin"],
    });
    expect(switched.reused).toBe(true);
    expect(switched.work.id).toBe(first.work.id);
    expect(switched.work.channels).toEqual(["linkedin"]);
    expect(switched.work.acknowledgedUnconnected).toEqual(["linkedin"]);
    expect(await countOf(projectId)).toBe(1);
  });

  // A message that finds a chat with no channel stores its defaults
  // (setInitialChannels): one conditional UPDATE on a Json column.
  const channelsOf = async (id: string) =>
    (await prisma.work.findUnique({ where: { id }, select: { channels: true } }))
      ?.channels;
  const storeFirst = (
    projectId: string,
    workId: string,
    channels: ("instagram" | "linkedin")[] = ["instagram"],
  ) => WorkRepository.setInitialChannels(projectId, workId, channels, []);

  it("setInitialChannels fills the blank new chat once; a choice already stored is never overwritten", async () => {
    const projectId = newProject();
    const blank = await insertWork(projectId);
    // `channels = '[]'` on a real jsonb column.
    expect(await channelsOf(blank.id)).toEqual([]);
    expect(await storeFirst(projectId, blank.id, ["instagram", "linkedin"])).toBe(true);
    expect(await channelsOf(blank.id)).toEqual(["instagram", "linkedin"]);
    expect(await storeFirst(projectId, blank.id, ["linkedin"])).toBe(false);
    expect(await channelsOf(blank.id)).toEqual(["instagram", "linkedin"]);
  });

  it("setInitialChannels gives defaults to an ACTIVE Work that has none, used or not; never to a completed, archived or foreign one", async () => {
    const projectId = newProject();
    const used = await insertWork(projectId);
    await writeIn(projectId, used.id);
    const renamed = await insertWork(projectId, { title: "Ideas for May" });
    const today = await insertWork(projectId, {
      id: todayWorkId(projectId, "2026-10-02"),
      title: "Today",
    });
    for (const work of [used, renamed, today]) {
      expect(await storeFirst(projectId, work.id)).toBe(true);
      expect(await channelsOf(work.id)).toEqual(["instagram"]);
    }
    const done = await insertWork(projectId, { status: "DONE" });
    const archived = await insertWork(projectId, { status: "ARCHIVED" });
    for (const work of [done, archived]) {
      expect(await storeFirst(projectId, work.id)).toBe(false);
      expect(await channelsOf(work.id)).toEqual([]);
    }
    const blank = await insertWork(projectId);
    expect(await storeFirst(newProject(), blank.id)).toBe(false);
    expect(await storeFirst(projectId, "does_not_exist")).toBe(false);
    expect(await channelsOf(blank.id)).toEqual([]);
  });

  it("two first messages at once (two tabs): exactly one stores its channels", async () => {
    const projectId = newProject();
    const blank = await insertWork(projectId);
    const [a, b] = await Promise.all([
      storeFirst(projectId, blank.id, ["instagram"]),
      storeFirst(projectId, blank.id, ["linkedin"]),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await channelsOf(blank.id)).toEqual(a ? ["instagram"] : ["linkedin"]);
  });
});
