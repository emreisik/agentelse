import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: GA_FIXES kapalıyken uzlaştırma hiç sorgu yapmaz;
// onay kararı satıra yansır (ret/revizyon -> REJECTED, iptal/süre -> EXPIRED,
// başka yoldan onay -> onayla + uygula); süresi dolan öneri kapanır ve Task'ı
// iptal olur; kirası dolmuş APPLYING/UNDOING geri döner; 14 gündür
// uygulanmamış onay kapanır; vadesi gelenler uygulanır; tur başına en çok
// `limit` satır işlenir; günlük temizlik yalnız canlıda koşar; dev izin
// listesi sorguya girer.

const mocks = vi.hoisted(() => ({
  changeFindMany: vi.fn(),
  changeUpdateMany: vi.fn(),
  changeDeleteMany: vi.fn(),
  approvalFindMany: vi.fn(),
  approvalUpdateMany: vi.fn(),
  taskFindFirst: vi.fn(),
  transition: vi.fn(),
  apply: vi.fn(),
  sync: vi.fn(),
  audit: vi.fn(),
  beat: vi.fn(),
  ok: vi.fn(),
  claimPeriodic: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    gaConfigChange: {
      findMany: mocks.changeFindMany,
      updateMany: mocks.changeUpdateMany,
      deleteMany: mocks.changeDeleteMany,
    },
    approval: {
      findMany: mocks.approvalFindMany,
      updateMany: mocks.approvalUpdateMany,
    },
    task: { findFirst: mocks.taskFindFirst },
  },
}));
vi.mock("@/server/repositories/task.repository", () => ({
  TaskRepository: { transition: mocks.transition },
}));
vi.mock("./apply", () => ({ applyGaConfigChange: mocks.apply }));
vi.mock("./approval-hook", () => ({ syncGaFixApprovalState: mocks.sync }));
vi.mock("./audit", () => ({ recordGaFixAudit: mocks.audit }));
vi.mock("@/server/observability/heartbeat", () => ({
  Heartbeat: { beat: mocks.beat, ok: mocks.ok },
}));
vi.mock("@/server/observability/periodic", () => ({
  claimPeriodic: mocks.claimPeriodic,
}));

const { runGaFixesDue } = await import("./reconcile");

const NOW = new Date("2026-10-07T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

type Row = Record<string, unknown>;

function change(overrides: Row = {}): Row {
  return {
    id: "c1",
    workspaceId: "w1",
    projectId: "p1",
    linkId: "l1",
    kind: "KEY_EVENT_CREATE",
    status: "PROPOSED",
    taskId: "t1",
    approvalId: "a1",
    expiresAt: new Date(NOW.getTime() + DAY),
    approvedAt: null,
    appliedAt: null,
    createdAt: new Date(NOW.getTime() - DAY),
    updatedAt: new Date(NOW.getTime() - DAY),
    ...overrides,
  };
}

// Aday sorguları status'e göre cevaplanır; "STALE" anahtarı 14 günlük eski
// onay sorgusunu (approvedAt < sınır) ayırır; olmayan durum boş liste döner.
function seed(rows: Partial<Record<string, Row[]>>): void {
  mocks.changeFindMany.mockImplementation(
    async (args: { where: { status?: string; approvedAt?: { lt?: Date } } }) => {
      if (args.where.approvedAt?.lt) return rows.STALE ?? [];
      return rows[args.where.status ?? ""] ?? [];
    },
  );
}

// Durumun ana aday sorgusu (eski onay sorgusu hariç).
function findManyFor(status: string): { where: Row; take?: number } {
  const call = mocks.changeFindMany.mock.calls.find(([args]) => {
    const where = (args as { where: { status?: string; approvedAt?: { lt?: Date } } })
      .where;
    return where.status === status && where.approvedAt?.lt === undefined;
  });
  if (!call) throw new Error(`no findMany call for ${status}`);
  return call[0] as { where: Row; take?: number };
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("GA_SYNC", "true");
  vi.stubEnv("GA_FIXES", "true");
  vi.stubEnv("GA_FIXES_ALPHA", "true");
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.changeFindMany.mockResolvedValue([]);
  mocks.changeUpdateMany.mockResolvedValue({ count: 1 });
  mocks.approvalFindMany.mockResolvedValue([]);
  mocks.approvalUpdateMany.mockResolvedValue({ count: 1 });
  mocks.taskFindFirst.mockResolvedValue({ status: "WAITING_APPROVAL" });
  mocks.transition.mockResolvedValue({});
  mocks.apply.mockResolvedValue({ state: "verified" });
  mocks.sync.mockResolvedValue("APPROVED");
  mocks.claimPeriodic.mockResolvedValue(false);
});

describe("runGaFixesDue: bayrak", () => {
  it("returns 0 without any query when GA_FIXES is off", async () => {
    vi.stubEnv("GA_FIXES", "false");
    expect(await runGaFixesDue(5, NOW)).toBe(0);
    expect(mocks.changeFindMany).not.toHaveBeenCalled();
    expect(mocks.approvalFindMany).not.toHaveBeenCalled();
    expect(mocks.beat).not.toHaveBeenCalled();
    expect(mocks.claimPeriodic).not.toHaveBeenCalled();
    expect(mocks.changeDeleteMany).not.toHaveBeenCalled();
  });

  it("returns 0 without any query when GA_SYNC is off", async () => {
    vi.stubEnv("GA_SYNC", "false");
    expect(await runGaFixesDue(5, NOW)).toBe(0);
    expect(mocks.changeFindMany).not.toHaveBeenCalled();
  });

  it("beats and reports ok when there is nothing to do", async () => {
    expect(await runGaFixesDue(5, NOW)).toBe(0);
    expect(mocks.beat).toHaveBeenCalledWith("ga.fixes", NOW);
    expect(mocks.ok).toHaveBeenCalledWith("ga.fixes", NOW);
  });
});

describe("kural 1: süresi dolan öneri", () => {
  it("expires a PROPOSED row past expiresAt, its pending approval and its task", async () => {
    seed({
      PROPOSED: [change({ expiresAt: new Date(NOW.getTime() - HOUR) })],
    });
    mocks.approvalFindMany.mockResolvedValue([{ id: "a1", status: "PENDING" }]);

    expect(await runGaFixesDue(5, NOW)).toBe(1);

    expect(mocks.changeUpdateMany).toHaveBeenCalledWith({
      where: { id: "c1", status: "PROPOSED" },
      data: { status: "EXPIRED", openKey: null },
    });
    expect(mocks.approvalUpdateMany).toHaveBeenCalledWith({
      where: { id: "a1", status: "PENDING" },
      data: { status: "EXPIRED" },
    });
    expect(mocks.transition).toHaveBeenCalledWith("t1", "p1", "CANCELLED", {
      failureReason: "Approval expired",
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      "ga_config_change.expired",
      { changeId: "c1", kind: "KEY_EVENT_CREATE" },
      { workspaceId: "w1", projectId: "p1" },
    );
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it("does not touch a task that already finished", async () => {
    seed({
      PROPOSED: [change({ expiresAt: new Date(NOW.getTime() - HOUR) })],
    });
    mocks.approvalFindMany.mockResolvedValue([{ id: "a1", status: "PENDING" }]);
    mocks.taskFindFirst.mockResolvedValue({ status: "CANCELLED" });
    await runGaFixesDue(5, NOW);
    expect(mocks.transition).not.toHaveBeenCalled();
  });

  it("leaves a pending proposal alone while it is still valid", async () => {
    seed({ PROPOSED: [change()] });
    mocks.approvalFindMany.mockResolvedValue([{ id: "a1", status: "PENDING" }]);
    expect(await runGaFixesDue(5, NOW)).toBe(0);
    expect(mocks.changeUpdateMany).not.toHaveBeenCalled();
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it("does not claim the audit when another process closed the row first", async () => {
    seed({
      PROPOSED: [change({ expiresAt: new Date(NOW.getTime() - HOUR) })],
    });
    mocks.approvalFindMany.mockResolvedValue([{ id: "a1", status: "PENDING" }]);
    mocks.changeUpdateMany.mockResolvedValue({ count: 0 });
    await runGaFixesDue(5, NOW);
    expect(mocks.approvalUpdateMany).not.toHaveBeenCalled();
    expect(mocks.transition).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});

describe("kural 2: karar satıra yansır", () => {
  it.each(["REJECTED", "REVISION_REQUESTED", "CANCELLED", "EXPIRED"])(
    "syncs a PROPOSED row whose approval is %s, without applying",
    async (approvalStatus) => {
      seed({ PROPOSED: [change()] });
      mocks.approvalFindMany.mockResolvedValue([
        { id: "a1", status: approvalStatus },
      ]);
      expect(await runGaFixesDue(5, NOW)).toBe(1);
      expect(mocks.sync).toHaveBeenCalledWith("c1");
      expect(mocks.apply).not.toHaveBeenCalled();
    },
  );

  it("closes an overdue row whose approval row is missing", async () => {
    seed({
      PROPOSED: [
        change({ approvalId: null, expiresAt: new Date(NOW.getTime() - HOUR) }),
      ],
    });
    expect(await runGaFixesDue(5, NOW)).toBe(1);
    expect(mocks.changeUpdateMany).toHaveBeenCalledWith({
      where: { id: "c1", status: "PROPOSED" },
      data: { status: "EXPIRED", openKey: null },
    });
    expect(mocks.approvalUpdateMany).not.toHaveBeenCalled();
  });
});

describe("kural 3: başka yoldan onaylanmış", () => {
  it("syncs then applies, even after the proposal expiresAt", async () => {
    seed({
      PROPOSED: [change({ expiresAt: new Date(NOW.getTime() - 2 * HOUR) })],
    });
    mocks.approvalFindMany.mockResolvedValue([
      { id: "a1", status: "APPROVED" },
    ]);
    const order: string[] = [];
    mocks.sync.mockImplementation(async () => {
      order.push("sync");
      return "APPROVED";
    });
    mocks.apply.mockImplementation(async () => {
      order.push("apply");
      return { state: "verified" };
    });

    expect(await runGaFixesDue(5, NOW)).toBe(1);
    expect(order).toEqual(["sync", "apply"]);
    expect(mocks.apply).toHaveBeenCalledWith("c1");
    expect(mocks.changeUpdateMany).not.toHaveBeenCalled();
  });
});

describe("kural 4: vadesi gelmiş APPROVED", () => {
  it("applies APPROVED rows that are free and due", async () => {
    seed({ APPROVED: [change({ status: "APPROVED", approvedAt: NOW })] });
    expect(await runGaFixesDue(5, NOW)).toBe(1);
    expect(mocks.apply).toHaveBeenCalledWith("c1");
    const query = findManyFor("APPROVED");
    expect(query.where).toMatchObject({
      status: "APPROVED",
      approvedAt: { gte: new Date(NOW.getTime() - 14 * DAY) },
      AND: [
        { OR: [{ leaseUntil: null }, { leaseUntil: { lt: NOW } }] },
        { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: NOW } }] },
      ],
    });
  });

  it("does not select alpha kinds while the kill switch is off", async () => {
    vi.stubEnv("GA_FIXES_ALPHA", "false");
    await runGaFixesDue(5, NOW);
    const kinds = (findManyFor("APPROVED").where as { kind: { in: string[] } })
      .kind.in;
    expect(kinds).toEqual(["KEY_EVENT_CREATE", "RETENTION_14M"]);
  });

  it("selects every kind when the kill switch is on", async () => {
    await runGaFixesDue(5, NOW);
    const kinds = (findManyFor("APPROVED").where as { kind: { in: string[] } })
      .kind.in;
    expect(kinds).toHaveLength(5);
  });

  it("keeps going when one apply throws", async () => {
    seed({
      APPROVED: [
        change({ id: "c1", status: "APPROVED" }),
        change({ id: "c2", status: "APPROVED" }),
      ],
    });
    mocks.apply.mockRejectedValueOnce(new Error("boom"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runGaFixesDue(5, NOW)).toBe(2);
    expect(mocks.apply).toHaveBeenCalledTimes(2);
    errors.mockRestore();
  });
});

describe("kural 5: kirası dolmuş APPLYING", () => {
  it("returns an unwritten change to APPROVED and a written one to APPLIED", async () => {
    seed({
      APPLYING: [
        change({ id: "c1", status: "APPLYING", appliedAt: null }),
        change({ id: "c2", status: "APPLYING", appliedAt: NOW }),
      ],
    });
    expect(await runGaFixesDue(5, NOW)).toBe(2);
    expect(findManyFor("APPLYING").where).toMatchObject({
      leaseUntil: { lt: NOW },
    });
    expect(mocks.changeUpdateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["c1"] },
        status: "APPLYING",
        leaseUntil: { lt: NOW },
        appliedAt: null,
      },
      data: { status: "APPROVED", leaseUntil: null, leaseOwner: null },
    });
    expect(mocks.changeUpdateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["c2"] },
        status: "APPLYING",
        leaseUntil: { lt: NOW },
        appliedAt: { not: null },
      },
      data: { status: "APPLIED", leaseUntil: null, leaseOwner: null },
    });
  });
});

describe("kural 6: boş kiralı APPLIED", () => {
  it("selects every kind for read-back even while the alpha kill switch is off", async () => {
    vi.stubEnv("GA_FIXES_ALPHA", "false");
    await runGaFixesDue(5, NOW);
    const kinds = (findManyFor("APPLIED").where as { kind: { in: string[] } })
      .kind.in;
    expect(kinds).toHaveLength(5);
  });

  it("runs a read-back-only apply for a free APPLIED row", async () => {
    seed({ APPLIED: [change({ status: "APPLIED", appliedAt: NOW })] });
    expect(await runGaFixesDue(5, NOW)).toBe(1);
    expect(mocks.apply).toHaveBeenCalledWith("c1");
    expect(findManyFor("APPLIED").where).toMatchObject({
      AND: [
        { OR: [{ leaseUntil: null }, { leaseUntil: { lt: NOW } }] },
        { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: NOW } }] },
      ],
    });
  });
});

describe("kural 7: kirası dolmuş UNDOING", () => {
  it("returns the change to VERIFIED", async () => {
    seed({ UNDOING: [change({ status: "UNDOING" })] });
    expect(await runGaFixesDue(5, NOW)).toBe(1);
    expect(mocks.changeUpdateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["c1"] },
        status: "UNDOING",
        leaseUntil: { lt: NOW },
      },
      data: { status: "VERIFIED", leaseUntil: null, leaseOwner: null },
    });
  });
});

describe("kural 8: 14 gündür uygulanmamış onay", () => {
  it("expires the row, cancels the task and does not apply it", async () => {
    seed({
      STALE: [
        change({
          status: "APPROVED",
          approvedAt: new Date(NOW.getTime() - 15 * DAY),
        }),
      ],
    });
    expect(await runGaFixesDue(5, NOW)).toBe(1);
    expect(mocks.apply).not.toHaveBeenCalled();
    const query = mocks.changeFindMany.mock.calls
      .map(([args]) => args as { where: Row })
      .find((args) => {
        const approvedAt = args.where.approvedAt as { lt?: Date } | undefined;
        return approvedAt?.lt !== undefined;
      });
    expect(query?.where.approvedAt).toEqual({
      lt: new Date(NOW.getTime() - 14 * DAY),
    });
    expect(mocks.changeUpdateMany).toHaveBeenCalledWith({
      where: { id: "c1", status: "APPROVED" },
      data: {
        status: "EXPIRED",
        openKey: null,
        leaseUntil: null,
        leaseOwner: null,
      },
    });
    expect(mocks.transition).toHaveBeenCalledWith("t1", "p1", "CANCELLED", {
      failureReason: "Change was not applied",
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      "ga_config_change.expired",
      expect.objectContaining({ changeId: "c1" }),
      expect.anything(),
    );
  });
});

describe("tur bütçesi", () => {
  it("handles at most `limit` rows in total", async () => {
    const overdue = new Date(NOW.getTime() - HOUR);
    seed({
      PROPOSED: [
        change({ id: "c1", expiresAt: overdue }),
        change({ id: "c2", expiresAt: overdue }),
        change({ id: "c3", expiresAt: overdue }),
      ],
      APPROVED: [change({ id: "c4", status: "APPROVED" })],
    });
    mocks.approvalFindMany.mockResolvedValue([{ id: "a1", status: "PENDING" }]);
    expect(await runGaFixesDue(2, NOW)).toBe(2);
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("passes the remaining budget as the candidate take", async () => {
    seed({ UNDOING: [] });
    await runGaFixesDue(3, NOW);
    expect(findManyFor("UNDOING").take).toBe(3);
  });
});

describe("kural 9: günlük temizlik", () => {
  it("deletes terminal rows older than 24 months when the claim is won", async () => {
    mocks.claimPeriodic.mockResolvedValue(true);
    await runGaFixesDue(5, NOW);
    expect(mocks.claimPeriodic).toHaveBeenCalledWith(
      "ga.fixes.housekeeping",
      24 * HOUR,
      NOW,
    );
    expect(mocks.changeDeleteMany).toHaveBeenCalledWith({
      where: {
        status: { in: ["VERIFIED", "FAILED", "UNDONE", "REJECTED", "EXPIRED"] },
        createdAt: { lt: new Date("2024-10-07T12:00:00.000Z") },
      },
    });
  });

  it("does not delete when another process holds the daily claim", async () => {
    mocks.claimPeriodic.mockResolvedValue(false);
    await runGaFixesDue(5, NOW);
    expect(mocks.changeDeleteMany).not.toHaveBeenCalled();
  });

  it("never runs in a development process on a remote database", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@ep-live.neon.tech/db");
    vi.stubEnv("GA_SYNC_DEV_PROJECTS", "p1");
    mocks.claimPeriodic.mockResolvedValue(true);
    await runGaFixesDue(5, NOW);
    expect(mocks.claimPeriodic).not.toHaveBeenCalled();
    expect(mocks.changeDeleteMany).not.toHaveBeenCalled();
  });

  it("runs in a development process on a local database", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@localhost:5432/db");
    mocks.claimPeriodic.mockResolvedValue(true);
    await runGaFixesDue(5, NOW);
    expect(mocks.changeDeleteMany).toHaveBeenCalledTimes(1);
  });

  it("survives a failing delete", async () => {
    mocks.claimPeriodic.mockResolvedValue(true);
    mocks.changeDeleteMany.mockRejectedValue(new Error("db down"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(runGaFixesDue(5, NOW)).resolves.toBe(0);
    errors.mockRestore();
  });
});

describe("geliştirme izin listesi", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@ep-live.neon.tech/db");
    vi.stubEnv("GA_SYNC_DEV_PROJECTS", "p1, p9");
  });

  it("adds the allow-list to every candidate query", async () => {
    await runGaFixesDue(5, NOW);
    for (const [args] of mocks.changeFindMany.mock.calls) {
      expect((args as { where: Row }).where.projectId).toEqual({
        in: ["p1", "p9"],
      });
    }
    expect(mocks.changeFindMany.mock.calls.length).toBeGreaterThanOrEqual(6);
  });

  it("skips a row of a project outside the allow-list even if a query returns it", async () => {
    seed({
      APPROVED: [
        change({ id: "c1", projectId: "other", status: "APPROVED" }),
        change({ id: "c2", projectId: "p1", status: "APPROVED" }),
      ],
    });
    expect(await runGaFixesDue(5, NOW)).toBe(1);
    expect(mocks.apply).toHaveBeenCalledTimes(1);
    expect(mocks.apply).toHaveBeenCalledWith("c2");
  });

  it("adds no project filter on live (no allow-list)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await runGaFixesDue(5, NOW);
    for (const [args] of mocks.changeFindMany.mock.calls) {
      expect((args as { where: Row }).where.projectId).toBeUndefined();
    }
  });
});
