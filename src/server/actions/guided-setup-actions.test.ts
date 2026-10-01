import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AUDIT,
  RATE,
  SESSION_TOPIC,
  sessionRowId,
  type ApplyResult,
  type SessionRecord,
} from "@/lib/guided-setup/contract";
import { makeAuditFake, type AuditFake } from "@/test-support/audit-fake";
import { makeCommandFake, type CommandFake } from "@/test-support/command-fake";

import type { applyGuidedSetup as ApplyFn } from "@/server/guided-setup/apply";

// Guards G31 (the action half: no text parameter) and G67 (arguments are
// checked before any database call, the export list is exactly one function,
// the 13th apply in 24 hours answers RATE). The real saga runs on the
// in-memory fakes for the durable cap; everywhere else it is a spy, so the
// action's own wiring (order of checks, injected dependencies, revalidation) is
// what each test looks at. The shared database is never touched.

type World = {
  command: CommandFake;
  audit: AuditFake;
  // Every touch of the database, by model name.
  touched: string[];
};
const world = vi.hoisted(() => ({ current: null as unknown as World }));

vi.mock("@/lib/prisma", () => {
  const touch = <T>(name: string, value: T): T => {
    world.current.touched.push(name);
    return value;
  };
  return {
    prisma: {
      get command() {
        return touch("command", world.current.command);
      },
      get auditLog() {
        return touch("auditLog", world.current.audit);
      },
      get project() {
        return touch("project", { findUnique: async () => null });
      },
      get brand() {
        return touch("brand", { findFirst: async () => null });
      },
    },
  };
});

const requireUser = vi.fn();
const requireProjectAccess = vi.fn();
vi.mock("@/server/security/tenant-context", () => ({
  requireUser,
  requireProjectAccess,
}));

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath }));

const isRateLimited = vi.fn();
vi.mock("@/lib/rate-limit", () => ({ isRateLimited }));

const guidedEnabled = vi.fn();
vi.mock("@/server/guided-setup/flag", () => ({
  isGuidedSetupEnabled: guidedEnabled,
}));

const ensureProjectActive = vi.fn();
vi.mock("@/server/projects/activation", () => ({ ensureProjectActive }));
const getChannelConnections = vi.fn();
vi.mock("@/server/integrations/channel-connections", () => ({
  getChannelConnections,
}));
const resolveGoalMode = vi.fn();
vi.mock("@/server/guided-setup/goal-mode", () => ({ resolveGoalMode }));
const scheduleDossierAutofill = vi.fn();
vi.mock("@/server/brand/dossier-autofill-trigger", () => ({
  scheduleDossierAutofill,
}));

const applySpy = vi.hoisted(() => vi.fn());
vi.mock("@/server/guided-setup/apply", () => ({
  applyGuidedSetup: applySpy,
}));
const { applyGuidedSetup: realApply } = await vi.importActual<{
  applyGuidedSetup: typeof ApplyFn;
}>("@/server/guided-setup/apply");

const actionsModule = await import("./guided-setup-actions");
const { applyGuidedSetupAction } = actionsModule;
const { AgentelseError } = await import("@/server/security/errors");

const PROJECT = "proj-1";
const REV = "editrev00001";

const OK: ApplyResult = {
  ok: true,
  parts: ["goal"],
  unchanged: false,
  goalMode: "active",
  unconnected: [],
};

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    v: 1,
    rev: "sessionrev01",
    editRev: REV,
    status: "OPEN",
    step: "goal",
    more: false,
    seedFirst: false,
    staticFirst: true,
    answers: {},
    seed: null,
    applyingSinceMs: null,
    applyToken: null,
    goalId: null,
    applied: null,
    lastFailure: null,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
    updatedByUserId: "u1",
    ...overrides,
  };
}

function build(options: { applied?: number; ageMs?: number } = {}) {
  const sessionRow = {
    id: sessionRowId(PROJECT),
    workspaceId: "ws-1",
    projectId: PROJECT,
    topic: SESSION_TOPIC,
    source: "SYSTEM",
    rawText: SESSION_TOPIC,
    parsedIntent: { guidedSetup: session() },
  };
  const appliedRows = Array.from({ length: options.applied ?? 0 }, () => ({
    workspaceId: "ws-1",
    projectId: PROJECT,
    action: AUDIT.applied,
    createdAt: new Date(Date.now() - (options.ageMs ?? 60_000)),
  }));
  world.current = {
    command: makeCommandFake({ seed: [sessionRow] }),
    audit: makeAuditFake({ seed: appliedRows }),
    touched: [],
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  requireUser.mockResolvedValue({ userId: "u1", email: null });
  requireProjectAccess.mockResolvedValue({
    workspaceId: "ws-1",
    projectId: PROJECT,
    defaultBrandId: "brand-1",
  });
  isRateLimited.mockReturnValue(false);
  guidedEnabled.mockReturnValue(true);
  ensureProjectActive.mockResolvedValue({ status: "ACTIVE", usable: true });
  getChannelConnections.mockResolvedValue({});
  resolveGoalMode.mockResolvedValue({ mode: "active", handsOn: "AUTOPILOT" });
  applySpy.mockResolvedValue(OK);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  build();
});

describe("arguments are checked before anything is read (G67)", () => {
  const big = "x".repeat(1_000_000);
  const hostile: Array<[string, unknown, unknown]> = [
    ["object project id", { id: PROJECT }, REV],
    ["array project id", [PROJECT], REV],
    ["1 MB project id", big, REV],
    ["number project id", 42, REV],
    ["null project id", null, REV],
    ["undefined project id", undefined, REV],
    ["empty project id", "", REV],
    ["65 character project id", "p".repeat(65), REV],
    ["object rev", PROJECT, { rev: REV }],
    ["array rev", PROJECT, [REV]],
    ["1 MB rev", PROJECT, big],
    ["number rev", PROJECT, 123456],
    ["null rev", PROJECT, null],
    ["missing rev", PROJECT, undefined],
    ["5 character rev", PROJECT, "abcde"],
    ["33 character rev", PROJECT, "r".repeat(33)],
  ];

  it.each(hostile)(
    "%s: FAILED, with no database call and no other work",
    async (_name, projectId, expectedRev) => {
      const result = await applyGuidedSetupAction(
        projectId as string,
        expectedRev as string,
      );
      expect(result).toMatchObject({ ok: false, code: "FAILED" });
      expect(world.current.touched).toEqual([]);
      expect(guidedEnabled).not.toHaveBeenCalled();
      expect(requireUser).not.toHaveBeenCalled();
      expect(requireProjectAccess).not.toHaveBeenCalled();
      expect(isRateLimited).not.toHaveBeenCalled();
      expect(applySpy).not.toHaveBeenCalled();
      expect(revalidatePath).not.toHaveBeenCalled();
    },
  );

  it("accepts the boundary lengths", async () => {
    const result = await applyGuidedSetupAction("p".repeat(64), "r".repeat(6));
    expect(result).toEqual(OK);
    const last = await applyGuidedSetupAction("p", "r".repeat(32));
    expect(last).toEqual(OK);
  });
});

describe("the action's checks, in order", () => {
  it("answers DISABLED when the flag is off, before any session or project lookup", async () => {
    guidedEnabled.mockReturnValue(false);
    const result = await applyGuidedSetupAction(PROJECT, REV);
    expect(result).toMatchObject({ ok: false, code: "DISABLED" });
    expect(requireUser).not.toHaveBeenCalled();
    expect(requireProjectAccess).not.toHaveBeenCalled();
    expect(isRateLimited).not.toHaveBeenCalled();
    expect(applySpy).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(world.current.touched).toEqual([]);
  });

  it("checks the session and project access before the rate limit or any work", async () => {
    requireUser.mockRejectedValue(
      new AgentelseError("LOGIN_REQUIRED", "Authentication required"),
    );
    expect(await applyGuidedSetupAction(PROJECT, REV)).toMatchObject({
      ok: false,
      code: "FAILED",
    });
    expect(requireProjectAccess).not.toHaveBeenCalled();

    requireUser.mockResolvedValue({ userId: "u1", email: null });
    requireProjectAccess.mockRejectedValue(
      new AgentelseError("NOT_FOUND", "Project not found"),
    );
    expect(await applyGuidedSetupAction(PROJECT, REV)).toMatchObject({
      ok: false,
      code: "FAILED",
    });
    expect(requireProjectAccess).toHaveBeenCalledWith("u1", PROJECT);

    // A foreign project never consumes the caller's budget or starts a saga.
    expect(isRateLimited).not.toHaveBeenCalled();
    expect(applySpy).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(world.current.touched).toEqual([]);
  });

  it("answers RATE from the per user and project limiter, before the saga", async () => {
    isRateLimited.mockReturnValue(true);
    const result = await applyGuidedSetupAction(PROJECT, REV);
    expect(result).toMatchObject({ ok: false, code: "RATE" });
    expect(isRateLimited).toHaveBeenCalledWith(
      `guided-apply:u1:${PROJECT}`,
      RATE.applyPerMinute,
      60_000,
    );
    expect(applySpy).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("running the saga", () => {
  it("passes the caller's access and the revision, and injects the lookups and a fresh token", async () => {
    await applyGuidedSetupAction(PROJECT, REV);
    await applyGuidedSetupAction(PROJECT, REV);
    expect(applySpy).toHaveBeenCalledTimes(2);

    const [input, deps] = applySpy.mock.calls[0] as Parameters<typeof ApplyFn>;
    expect(input).toEqual({
      access: {
        userId: "u1",
        workspaceId: "ws-1",
        projectId: PROJECT,
        defaultBrandId: "brand-1",
      },
      userId: "u1",
      expectedRev: REV,
    });
    expect(Object.keys(input).sort()).toEqual([
      "access",
      "expectedRev",
      "userId",
    ]);

    expect(deps.ensureActive).toBe(ensureProjectActive);
    expect(deps.channelConnections).toBe(getChannelConnections);
    expect(deps.token).toMatch(/^[0-9a-f]{12}$/);
    expect(typeof deps.nowMs()).toBe("number");

    resolveGoalMode.mockResolvedValue({ mode: "proposed", handsOn: null });
    expect(await deps.goalMode(PROJECT)).toBe("proposed");
    expect(resolveGoalMode).toHaveBeenCalledWith(PROJECT);

    const [, secondDeps] = applySpy.mock.calls[1] as Parameters<typeof ApplyFn>;
    expect(secondDeps.token).not.toBe(deps.token);
  });

  it("returns the saga's answer and revalidates the project page exactly once on ok", async () => {
    const result = await applyGuidedSetupAction(PROJECT, REV);
    expect(result).toEqual(OK);
    expect(revalidatePath).toHaveBeenCalledTimes(1);
    expect(revalidatePath).toHaveBeenCalledWith(`/projects/${PROJECT}`);

    // An unchanged re-approve is still ok.
    revalidatePath.mockClear();
    applySpy.mockResolvedValue({ ...OK, unchanged: true, parts: [] });
    await applyGuidedSetupAction(PROJECT, REV);
    expect(revalidatePath).toHaveBeenCalledTimes(1);
  });

  it("schedules the dossier suggestion once per saved approval, for this project and brand, and never waits for it", async () => {
    let scheduled = false;
    scheduleDossierAutofill.mockImplementation(() => {
      scheduled = true;
    });
    const result = await applyGuidedSetupAction(PROJECT, REV);

    expect(result).toEqual(OK);
    expect(scheduled).toBe(true);
    expect(scheduleDossierAutofill).toHaveBeenCalledTimes(1);
    expect(scheduleDossierAutofill).toHaveBeenCalledWith(
      { workspaceId: "ws-1", projectId: PROJECT, brandId: "brand-1" },
      "u1",
    );
  });

  it("does not schedule the suggestion when nothing was saved", async () => {
    applySpy.mockResolvedValue({
      ok: false,
      code: "STALE",
      message: "stale",
      saved: [],
      failed: [],
    } satisfies ApplyResult);
    await applyGuidedSetupAction(PROJECT, REV);
    expect(scheduleDossierAutofill).not.toHaveBeenCalled();
  });

  it("does not schedule the suggestion for a project without a default brand", async () => {
    requireProjectAccess.mockResolvedValue({
      workspaceId: "ws-1",
      projectId: PROJECT,
    });
    await applyGuidedSetupAction(PROJECT, REV);
    expect(scheduleDossierAutofill).not.toHaveBeenCalled();
  });

  it.each([
    "STALE",
    "BUSY",
    "ON_HOLD",
    "NOTHING",
    "PARTIAL",
    "FAILED",
    "RATE",
    "DISABLED",
  ] as const)("maps %s through and never revalidates", async (code) => {
    const refusal: ApplyResult = {
      ok: false,
      code,
      message: `message for ${code}`,
      saved: ["goal"],
      failed: ["channels"],
    };
    applySpy.mockResolvedValue(refusal);
    expect(await applyGuidedSetupAction(PROJECT, REV)).toEqual(refusal);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("answers a generic FAILED when the saga throws, without the message", async () => {
    applySpy.mockRejectedValue(
      new Error(
        'Invalid `prisma.command.update()` invocation: table "Command"',
      ),
    );
    const result = await applyGuidedSetupAction(PROJECT, REV);
    expect(result).toEqual({
      ok: false,
      code: "FAILED",
      message: "Couldn't save your setup. Try again.",
      saved: [],
      failed: [],
    });
    expect(JSON.stringify(result)).not.toContain("prisma");
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("keeps a saved setup ok when the cache purge itself fails", async () => {
    revalidatePath.mockImplementation(() => {
      throw new Error("cache down");
    });
    expect(await applyGuidedSetupAction(PROJECT, REV)).toEqual(OK);
    expect(revalidatePath).toHaveBeenCalledTimes(1);
  });
});

describe("the durable cap: the 13th apply in 24 hours (G67)", () => {
  beforeEach(() => {
    applySpy.mockImplementation(realApply);
  });

  it("answers RATE after 12 applied audit rows, without touching the session", async () => {
    build({ applied: 12 });
    const before = world.current.command.snapshot();
    const result = await applyGuidedSetupAction(PROJECT, REV);
    expect(result).toMatchObject({ ok: false, code: "RATE" });
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(world.current.command.snapshot()).toEqual(before);
  });

  it("still lets the 12th through", async () => {
    build({ applied: 11 });
    const result = await applyGuidedSetupAction(PROJECT, REV);
    // The session has no answers: the saga runs and finds nothing to save.
    expect(result).toMatchObject({ ok: false, code: "NOTHING" });
  });

  it("counts only the last 24 hours", async () => {
    build({ applied: 12, ageMs: 25 * 60 * 60 * 1000 });
    const result = await applyGuidedSetupAction(PROJECT, REV);
    expect(result).toMatchObject({ ok: false, code: "NOTHING" });
  });
});

describe("the feature has exactly one Server Action (G67)", () => {
  const source = readFileSync(
    join(__dirname, "guided-setup-actions.ts"),
    "utf8",
  );

  it("is a use server file whose only runtime export is applyGuidedSetupAction", () => {
    expect(source.split("\n")[0]).toBe('"use server";');
    expect(Object.keys(actionsModule)).toEqual(["applyGuidedSetupAction"]);

    // Every export statement of the file, runtime or type.
    const exported = [...source.matchAll(/^export\s+(.*)$/gm)].map(
      (match) => match[1],
    );
    expect(exported).toHaveLength(1);
    expect(exported[0]).toMatch(/^async function applyGuidedSetupAction\(/);
  });

  it("takes a project id and a revision and no answer text", () => {
    expect(applyGuidedSetupAction.length).toBe(2);
    expect(source).toMatch(
      /export async function applyGuidedSetupAction\(\s*projectId: string,\s*expectedRev: string,?\s*\): Promise<ApplyResult>/,
    );
  });

  it("no other file of the feature is a use server file", () => {
    for (const file of [
      "../guided-setup/apply.ts",
      "../guided-setup/service.ts",
      "../guided-setup/writers.ts",
      "../guided-setup/store.ts",
      "../guided-setup/session.ts",
      "../../app/api/projects/[projectId]/guided-setup/route.ts",
    ]) {
      expect(readFileSync(join(__dirname, file), "utf8"), file).not.toMatch(
        /^["']use server["']/m,
      );
    }
  });
});
