import { beforeEach, describe, expect, it, vi } from "vitest";

// ensureProjectActive is what lets a project work without finishing setup, so
// what matters here: it walks the legal state-machine path (CREATED -> ACTIVE
// is not legal), it never undoes a PAUSED / CLOSED decision, and it cannot
// spin forever or throw when it loses a race.

let status = "CREATED";
let exists = true;
const findUnique = vi.fn(async () =>
  exists ? { workspaceId: "ws-1", status, brands: [{ id: "brand-1" }] } : null,
);
vi.mock("@/lib/prisma", () => ({ prisma: { project: { findUnique } } }));

const transition = vi.fn(
  async (_id: string, _workspaceId: string, to: string) => {
    status = to;
  },
);
vi.mock("@/server/repositories/project.repository", () => ({
  ProjectRepository: { transition },
}));

const policyGetOrCreate = vi.fn().mockResolvedValue({});
vi.mock("@/server/repositories/autonomy-policy.repository", () => ({
  AutonomyPolicyRepository: { getOrCreate: policyGetOrCreate },
}));

const loopGetOrCreate = vi.fn().mockResolvedValue({});
vi.mock("@/server/repositories/agency-loop-state.repository", () => ({
  AgencyLoopStateRepository: { getOrCreate: loopGetOrCreate },
}));

const auditRecord = vi.fn().mockResolvedValue(undefined);
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: auditRecord },
}));

const { ensureProjectActive } = await import("./activation");

const scope = { workspaceId: "ws-1", projectId: "proj-1", brandId: "brand-1" };

beforeEach(() => {
  vi.clearAllMocks();
  status = "CREATED";
  exists = true;
  transition.mockImplementation(async (_id, _workspaceId, to) => {
    status = to;
  });
  auditRecord.mockResolvedValue(undefined);
});

describe("ensureProjectActive", () => {
  it("leaves an already ACTIVE project alone but makes sure its loop rows exist", async () => {
    status = "ACTIVE";

    const result = await ensureProjectActive("proj-1");

    expect(result).toEqual({ status: "ACTIVE", usable: true });
    expect(transition).not.toHaveBeenCalled();
    expect(policyGetOrCreate).toHaveBeenCalledWith(scope);
    expect(loopGetOrCreate).toHaveBeenCalledWith(scope);
    // Nothing changed, so nothing to audit.
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it("walks CREATED through the legal states to ACTIVE, one transition at a time", async () => {
    const result = await ensureProjectActive("proj-1");

    expect(result).toEqual({ status: "ACTIVE", usable: true });
    expect(transition.mock.calls.map((call) => call[2])).toEqual([
      "DISCOVERY",
      "PROFILE_REVIEW",
      "ACTIVE",
    ]);
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "project.activated",
        metadata: { from: "CREATED", via: "ensureProjectActive" },
      }),
    );
  });

  it.each([
    ["DISCOVERY", ["PROFILE_REVIEW", "ACTIVE"]],
    ["NEEDS_INFORMATION", ["PROFILE_REVIEW", "ACTIVE"]],
    ["PROFILE_REVIEW", ["ACTIVE"]],
    ["NEEDS_ASSESSMENT", ["PROFILE_REVIEW", "ACTIVE"]],
    ["STRATEGY", ["ACTIVE"]],
  ])("finishes the walk from %s", async (from, expected) => {
    status = from;

    const result = await ensureProjectActive("proj-1");

    expect(result.usable).toBe(true);
    expect(transition.mock.calls.map((call) => call[2])).toEqual(expected);
  });

  it.each(["PAUSED", "CLOSED"])(
    "never undoes a %s project: no transition, not usable, no loop rows",
    async (held) => {
      status = held;

      const result = await ensureProjectActive("proj-1");

      expect(result).toEqual({ status: held, usable: false });
      expect(transition).not.toHaveBeenCalled();
      expect(policyGetOrCreate).not.toHaveBeenCalled();
      expect(loopGetOrCreate).not.toHaveBeenCalled();
    },
  );

  it("reports a project that no longer exists as unusable instead of throwing", async () => {
    exists = false;

    await expect(ensureProjectActive("gone")).resolves.toEqual({
      status: "CLOSED",
      usable: false,
    });
    expect(transition).not.toHaveBeenCalled();
  });

  it("treats a lost race as success when the other caller already activated it", async () => {
    transition.mockImplementation(async () => {
      // Another caller finished the walk between our read and our write.
      status = "ACTIVE";
      throw new Error("Invalid project transition");
    });

    await expect(ensureProjectActive("proj-1")).resolves.toEqual({
      status: "ACTIVE",
      usable: true,
    });
  });

  it("gives up after a bounded number of steps when the status will not move", async () => {
    transition.mockRejectedValue(new Error("stuck"));

    const result = await ensureProjectActive("proj-1");

    expect(result).toEqual({ status: "CREATED", usable: false });
    expect(transition.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it("does not fail when the audit write fails", async () => {
    auditRecord.mockRejectedValue(new Error("audit down"));

    await expect(ensureProjectActive("proj-1")).resolves.toEqual({
      status: "ACTIVE",
      usable: true,
    });
  });
});
