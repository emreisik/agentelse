import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskRepository } from "@/server/repositories/task.repository";
import { Heartbeat } from "@/server/observability/heartbeat";

import { applySeoChange } from "./apply";
import { syncSeoChangeApprovalState } from "./approval-hook";
import {
  ENV_KEYS,
  NOW,
  addChange,
  change,
  fake,
  fakePrisma,
  resetFake,
} from "./apply.testkit";
import { recordSeoApplyAudit } from "./audit";
import { SeoIndexNow } from "./indexnow";
import { runSeoApplyDue } from "./reconcile";
import { SeoApplyRetention } from "./retention";

// Bu dosyanın kanıtladığı (SC-F8 uzlaştırma): bayrak kapalıyken tek sorgu bile
// yok; PROPOSED satırlar Approval SATIRI okunarak kapanır ya da onaylanır;
// 14 günlük bayat APPROVED EXPIRED olur; kirası dolan APPLYING/UNDOING motor
// tablosuna göre geri döner; vadesi gelen APPROVED/APPLIED satırlar uygulanır;
// izin listesi WHERE'de uygulanır; canlı veritabanını paylaşan dev süreci genel
// iş (nabız, IndexNow, saklama) yapmaz.

vi.mock("@/lib/prisma", async () => ({
  prisma: (await import("./apply.testkit")).fakePrisma,
}));
vi.mock("./apply", () => ({
  applySeoChange: vi.fn(async () => ({ state: "verified" })),
}));
vi.mock("./approval-hook", () => ({
  syncSeoChangeApprovalState: vi.fn(async () => "APPROVED"),
}));
vi.mock("./audit", () => ({
  recordSeoApplyAudit: vi.fn(async () => undefined),
}));
vi.mock("./indexnow", () => ({
  SeoIndexNow: { flushDue: vi.fn(async () => 0) },
}));
vi.mock("./retention", () => ({
  SeoApplyRetention: { runDue: vi.fn(async () => 0) },
}));
vi.mock("@/server/observability/heartbeat", () => ({
  Heartbeat: {
    beat: vi.fn(async () => undefined),
    ok: vi.fn(async () => undefined),
  },
}));
vi.mock("@/server/repositories/task.repository", () => ({
  TaskRepository: { transition: vi.fn(async () => ({})) },
}));

const saved: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) saved[key] = process.env[key];

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

function ahead(ms: number): Date {
  return new Date(NOW.getTime() + ms);
}

function setApproval(id: string, status: string): void {
  fake.approvals.set(id, { id, status, expiresAt: null });
}

function anyPrismaCall(): boolean {
  return [
    fakePrisma.seoChange.findMany,
    fakePrisma.seoChange.updateMany,
    fakePrisma.approval.findMany,
    fakePrisma.task.findFirst,
  ].some((fn) => fn.mock.calls.length > 0);
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SEO_APPLY = "true";
  process.env.SEO_HEALTH = "true";
  process.env.AGENTELSE_PROVIDER_MODE = "mock";
  delete process.env.SEO_DEV_PROJECTS;
  delete process.env.SEO_ROLLOUT_PROJECTS;
  resetFake({ change: null });
});

describe("flag off", () => {
  it("returns 0 before any database call or heartbeat", async () => {
    process.env.SEO_APPLY = "false";
    addChange({ status: "APPROVED" });

    await expect(runSeoApplyDue(5, NOW)).resolves.toBe(0);

    expect(anyPrismaCall()).toBe(false);
    expect(Heartbeat.beat).not.toHaveBeenCalled();
    expect(applySeoChange).not.toHaveBeenCalled();
    expect(SeoIndexNow.flushDue).not.toHaveBeenCalled();
    expect(SeoApplyRetention.runDue).not.toHaveBeenCalled();
  });

  it("is also off without SEO_HEALTH", async () => {
    process.env.SEO_HEALTH = "false";
    await expect(runSeoApplyDue(5, NOW)).resolves.toBe(0);
    expect(anyPrismaCall()).toBe(false);
  });
});

describe("PROPOSED rows follow the Approval row", () => {
  function proposed(id: string, extra: Record<string, unknown> = {}) {
    addChange({
      id,
      status: "PROPOSED",
      approvalId: `appr-${id}`,
      expiresAt: ahead(3 * DAY),
      ...extra,
    });
  }

  it.each(["REJECTED", "REVISION_REQUESTED", "CANCELLED", "EXPIRED", "APPROVED"])(
    "syncs a PROPOSED row whose Approval is %s",
    async (status) => {
      proposed("a");
      setApproval("appr-a", status);

      const done = await runSeoApplyDue(5, NOW);

      expect(syncSeoChangeApprovalState).toHaveBeenCalledWith("a", { now: NOW });
      expect(done).toBe(1);
    },
  );

  it("leaves a PENDING, not overdue proposal alone", async () => {
    proposed("a");
    setApproval("appr-a", "PENDING");
    await runSeoApplyDue(5, NOW);
    expect(syncSeoChangeApprovalState).not.toHaveBeenCalled();
    expect(change("a").status).toBe("PROPOSED");
  });

  it("syncs a PENDING proposal once its expiry passed (the Approval row decides)", async () => {
    proposed("a", { expiresAt: ago(MINUTE) });
    setApproval("appr-a", "PENDING");
    await runSeoApplyDue(5, NOW);
    expect(syncSeoChangeApprovalState).toHaveBeenCalledWith("a", { now: NOW });
  });

  it("syncs a proposal whose Approval row is gone", async () => {
    proposed("a");
    await runSeoApplyDue(5, NOW);
    expect(syncSeoChangeApprovalState).toHaveBeenCalledWith("a", { now: NOW });
  });

  it("expires an overdue proposal that never got an approval and cancels its Task", async () => {
    proposed("a", { approvalId: null, expiresAt: ago(MINUTE), taskId: "task-a" });
    fake.task = { id: "task-a", status: "WAITING_APPROVAL" };

    await runSeoApplyDue(5, NOW);

    expect(change("a").status).toBe("EXPIRED");
    expect(change("a").openKey).toBeNull();
    expect(TaskRepository.transition).toHaveBeenCalledWith(
      "task-a",
      "proj-1",
      "CANCELLED",
      { failureReason: "Approval expired" },
    );
    expect(recordSeoApplyAudit).toHaveBeenCalledWith(
      "seo_change.expired",
      { changeId: "a", kind: "TITLE_META" },
      { workspaceId: "ws-1", projectId: "proj-1" },
    );
  });

  it("keeps an approval-less proposal that is not overdue", async () => {
    proposed("a", { approvalId: null });
    await runSeoApplyDue(5, NOW);
    expect(change("a").status).toBe("PROPOSED");
  });
});

describe("APPROVED rows", () => {
  it("expires an approved row that was not applied for 14 days", async () => {
    addChange({ id: "old", status: "APPROVED", approvedAt: ago(15 * DAY) });
    fake.task = { id: "task-1", status: "RUNNING" };

    await runSeoApplyDue(5, NOW);

    expect(change("old").status).toBe("EXPIRED");
    expect(change("old").openKey).toBeNull();
    expect(applySeoChange).not.toHaveBeenCalled();
    expect(TaskRepository.transition).toHaveBeenCalledWith(
      "task-1",
      "proj-1",
      "CANCELLED",
      { failureReason: "Change was not applied" },
    );
  });

  it("applies due APPROVED and APPLIED rows only", async () => {
    addChange({ id: "due", status: "APPROVED", approvedAt: ago(DAY) });
    addChange({ id: "waiting", status: "APPROVED", nextAttemptAt: ahead(MINUTE) });
    addChange({ id: "leased", status: "APPROVED", leaseUntil: ahead(MINUTE) });
    addChange({ id: "resume", status: "APPLIED", appliedAt: ago(MINUTE) });
    addChange({ id: "real", status: "APPROVED", isMock: false });
    addChange({ id: "done", status: "VERIFIED" });

    const done = await runSeoApplyDue(10, NOW);

    const applied = vi.mocked(applySeoChange).mock.calls.map((call) => call[0]);
    expect(applied.sort()).toEqual(["due", "resume"]);
    expect(vi.mocked(applySeoChange).mock.calls[0]?.[1]).toEqual({ now: NOW });
    expect(done).toBe(2);
  });

  it("respects the per-run limit", async () => {
    for (const id of ["a", "b", "c", "d"]) {
      addChange({ id, status: "APPROVED", approvedAt: ago(DAY) });
    }
    const done = await runSeoApplyDue(2, NOW);
    expect(done).toBe(2);
    expect(applySeoChange).toHaveBeenCalledTimes(2);
  });

  it("keeps going when one apply throws", async () => {
    addChange({ id: "a", status: "APPROVED", approvedAt: ago(DAY) });
    addChange({ id: "b", status: "APPROVED", approvedAt: ago(DAY) });
    vi.mocked(applySeoChange).mockRejectedValueOnce(new Error("boom"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await runSeoApplyDue(5, NOW);
      expect(applySeoChange).toHaveBeenCalledTimes(2);
    } finally {
      error.mockRestore();
    }
  });
});

describe("expired leases", () => {
  it("returns APPLYING to APPROVED when nothing was written and to APPLIED when something was", async () => {
    addChange({
      id: "unwritten",
      status: "APPLYING",
      leaseUntil: ago(MINUTE),
      leaseOwner: "x",
      appliedAt: null,
    });
    addChange({
      id: "written",
      status: "APPLYING",
      leaseUntil: ago(MINUTE),
      leaseOwner: "x",
      appliedAt: ago(2 * MINUTE),
    });
    addChange({
      id: "live",
      status: "APPLYING",
      leaseUntil: ahead(MINUTE),
      leaseOwner: "y",
    });

    await runSeoApplyDue(10, NOW);

    expect(change("unwritten").status).toBe("APPROVED");
    expect(change("unwritten").leaseOwner).toBeNull();
    expect(change("written").status).toBe("APPLIED");
    expect(change("written").leaseUntil).toBeNull();
    expect(change("live").status).toBe("APPLYING");
  });

  it("returns UNDOING to VERIFIED when verifiedAt is set and to FAILED otherwise", async () => {
    addChange({
      id: "from-verified",
      status: "UNDOING",
      leaseUntil: ago(MINUTE),
      leaseOwner: "x",
      verifiedAt: ago(DAY),
      appliedAt: ago(DAY),
    });
    addChange({
      id: "from-failed",
      status: "UNDOING",
      leaseUntil: ago(MINUTE),
      leaseOwner: "x",
      verifiedAt: null,
      appliedAt: ago(DAY),
    });
    addChange({
      id: "running",
      status: "UNDOING",
      leaseUntil: ahead(MINUTE),
      leaseOwner: "y",
      verifiedAt: ago(DAY),
    });

    await runSeoApplyDue(10, NOW);

    expect(change("from-verified").status).toBe("VERIFIED");
    expect(change("from-failed").status).toBe("FAILED");
    expect(change("from-failed").leaseOwner).toBeNull();
    expect(change("running").status).toBe("UNDOING");
  });
});

describe("global work and the dev guard", () => {
  it("a normal process beats, flushes IndexNow, runs retention and signals ok", async () => {
    await runSeoApplyDue(5, NOW);
    expect(Heartbeat.beat).toHaveBeenCalledWith("seo.apply", NOW);
    expect(SeoIndexNow.flushDue).toHaveBeenCalledWith(NOW);
    expect(SeoApplyRetention.runDue).toHaveBeenCalledWith(NOW);
    expect(Heartbeat.ok).toHaveBeenCalledWith("seo.apply", NOW);
  });

  it("a dev process sharing the live database claims no global work and only sees allow-listed projects", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@ep-live.example.com:5432/live");
    vi.stubEnv("SEO_DEV_PROJECTS", "p-allowed");
    try {
      addChange({
        id: "mine",
        projectId: "p-allowed",
        status: "APPROVED",
        approvedAt: ago(DAY),
      });
      addChange({
        id: "theirs",
        projectId: "p-other",
        status: "APPROVED",
        approvedAt: ago(DAY),
      });

      await runSeoApplyDue(10, NOW);

      expect(vi.mocked(applySeoChange).mock.calls.map((call) => call[0])).toEqual([
        "mine",
      ]);
      // İzin listesi WHERE'de: her aday sorgusu projectId in [...] taşır.
      for (const call of fakePrisma.seoChange.findMany.mock.calls) {
        const where = (call[0] as { where: { projectId?: { in: string[] } } })
          .where;
        expect(where.projectId).toEqual({ in: ["p-allowed"] });
      }
      expect(Heartbeat.beat).not.toHaveBeenCalled();
      expect(Heartbeat.ok).not.toHaveBeenCalled();
      expect(SeoIndexNow.flushDue).not.toHaveBeenCalled();
      expect(SeoApplyRetention.runDue).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("a dev process with an empty allow list touches nothing", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@ep-live.example.com:5432/live");
    vi.stubEnv("SEO_DEV_PROJECTS", "");
    try {
      addChange({ id: "theirs", status: "APPROVED", approvedAt: ago(DAY) });
      await runSeoApplyDue(10, NOW);
      expect(applySeoChange).not.toHaveBeenCalled();
      expect(change("theirs").status).toBe("APPROVED");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("staged rollout restricts every candidate query to the rollout projects", async () => {
    process.env.SEO_ROLLOUT_PROJECTS = "p-1";
    addChange({ id: "in", projectId: "p-1", status: "APPROVED" });
    addChange({ id: "out", projectId: "p-2", status: "APPROVED" });

    await runSeoApplyDue(10, NOW);

    expect(vi.mocked(applySeoChange).mock.calls.map((call) => call[0])).toEqual([
      "in",
    ]);
  });
});
