import { beforeEach, describe, expect, it, vi } from "vitest";

const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidatePath }));
const enabled = vi.hoisted(() => vi.fn());
const modulesOn = vi.hoisted(() => vi.fn());
vi.mock("@/server/works/flag", () => ({
  isWorksEnabled: enabled,
  isModulesEnabled: modulesOn,
}));
const requireUser = vi.hoisted(() => vi.fn());
const requireProjectAccess = vi.hoisted(() => vi.fn());
vi.mock("@/server/security/tenant-context", () => ({
  requireUser,
  requireProjectAccess,
}));
const limited = vi.hoisted(() => vi.fn());
vi.mock("@/lib/rate-limit", () => ({ isRateLimited: limited }));
const connections = vi.hoisted(() => vi.fn());
vi.mock("@/server/integrations/channel-connections", () => ({
  getChannelConnections: connections,
}));
const repo = vi.hoisted(() => ({
  create: vi.fn(),
  createOrReuseBlank: vi.fn(),
  setChannels: vi.fn(),
  setModule: vi.fn(),
  setStatus: vi.fn(),
  rename: vi.fn(),
  remove: vi.fn(),
  removeUnlessLive: vi.fn(),
  countLiveSlots: vi.fn(),
  ensureToday: vi.fn(),
  channelCoverage: vi.fn(),
  get: vi.fn(),
}));
const executeRaw = vi.hoisted(() => vi.fn());
const order = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ $executeRaw: executeRaw }),
  },
}));
vi.mock("@/server/chat/content-plan", () => ({
  getProjectTimezone: vi.fn().mockResolvedValue("Europe/Istanbul"),
  todayInTimezone: () => "2026-10-01",
}));
vi.mock("@/server/repositories/work.repository", () => ({
  WorkRepository: repo,
}));

const actions = await import("./work-actions");

beforeEach(() => {
  vi.resetAllMocks();
  enabled.mockReturnValue(true);
  modulesOn.mockReturnValue(true);
  limited.mockReturnValue(false);
  requireUser.mockResolvedValue({ userId: "u1" });
  requireProjectAccess.mockResolvedValue({ workspaceId: "ws1" });
  connections.mockResolvedValue({ instagram: { connected: true } });
  order.calls = [];
  executeRaw.mockImplementation(async () => {
    order.calls.push("lock");
    return 1;
  });
  repo.create.mockImplementation(async () => {
    order.calls.push("create");
    return { id: "wNew" };
  });
  repo.createOrReuseBlank.mockResolvedValue({
    work: { id: "wNew" },
    reused: false,
  });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("guards (every action)", () => {
  it("refuses when Works is off, without touching the database", async () => {
    enabled.mockReturnValue(false);
    expect(await actions.createWorkAction("p1")).toMatchObject({ ok: false });
    expect(await actions.completeWorkAction("p1", "w1")).toMatchObject({ ok: false });
    expect(repo.create).not.toHaveBeenCalled();
    expect(repo.createOrReuseBlank).not.toHaveBeenCalled();
    expect(repo.setStatus).not.toHaveBeenCalled();
  });

  it("refuses bad ids and a rate-limited user", async () => {
    expect(await actions.completeWorkAction("p1", "")).toMatchObject({ ok: false });
    expect(await actions.createWorkAction(42 as never)).toMatchObject({ ok: false });
    limited.mockReturnValue(true);
    expect(await actions.createWorkAction("p1")).toMatchObject({ ok: false });
    expect(repo.create).not.toHaveBeenCalled();
    expect(repo.createOrReuseBlank).not.toHaveBeenCalled();
  });

  it("turns a thrown access error into a plain failure", async () => {
    requireProjectAccess.mockRejectedValue(new Error("nope"));
    expect(await actions.createWorkAction("p1")).toEqual({
      ok: false,
      message: "That didn't work. Try again.",
    });
  });
});

// Opening a project lands in createWorkAction, so it must not run into the
// 40-per-10-minutes bucket of the destructive actions, and must not re-read the
// page it is leaving.
describe("createWorkAction as the landing step of every project open", () => {
  beforeEach(() => {
    repo.createOrReuseBlank.mockResolvedValue({ work: { id: "w1" }, reused: false });
  });

  it("has its own, much larger rate bucket", async () => {
    await actions.createWorkAction("p1");
    const [key, limit] = limited.mock.calls[0] as [string, number];
    expect(key).toBe("work-create:u1");
    expect(limit).toBeGreaterThanOrEqual(200);
    // Sharing no bucket with the others (40 per window).
    await actions.completeWorkAction("p1", "w1");
    expect(limited.mock.calls[1]?.[0]).toBe("works:u1");
    expect(limited.mock.calls[1]?.[1]).toBe(40);
  });

  it("is still refused when its own bucket is spent", async () => {
    limited.mockReturnValue(true);
    expect(await actions.createWorkAction("p1")).toMatchObject({ ok: false });
    expect(repo.createOrReuseBlank).not.toHaveBeenCalled();
  });

  it("does not revalidate: an empty chat is not in Recents and both callers move to a fresh URL", async () => {
    await actions.createWorkAction("p1");
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("createWorkAction (New Chat is idempotent)", () => {
  it("opens the blank Work with validated channels and records the unconnected ones", async () => {
    repo.createOrReuseBlank.mockResolvedValue({
      work: { id: "w1" },
      reused: false,
    });
    const out = await actions.createWorkAction("p1", [
      "instagram",
      "linkedin",
      "bogus",
    ]);
    expect(out).toEqual({ ok: true, workId: "w1" });
    expect(repo.createOrReuseBlank).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "p1",
        workspaceId: "ws1",
        createdByUserId: "u1",
        channels: ["instagram", "linkedin"],
        acknowledgedUnconnected: ["linkedin"],
      }),
    );
  });

  it("answers the same whether the chat is new or the project's blank one (nothing to say, like ChatGPT)", async () => {
    for (const reused of [false, true]) {
      repo.createOrReuseBlank.mockResolvedValue({
        work: { id: "w1" },
        reused,
      });
      expect(await actions.createWorkAction("p1")).toStrictEqual({
        ok: true,
        workId: "w1",
      });
    }
  });

  it("never inserts a row itself: the repository decides between new and existing", async () => {
    await actions.createWorkAction("p1");
    await actions.createWorkAction("p1", ["instagram"]);
    expect(repo.create).not.toHaveBeenCalled();
    expect(repo.createOrReuseBlank).toHaveBeenCalledTimes(2);
  });

  it("a plain New Chat tap (no channels) does not read the live connections", async () => {
    await actions.createWorkAction("p1");
    expect(connections).not.toHaveBeenCalled();
    expect(repo.createOrReuseBlank).toHaveBeenCalledWith(
      expect.objectContaining({ channels: [], acknowledgedUnconnected: [] }),
    );
  });

  it("passes the Work the person is in as a hint, and drops an invalid one", async () => {
    await actions.createWorkAction("p1", undefined, "wHere");
    expect(repo.createOrReuseBlank).toHaveBeenLastCalledWith(
      expect.objectContaining({ currentWorkId: "wHere" }),
    );
    for (const bad of [42, "", "x".repeat(65), { id: "w" }, null]) {
      await actions.createWorkAction("p1", undefined, bad);
      expect(repo.createOrReuseBlank).toHaveBeenLastCalledWith(
        expect.objectContaining({ currentWorkId: undefined }),
      );
    }
  });

  it("turns a failing repository into a plain failure", async () => {
    repo.createOrReuseBlank.mockRejectedValue(new Error("db down"));
    expect(await actions.createWorkAction("p1")).toEqual({
      ok: false,
      message: "That didn't work. Try again.",
    });
  });
});

// Modules (src/lib/modules): New Chat opens a chat for a module, and the New
// Chat screen changes it while the chat is still empty.
describe("createWorkAction with a module", () => {
  it("opens the blank Work for the module asked for", async () => {
    expect(await actions.createWorkAction("p1", undefined, undefined, "social")).toEqual({
      ok: true,
      workId: "wNew",
    });
    expect(repo.createOrReuseBlank).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p1", module: "social" }),
    );
  });

  it("a plain New Chat is a general chat, without reading the modules flag", async () => {
    await actions.createWorkAction("p1");
    await actions.createWorkAction("p1", ["instagram"], "wHere");
    for (const [arg] of repo.createOrReuseBlank.mock.calls) {
      expect(arg).toMatchObject({ module: null });
    }
    expect(modulesOn).not.toHaveBeenCalled();
  });

  it("an unknown module, or modules off, opens a general chat instead of failing", async () => {
    for (const bad of ["Social", "general", "", 7, { key: "ads" }, null]) {
      expect(await actions.createWorkAction("p1", undefined, undefined, bad)).toMatchObject({
        ok: true,
      });
      expect(repo.createOrReuseBlank).toHaveBeenLastCalledWith(
        expect.objectContaining({ module: null }),
      );
    }
    modulesOn.mockReturnValue(false);
    await actions.createWorkAction("p1", undefined, undefined, "ads");
    expect(repo.createOrReuseBlank).toHaveBeenLastCalledWith(
      expect.objectContaining({ module: null }),
    );
  });
});

describe("setWorkModuleAction", () => {
  beforeEach(() => {
    repo.setModule.mockResolvedValue(true);
  });

  it("puts an untouched chat in a module, scoped to the project", async () => {
    expect(await actions.setWorkModuleAction("p1", "w1", "seo")).toEqual({
      ok: true,
      module: "seo",
    });
    expect(repo.setModule).toHaveBeenCalledWith("p1", "w1", "seo");
    expect(requireProjectAccess).toHaveBeenCalledWith("u1", "p1");
    expect(revalidatePath).toHaveBeenCalledWith("/projects/p1");
  });

  it("null takes it back to a general chat", async () => {
    expect(await actions.setWorkModuleAction("p1", "w1", null)).toEqual({
      ok: true,
      module: null,
    });
    expect(repo.setModule).toHaveBeenCalledWith("p1", "w1", null);
  });

  it("refuses an unknown module or a bad id, writing nothing", async () => {
    for (const bad of ["Social", "general", "", undefined, 3]) {
      expect(await actions.setWorkModuleAction("p1", "w1", bad)).toEqual({
        ok: false,
        message: "That didn't work. Try again.",
      });
    }
    expect(await actions.setWorkModuleAction("p1", "", "social")).toMatchObject({
      ok: false,
    });
    expect(repo.setModule).not.toHaveBeenCalled();
  });

  it("refuses while modules are off, before any other read", async () => {
    modulesOn.mockReturnValue(false);
    expect(await actions.setWorkModuleAction("p1", "w1", "social")).toEqual({
      ok: false,
      message: "Modules aren't available.",
    });
    expect(requireUser).not.toHaveBeenCalled();
    expect(repo.setModule).not.toHaveBeenCalled();
  });

  it("has its own rate bucket and is refused when it is spent", async () => {
    await actions.setWorkModuleAction("p1", "w1", "social");
    expect(limited.mock.calls[0]?.[0]).toBe("work-module:u1");
    expect(limited.mock.calls[0]?.[1]).toBeGreaterThanOrEqual(100);
    limited.mockReturnValue(true);
    expect(await actions.setWorkModuleAction("p1", "w1", "social")).toEqual({
      ok: false,
      message: "Slow down for a moment.",
    });
    expect(repo.setModule).toHaveBeenCalledTimes(1);
  });

  it("a chat that has started keeps its module; a missing one says so", async () => {
    repo.setModule.mockResolvedValue(false);
    repo.get.mockResolvedValueOnce({ id: "w1" });
    expect(await actions.setWorkModuleAction("p1", "w1", "ads")).toEqual({
      ok: false,
      message: "This chat has already started.",
    });
    repo.get.mockResolvedValueOnce(null);
    expect(await actions.setWorkModuleAction("p1", "w9", "ads")).toEqual({
      ok: false,
      message: "That Work no longer exists.",
    });
    expect(repo.get).toHaveBeenCalledWith("p1", "w9");
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("turns a failing repository into a plain failure", async () => {
    repo.setModule.mockRejectedValue(new Error("db down"));
    expect(await actions.setWorkModuleAction("p1", "w1", "social")).toEqual({
      ok: false,
      message: "That didn't work. Try again.",
    });
  });
});

describe("setWorkChannelsAction", () => {
  it("requires at least one known channel", async () => {
    expect(await actions.setWorkChannelsAction("p1", "w1", ["bogus"])).toMatchObject({
      ok: false,
    });
    expect(repo.setChannels).not.toHaveBeenCalled();
  });

  it("saves scoped to the project and reports a missing Work", async () => {
    repo.setChannels.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await actions.setWorkChannelsAction("p1", "w1", ["tiktok"])).toEqual({
      ok: true,
      channels: ["tiktok"],
    });
    expect(repo.setChannels).toHaveBeenCalledWith("p1", "w1", ["tiktok"], ["tiktok"]);
    expect(await actions.setWorkChannelsAction("p1", "w9", ["x"])).toMatchObject({
      ok: false,
    });
  });
});

describe("status, rename, delete", () => {
  it("maps each action to its transition, project-scoped", async () => {
    repo.setStatus.mockResolvedValue(true);
    await actions.completeWorkAction("p1", "w1");
    await actions.reopenWorkAction("p1", "w1");
    await actions.archiveWorkAction("p1", "w1");
    expect(repo.setStatus.mock.calls.map((c) => c.slice(0, 3))).toEqual([
      ["p1", "w1", "DONE"],
      ["p1", "w1", "ACTIVE"],
      ["p1", "w1", "ARCHIVED"],
    ]);
  });

  it("rename trims, caps and refuses an empty name", async () => {
    repo.rename.mockResolvedValue(true);
    expect(await actions.renameWorkAction("p1", "w1", "   ")).toMatchObject({ ok: false });
    await actions.renameWorkAction("p1", "w1", `  ${"a".repeat(100)}  `);
    expect(repo.rename.mock.calls[0]?.[2]).toHaveLength(60);
  });

  it("delete reports a Work that is not there", async () => {
    repo.removeUnlessLive.mockResolvedValue("NOT_FOUND");
    expect(await actions.deleteWorkAction("p1", "w1")).toMatchObject({ ok: false });
  });

  it("delete is refused while live slots exist, and allowed without them", async () => {
    repo.removeUnlessLive.mockResolvedValue("LIVE");
    expect(await actions.deleteWorkAction("p1", "w1")).toEqual({
      ok: false,
      message: "This Work still has pieces on your calendar. Archive it instead.",
    });
    repo.removeUnlessLive.mockResolvedValue("REMOVED");
    expect(await actions.deleteWorkAction("p1", "w1")).toEqual({ ok: true });
    expect(repo.removeUnlessLive).toHaveBeenCalledWith("p1", "w1");
    // Count and delete are one repository call: no separate, racy count.
    expect(repo.countLiveSlots).not.toHaveBeenCalled();
    expect(repo.remove).not.toHaveBeenCalled();
  });

  it("archive still works with live slots", async () => {
    repo.countLiveSlots.mockResolvedValue(3);
    repo.setStatus.mockResolvedValue(true);
    expect(await actions.archiveWorkAction("p1", "w1")).toEqual({ ok: true });
  });
});

const TODAY_MESSAGE =
  "Today's brief can't be completed, archived, renamed or deleted.";

describe("openTodayWorkAction", () => {
  beforeEach(() => {
    repo.ensureToday.mockResolvedValue({ id: "today_p1_2026-10-01" });
  });

  it("refuses with the flag off or a bad project id, writing nothing", async () => {
    enabled.mockReturnValue(false);
    expect(await actions.openTodayWorkAction("p1")).toMatchObject({ ok: false });
    enabled.mockReturnValue(true);
    expect(await actions.openTodayWorkAction("")).toMatchObject({ ok: false });
    expect(repo.ensureToday).not.toHaveBeenCalled();
  });

  it("checks project access and uses its own rate bucket", async () => {
    await actions.openTodayWorkAction("p1");
    expect(requireProjectAccess).toHaveBeenCalledWith("u1", "p1");
    expect(limited.mock.calls[0]?.[0]).toBe("work-open:u1");
    limited.mockReturnValue(true);
    expect(await actions.openTodayWorkAction("p1")).toMatchObject({ ok: false });
  });

  it("plans the connected channels plus seo, only when something is connected", async () => {
    connections.mockResolvedValue({
      instagram: { connected: true },
      linkedin: { connected: false },
    });
    await actions.openTodayWorkAction("p1");
    expect(repo.ensureToday).toHaveBeenLastCalledWith(
      expect.objectContaining({
        dayKey: "2026-10-01",
        channels: ["instagram", "seo"],
        acknowledgedUnconnected: [],
      }),
    );
    connections.mockResolvedValue({ linkedin: { connected: false } });
    await actions.openTodayWorkAction("p1");
    expect(repo.ensureToday).toHaveBeenLastCalledWith(
      expect.objectContaining({ channels: [] }),
    );
  });

  it("is idempotent: the same day gives the same id", async () => {
    const a = await actions.openTodayWorkAction("p1");
    const b = await actions.openTodayWorkAction("p1");
    expect(a).toEqual({ ok: true, workId: "today_p1_2026-10-01" });
    expect(b).toEqual(a);
  });
});

describe("openChannelWorkAction", () => {
  it("refuses a bad channel and seo, creating nothing", async () => {
    expect(await actions.openChannelWorkAction("p1", "bogus")).toMatchObject({ ok: false });
    expect(await actions.openChannelWorkAction("p1", "seo")).toMatchObject({ ok: false });
    expect(await actions.openChannelWorkAction("p1", ["instagram"])).toMatchObject({
      ok: false,
    });
    expect(repo.create).not.toHaveBeenCalled();
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it("refuses with the flag off", async () => {
    enabled.mockReturnValue(false);
    expect(await actions.openChannelWorkAction("p1", "instagram")).toMatchObject({
      ok: false,
    });
    expect(repo.create).not.toHaveBeenCalled();
  });

  it("reuses an ACTIVE non-Today Work whose channels equal [channel]", async () => {
    repo.channelCoverage.mockResolvedValue([
      { id: "today_p1_2026-10-01", channels: ["instagram"], status: "ACTIVE" },
      { id: "wDone", channels: ["instagram"], status: "DONE" },
      { id: "wMulti", channels: ["instagram", "tiktok"], status: "ACTIVE" },
      { id: "wIg", channels: ["instagram"], status: "ACTIVE" },
    ]);
    repo.get.mockResolvedValue({ id: "wIg" });
    expect(await actions.openChannelWorkAction("p1", "instagram")).toEqual({
      ok: true,
      workId: "wIg",
    });
    expect(repo.create).not.toHaveBeenCalled();
  });

  it("creates a single-channel Work when none covers it, lock first", async () => {
    repo.channelCoverage.mockResolvedValue([]);
    expect(await actions.openChannelWorkAction("p1", "instagram")).toEqual({
      ok: true,
      workId: "wNew",
    });
    expect(order.calls).toEqual(["lock", "create"]);
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ channels: ["instagram"], acknowledgedUnconnected: [] }),
    );
    expect(limited.mock.calls[0]?.[0]).toBe("work-open:u1");
  });

  it("two parallel taps create ONE Work (the lock serialises them)", async () => {
    const rows: { id: string; channels: string[]; status: string }[] = [];
    let chain: Promise<unknown> = Promise.resolve();
    executeRaw.mockImplementation(() => {
      // Emulates the advisory lock: the second tap waits for the first.
      const wait = chain;
      let release!: () => void;
      chain = new Promise<void>((r) => (release = r));
      repo.create.mockImplementationOnce(async () => {
        rows.push({ id: "w1", channels: ["instagram"], status: "ACTIVE" });
        release();
        return { id: "w1" };
      });
      return wait.then(() => 1);
    });
    repo.channelCoverage.mockImplementation(async () => [...rows]);
    repo.get.mockImplementation(async (_p: string, id: string) => ({ id }));
    const [a, b] = await Promise.all([
      actions.openChannelWorkAction("p1", "instagram"),
      actions.openChannelWorkAction("p1", "instagram"),
    ]);
    expect(a).toEqual({ ok: true, workId: "w1" });
    expect(b).toEqual({ ok: true, workId: "w1" });
    expect(repo.create).toHaveBeenCalledTimes(1);
  });
});

describe("Today Work refusals", () => {
  const today = "today_p1_2026-10-01";

  it("refuses complete, archive, rename and delete of a Today Work", async () => {
    const refused = { ok: false, message: TODAY_MESSAGE };
    expect(await actions.completeWorkAction("p1", today)).toEqual(refused);
    expect(await actions.archiveWorkAction("p1", today)).toEqual(refused);
    expect(await actions.renameWorkAction("p1", today, "x")).toEqual(refused);
    expect(await actions.deleteWorkAction("p1", today)).toEqual(refused);
    expect(repo.setStatus).not.toHaveBeenCalled();
    expect(repo.rename).not.toHaveBeenCalled();
    expect(repo.removeUnlessLive).not.toHaveBeenCalled();
  });

  it("still allows reopening a Today Work, and ordinary Works are unchanged", async () => {
    repo.setStatus.mockResolvedValue(true);
    expect(await actions.reopenWorkAction("p1", today)).toEqual({ ok: true });
    expect(await actions.completeWorkAction("p1", "w1")).toEqual({ ok: true });
  });
});
