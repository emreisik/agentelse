import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

const { SETUP_STAGE_ORDER } = await import(
  "@/server/repositories/setup-state.repository"
);
const {
  DISCOVERY_COMPLETION_RATIO,
  DISCOVERY_STAGE_TIMEOUT_MS,
  ENRICHMENT_SKIPPED_STAGES,
  discoveryVerdict,
} = await import("./setup-stages");

describe("ENRICHMENT_SKIPPED_STAGES", () => {
  it("skips exactly the stages that only fed the legacy agency pipeline", () => {
    expect([...ENRICHMENT_SKIPPED_STAGES].sort()).toEqual(
      [
        "AGENCY_CONFIGURATION",
        "AUTONOMY_CONFIGURATION",
        "BASELINE_AUDITS",
        "INITIAL_IDEA_PORTFOLIO",
        "INITIAL_OPPORTUNITIES",
        "INITIAL_WORK_PLAN",
      ].sort(),
    );
  });

  it("only names real stages and never the ones an enrichment exists to run", () => {
    for (const stage of ENRICHMENT_SKIPPED_STAGES) {
      expect(SETUP_STAGE_ORDER).toContain(stage);
    }
    for (const kept of [
      "INTAKE",
      "DEEP_DISCOVERY",
      "BRAND_CONSTITUTION",
      "SIGNAL_PROFILE",
      "GOAL_GENERATION",
      "PROJECT_ACTIVATION",
    ]) {
      expect(ENRICHMENT_SKIPPED_STAGES.has(kept), kept).toBe(false);
    }
  });
});

describe("discoveryVerdict", () => {
  const NOW = new Date("2026-10-01T12:00:00Z");
  const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
  const task = (status: string, minutesAgo = 1) => ({
    status,
    createdAt: ago(minutesAgo),
  });
  const verdict = (tasks: ReturnType<typeof task>[]) =>
    discoveryVerdict({
      tasks,
      ratio: DISCOVERY_COMPLETION_RATIO,
      timeoutMs: DISCOVERY_STAGE_TIMEOUT_MS,
      now: NOW,
    });

  it("waits while no research task exists yet", () => {
    expect(verdict([])).toBe("WAIT");
  });

  it("completes when every task produced a result", () => {
    expect(verdict(Array(6).fill(task("COMPLETED")))).toBe("COMPLETE");
  });

  it("completes once enough tasks ended and at least one produced a result", () => {
    // 5 of 6 ended (0.83 >= 0.8), one still running.
    expect(
      verdict([...Array(5).fill(task("COMPLETED")), task("RUNNING")]),
    ).toBe("COMPLETE");
  });

  it("waits while too few tasks have ended", () => {
    // 4 of 6 ended (0.67 < 0.8).
    expect(
      verdict([...Array(4).fill(task("COMPLETED")), task("RUNNING"), task("QUEUED")]),
    ).toBe("WAIT");
  });

  it("completes with partial data when the rest failed but something did complete", () => {
    expect(
      verdict([task("COMPLETED"), ...Array(5).fill(task("FAILED"))]),
    ).toBe("COMPLETE");
  });

  it("FAILS when every task ended and none produced a result (this used to hang forever)", () => {
    expect(verdict(Array(6).fill(task("FAILED")))).toBe("FAILED");
  });

  it("counts a cancelled task as ended, and a mix of failed and cancelled as a failure", () => {
    expect(
      verdict([...Array(3).fill(task("FAILED")), ...Array(3).fill(task("CANCELLED"))]),
    ).toBe("FAILED");
  });

  it("keeps waiting while tasks are still running and none has completed yet", () => {
    expect(verdict(Array(6).fill(task("RUNNING", 5)))).toBe("WAIT");
  });

  it("FAILS when the wait ran out and nothing completed", () => {
    const stale = DISCOVERY_STAGE_TIMEOUT_MS / 60_000 + 5;
    expect(verdict(Array(6).fill(task("RUNNING", stale)))).toBe("FAILED");
  });

  it("moves on with what it has when the wait ran out but some tasks completed and others hung", () => {
    const stale = DISCOVERY_STAGE_TIMEOUT_MS / 60_000 + 5;
    expect(
      verdict([
        ...Array(3).fill(task("COMPLETED", stale)),
        ...Array(3).fill(task("RUNNING", stale)),
      ]),
    ).toBe("COMPLETE");
  });

  it("starts the clock at the newest task, so a retry is not timed out by its first attempt", () => {
    // Six tasks from a failed first attempt two hours ago, and a fresh retry
    // wave a minute ago that is still running. The stage's own startedAt would
    // say "two hours"; the verdict must not.
    expect(
      verdict([
        ...Array(6).fill(task("FAILED", 120)),
        ...Array(6).fill(task("RUNNING", 1)),
      ]),
    ).toBe("WAIT");
  });

  it("times out only strictly after the limit", () => {
    const limitMinutes = DISCOVERY_STAGE_TIMEOUT_MS / 60_000;
    expect(verdict(Array(6).fill(task("RUNNING", limitMinutes)))).toBe("WAIT");
    expect(verdict(Array(6).fill(task("RUNNING", limitMinutes + 1)))).toBe(
      "FAILED",
    );
  });
});
