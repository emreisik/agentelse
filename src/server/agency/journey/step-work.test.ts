import { beforeEach, describe, expect, it, vi } from "vitest";

import type { JourneySnapshot, NextStep } from "@/lib/journey";

const prisma = vi.hoisted(() => ({ command: { findFirst: vi.fn() } }));
vi.mock("@/lib/prisma", () => ({ prisma }));

const { workIdOfStep } = await import("./step-work");

const snapshot = (items: JourneySnapshot["items"]): JourneySnapshot =>
  ({ today: "2026-10-02", items, connections: {}, publishScheduleEnabled: false, results: [] }) as unknown as JourneySnapshot;
const step = (action: NextStep["action"]): NextStep => ({
  key: "k",
  tone: "next",
  label: "L",
  title: "T",
  action,
});
const piece = (id: string, planId: string, date: string) => ({
  id,
  planId,
  stage: "IN_REVIEW" as const,
  publish: "manual" as const,
  date,
  title: id,
});

beforeEach(() => {
  vi.clearAllMocks();
  prisma.command.findFirst.mockResolvedValue({ workId: "w1" });
});

describe("workIdOfStep", () => {
  it("is the Work of the plan the step is about, read for this project only", async () => {
    const out = await workIdOfStep(
      "p1",
      snapshot([piece("c1", "planA", "2026-10-05")]),
      step({ kind: "produce_plan", planId: "planA", count: 1 }),
    );
    expect(out).toBe("w1");
    expect(prisma.command.findFirst).toHaveBeenCalledWith({
      where: { id: "planA", projectId: "p1" },
      select: { workId: true },
    });
  });

  it("uses the newest plan for a step about the plan as a whole", async () => {
    await workIdOfStep(
      "p1",
      snapshot([piece("c1", "planA", "2026-10-05"), piece("c2", "planB", "2026-10-20")]),
      step({ kind: "plan_next", afterDate: "2026-10-20" }),
    );
    expect(prisma.command.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "planB", projectId: "p1" } }),
    );
  });

  it("is undefined for a plan that belongs to no Work, a missing plan, no plans, or a failed read", async () => {
    const s = snapshot([piece("c1", "planA", "2026-10-05")]);
    const action = step({ kind: "show_results", count: 1 });
    prisma.command.findFirst.mockResolvedValueOnce({ workId: null });
    expect(await workIdOfStep("p1", s, action)).toBeUndefined();
    prisma.command.findFirst.mockResolvedValueOnce(null);
    expect(await workIdOfStep("p1", s, action)).toBeUndefined();
    expect(await workIdOfStep("p1", snapshot([]), action)).toBeUndefined();
    expect(prisma.command.findFirst).toHaveBeenCalledTimes(2);
    prisma.command.findFirst.mockRejectedValueOnce(new Error("db"));
    expect(await workIdOfStep("p1", s, action)).toBeUndefined();
  });
});
