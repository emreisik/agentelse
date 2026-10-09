import { beforeEach, describe, expect, it, vi } from "vitest";

// What this suite proves about one piece of a live production run (content
// package, content plan) when the plan allowance cannot pay for it: the job
// settles as WAITING_BUDGET and the piece must be reported as PAUSED, with the
// limit-notice card, and counted as planned and not failed. It must never say
// "ready" or "still being made in the background" (docs/billing-tasks.md, "Park
// (WAITING_BUDGET) ve devam"). The helpers themselves (isParked, describePause)
// are parked-job.test.ts's subject; here only the sizing of the job is stubbed.

const prismaMock = vi.hoisted(() => ({
  executionJob: { findUnique: vi.fn() },
  usageBalance: { findUnique: vi.fn().mockResolvedValue(null) },
  command: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

const planForCapability = vi.hoisted(() => vi.fn());
vi.mock("@/server/commands/task-planner", () => ({
  TaskPlanner: { planForCapability },
}));

// Running a job inline is inline-job.test.ts's subject; here it just settles.
const driveJobInline = vi.hoisted(() => vi.fn());
vi.mock("./inline-job", () => ({ driveJobInline }));

const subscribeCreativeProgress = vi.hoisted(() => vi.fn());
vi.mock("@/server/media/creative-progress", () => ({
  subscribeCreativeProgress,
}));

// Which allowance a job needs is usage-need's subject (provider-usage-
// declarations.test.ts); it also drags in the providers.
const usageNeedOf = vi.hoisted(() => vi.fn());
vi.mock("@/server/execution/usage-need", () => ({ usageNeedOf }));

const { runProductionItem } = await import("./production-run");

import type { ProductionContext, ProductionSpec } from "./production-run";
import type { ChatStreamEvent } from "./types";

const spec: ProductionSpec = {
  itemId: "item-1",
  title: "Autumn menu",
  label: "Instagram post",
  department: "CREATIVE",
  capability: "CREATE_SOCIAL_CREATIVE",
  targetPlatform: "INSTAGRAM",
  request: "A post about the autumn menu",
  logPrefix: "[parked-test]",
};

const input: ProductionContext = {
  workspaceId: "ws-1",
  projectId: "proj-1",
  brandId: "brand-1",
  userId: "user-1",
  commandId: "cmd-1",
  // No waiting for a final card: a paused piece has none.
  finalCardPolls: { tries: 0, everyMs: 0 },
};

const PARKED = { status: "WAITING_BUDGET", errorMessage: null };
const unsubscribe = vi.fn();
const emit = vi.fn<(event: ChatStreamEvent) => void>();

const events = (): ChatStreamEvent[] => emit.mock.calls.map(([event]) => event);
const doneEvents = () =>
  events().filter(
    (event): event is Extract<ChatStreamEvent, { type: "item.done" }> =>
      event.type === "item.done",
  );

beforeEach(() => {
  vi.clearAllMocks();
  planForCapability.mockResolvedValue({
    task: { id: "task-1", riskLevel: "LOW" },
    dispatched: true,
    job: { id: "job-1" },
  });
  driveJobInline.mockResolvedValue(PARKED);
  subscribeCreativeProgress.mockReturnValue(unsubscribe);
  usageNeedOf.mockReturnValue({ unit: "IMAGE", amount: BigInt(1) });
  prismaMock.executionJob.findUnique.mockResolvedValue({
    errorCode: "QUOTA_EXCEEDED",
    capability: "CREATE_SOCIAL_CREATIVE",
    requestPayload: { request: "x" },
  });
  prismaMock.command.findFirst.mockResolvedValue(null);
});

describe("runProductionItem with a job the plan cannot pay for", () => {
  it("reports the piece as paused, with the limit-notice card", async () => {
    const outcome = await runProductionItem(spec, input, emit);

    expect(driveJobInline).toHaveBeenCalledWith("job-1", "LOW");
    // The card says why THIS job waits: it is read from the job row.
    expect(prismaMock.executionJob.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "job-1" } }),
    );
    expect(events().map((event) => event.type)).toEqual([
      "item.start",
      "item.done",
    ]);
    const [done] = doneEvents();
    expect(done).toMatchObject({
      type: "item.done",
      itemId: "item-1",
      ok: true,
      card: { kind: "limit-notice", reason: "allowance-used", unit: "IMAGE" },
    });
    expect(done?.reply).toContain("Instagram post is paused");
    expect(done?.reply).toContain("plan allowance");
    expect(done?.reply).toContain("continues by itself");
    expect(outcome).toEqual({ itemId: "item-1", planned: true, ok: true });
  });

  it.each([
    ["QUOTA_EXCEEDED", "allowance-used"],
    ["NO_PLAN", "no-plan"],
  ] as const)("shows the %s story on the card", async (errorCode, reason) => {
    prismaMock.executionJob.findUnique.mockResolvedValue({
      errorCode,
      capability: "CREATE_SOCIAL_CREATIVE",
      requestPayload: { request: "x" },
    });

    await runProductionItem(spec, input, emit);

    expect(doneEvents()[0]?.card).toMatchObject({
      kind: "limit-notice",
      reason,
    });
  });

  it("never says the piece is ready or still being made", async () => {
    const outcome = await runProductionItem(spec, input, emit);

    const done = doneEvents();
    expect(done).toHaveLength(1);
    const reply = done[0]?.reply ?? "";
    expect(reply).not.toContain("still being made");
    expect(reply).not.toContain("in the background");
    expect(reply).not.toMatch(/\bready\b/i);
    expect(reply).not.toContain("Could not make");
    // Not a failure, and nothing to wait for or look up: no final card exists.
    expect(done[0]?.ok).toBe(true);
    expect(done[0]).not.toHaveProperty("commandId");
    expect(prismaMock.command.findFirst).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(true);
  });
});
