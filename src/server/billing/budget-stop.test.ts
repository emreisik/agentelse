import { beforeEach, describe, expect, it, vi } from "vitest";

// Which sentence a "the AI budget is used up" refusal gets on the surfaces that cannot tell
// the cause apart (ideas board, SEO content plan, brand-term suggestions): the daily
// counter's ("comes tomorrow / raise it in Settings") or the PLAN's (renews with the period,
// add more in Plan & usage). It looks at the workspace's state NOW and never throws.

const mocks = vi.hoisted(() => ({
  mode: "enforce" as "off" | "shadow" | "enforce",
  getEntitlements: vi.fn(),
  getUsageView: vi.fn(),
  projectFind: vi.fn(),
}));

vi.mock("./config", () => ({
  getBillingConfig: () => ({
    mode: mocks.mode,
    legacyBefore: null,
    legacyUntil: null,
  }),
}));
vi.mock("./entitlements", () => ({ getEntitlements: mocks.getEntitlements }));
vi.mock("./ledger", () => ({ getUsageView: mocks.getUsageView }));
vi.mock("@/lib/prisma", () => ({
  prisma: { project: { findUnique: mocks.projectFind } },
}));

const {
  budgetMessage,
  budgetMessageForProject,
  budgetStopCause,
  budgetStopMessage,
} = await import("./budget-stop");

const DAILY = "Today's AI limit is reached. New ideas come tomorrow.";
const NOW = new Date("2026-10-20T12:00:00.000Z");

const full = (extra: object = {}) => ({
  access: "FULL",
  reason: "ACTIVE",
  unlimited: false,
  ...extra,
});
const view = (unit: string, available: number, endsAt: string | null) => ({
  unit,
  available,
  period: { endsAt },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mode = "enforce";
  mocks.getEntitlements.mockResolvedValue(full());
  mocks.getUsageView.mockResolvedValue([
    view("IMAGE", 10, "2026-11-01T00:00:00.000Z"),
    view("AI_MICROS", 5_000_000, "2026-11-01T00:00:00.000Z"),
  ]);
  mocks.projectFind.mockResolvedValue({ workspaceId: "ws-1" });
});

describe("budgetStopCause", () => {
  it("while limits are not enforced it is always the daily counter, and nothing is read", async () => {
    for (const mode of ["off", "shadow"] as const) {
      mocks.mode = mode;
      expect(await budgetStopCause("ws-1", NOW)).toEqual({ kind: "daily" });
    }
    expect(mocks.getEntitlements).not.toHaveBeenCalled();
    expect(mocks.getUsageView).not.toHaveBeenCalled();
  });

  it("is the plan when the AI usage of the period is gone, with the renewal date", async () => {
    mocks.getUsageView.mockResolvedValue([
      view("IMAGE", 10, "2026-11-01T00:00:00.000Z"),
      view("AI_MICROS", 0, "2026-11-01T00:00:00.000Z"),
    ]);

    expect(await budgetStopCause("ws-1", NOW)).toEqual({
      kind: "allowance",
      resetsAt: "2026-11-01T00:00:00.000Z",
    });
  });

  it("is still the daily counter while AI usage is left, even if the image credits are gone", async () => {
    mocks.getUsageView.mockResolvedValue([
      view("IMAGE", 0, "2026-11-01T00:00:00.000Z"),
      view("AI_MICROS", 2_000_000, "2026-11-01T00:00:00.000Z"),
    ]);

    expect(await budgetStopCause("ws-1", NOW)).toEqual({ kind: "daily" });
  });

  it("is 'no plan' when the workspace may not start paid work at all", async () => {
    mocks.getEntitlements.mockResolvedValue(
      full({ access: "READ_ONLY", reason: "TRIAL_ENDED" }),
    );

    expect(await budgetStopCause("ws-1", NOW)).toEqual({ kind: "no-plan" });
    expect(mocks.getUsageView).not.toHaveBeenCalled();
  });

  it("an existing customer without limits (or a read that failed) can only be the daily counter", async () => {
    mocks.getEntitlements.mockResolvedValue(
      full({ unlimited: true, reason: "LEGACY" }),
    );
    expect(await budgetStopCause("ws-1", NOW)).toEqual({ kind: "daily" });

    // A degraded read is "closed" for safety, but it says nothing about the plan.
    mocks.getEntitlements.mockResolvedValue(
      full({ access: "READ_ONLY", reason: "DEGRADED" }),
    );
    expect(await budgetStopCause("ws-1", NOW)).toEqual({ kind: "daily" });
  });

  it("never throws: a failing read keeps the old (daily) story", async () => {
    mocks.getEntitlements.mockRejectedValue(new Error("db down"));
    expect(await budgetStopCause("ws-1", NOW)).toEqual({ kind: "daily" });

    mocks.getEntitlements.mockResolvedValue(full());
    mocks.getUsageView.mockRejectedValue(new Error("db down"));
    expect(await budgetStopCause("ws-1", NOW)).toEqual({ kind: "daily" });
  });
});

describe("budgetStopMessage", () => {
  it("passes the surface's own sentence through for the daily counter", () => {
    expect(budgetStopMessage({ kind: "daily" }, DAILY)).toBe(DAILY);
  });

  it("says the plan's usage is used up and when it renews, never 'tomorrow' or 'Settings'", () => {
    const text = budgetStopMessage(
      { kind: "allowance", resetsAt: "2026-11-01T00:00:00.000Z" },
      DAILY,
    );

    expect(text).toContain("Your plan's AI usage for this period is used up");
    expect(text).toContain("renews on Nov 1");
    expect(text).toContain("Plan & usage");
    expect(text).not.toMatch(/tomorrow|Settings|midnight/i);
    expect(text).not.toMatch(/\$|token|micro/i);
  });

  it("without a renewal date it still makes sense", () => {
    const text = budgetStopMessage(
      { kind: "allowance", resetsAt: null },
      DAILY,
    );

    expect(text).not.toContain("renews on");
    expect(text).toContain("wait for the renewal");
  });

  it("tells a workspace without a plan to choose one", () => {
    const text = budgetStopMessage({ kind: "no-plan" }, DAILY);

    expect(text).toContain("no active plan");
    expect(text).toContain("Plan & usage");
  });
});

describe("budgetMessage / budgetMessageForProject", () => {
  it("picks the sentence from the workspace's state", async () => {
    mocks.getUsageView.mockResolvedValue([
      view("AI_MICROS", 0, "2026-11-01T00:00:00.000Z"),
    ]);

    expect(await budgetMessage("ws-1", DAILY)).toContain("used up");
    mocks.getUsageView.mockResolvedValue([
      view("AI_MICROS", 9, "2026-11-01T00:00:00.000Z"),
    ]);
    expect(await budgetMessage("ws-1", DAILY)).toBe(DAILY);
  });

  it("finds the workspace of a project, and does not even look while limits are off", async () => {
    mocks.getUsageView.mockResolvedValue([
      view("AI_MICROS", 0, "2026-11-01T00:00:00.000Z"),
    ]);
    expect(await budgetMessageForProject("proj-1", DAILY)).toContain("used up");
    expect(mocks.projectFind).toHaveBeenCalledWith({
      where: { id: "proj-1" },
      select: { workspaceId: true },
    });

    mocks.projectFind.mockClear();
    mocks.mode = "off";
    expect(await budgetMessageForProject("proj-1", DAILY)).toBe(DAILY);
    expect(mocks.projectFind).not.toHaveBeenCalled();
  });

  it("an unknown project or a failing lookup keeps the surface's own sentence", async () => {
    mocks.projectFind.mockResolvedValue(null);
    expect(await budgetMessageForProject("gone", DAILY)).toBe(DAILY);

    mocks.projectFind.mockRejectedValue(new Error("db down"));
    expect(await budgetMessageForProject("proj-1", DAILY)).toBe(DAILY);
  });
});
