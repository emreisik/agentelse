import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  APPLY_LIMITS,
  AUDIT,
  AUDIENCE_SEGMENTS,
  BUSINESS_KINDS,
  EMPTY_IDEA_OPTIONS,
  GUARDRAILS,
  RECEIPT_PART_LABELS,
  TONES,
  channelOptionId,
  goalOptionId,
  type Answers,
  type ApplyResult,
  type GoalMode,
  type SessionRecord,
} from "@/lib/guided-setup/contract";
import type { ChannelConnections } from "@/lib/content-channels";
import {
  makeAllowListPrisma,
  observedOps,
} from "@/test-support/allow-list-prisma";
import { makeAuditFake } from "@/test-support/audit-fake";
import { makeCommandFake } from "@/test-support/command-fake";

// The saga runs over the REAL writers, constitution service, memory service and
// goal state machine, on top of a Prisma stand-in that only lets a per-model
// operation allow-list through (command and auditLog are the in-memory fakes).
// Nothing reaches a database.

const holder = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("@/lib/prisma", () => ({
  prisma: new Proxy(
    {},
    { get: (_target, key) => holder.current[key as string] },
  ),
}));

// The "act" worlds Approve must never reach. They are mocked with stubs that
// throw: the assertions below prove none is ever called (and G35 proves they
// are not even imported).
const forbidden = vi.hoisted(() => ({
  approveAll: vi.fn(() => {
    throw new Error("GoalEngine.approveAll must not be called");
  }),
  autonomyUpdate: vi.fn(() => {
    throw new Error("AutonomyPolicyRepository.update must not be called");
  }),
  saveIdea: vi.fn(() => {
    throw new Error("saveIdea must not be called");
  }),
  startSetup: vi.fn(() => {
    throw new Error("startAgencySetupForProject must not be called");
  }),
}));
vi.mock("@/server/agency/goals/goal-engine", () => ({
  GoalEngine: { approveAll: forbidden.approveAll },
}));
vi.mock("@/server/repositories/autonomy-policy.repository", () => ({
  AutonomyPolicyRepository: {
    update: forbidden.autonomyUpdate,
    getForProject: vi.fn(),
  },
}));
vi.mock("@/server/commands/strategic-request", () => ({
  saveIdea: forbidden.saveIdea,
}));
vi.mock("@/server/actions/agency-setup-actions", () => ({
  startAgencySetupForProject: forbidden.startSetup,
}));

// finishApply is wrapped so a test can see WHICH token tried to finish.
vi.mock("./session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session")>();
  return { ...actual, finishApply: vi.fn(actual.finishApply) };
});

import { applyGuidedSetup, type ApplyDeps, type ApplyWriters } from "./apply";
import * as sessionModule from "./session";
import { modifySession } from "./store";
import * as writersModule from "./writers";

const finishApplySpy = vi.mocked(sessionModule.finishApply);

const WORKSPACE = "w1";
const PROJECT = "p1";
const USER = "u1";
const ACCESS = {
  userId: USER,
  workspaceId: WORKSPACE,
  projectId: PROJECT,
  defaultBrandId: "b1",
};
const EDIT_REV = "e1e1e1e1";
const T0 = Date.UTC(2026, 8, 30, 12, 0, 0);

const FULL_ANSWERS: Answers = {
  goal: { picked: [goalOptionId("leads")] },
  channels: {
    picked: [channelOptionId("instagram"), channelOptionId("linkedin")],
  },
  business: { picked: [BUSINESS_KINDS[0]!.id] },
  audience: { picked: [AUDIENCE_SEGMENTS[0]!.id] },
  tone: { picked: [TONES[0]!.id] },
  guardrails: { picked: [GUARDRAILS[0]!.id] },
};

const receiptIdOf = (editRev: string) =>
  `gsa_${createHash("sha256").update(`${PROJECT}:${editRev}`).digest("hex").slice(0, 24)}`;

type Row = Record<string, unknown>;
type GoalRow = Row & { id: string; title: string; status: string };

// A tiny stateful projectGoal table: the goal state machine reads and updates
// it for real.
function makeGoalFake() {
  const goals: GoalRow[] = [];
  return {
    goals,
    fake: {
      findMany: async () => goals.map((goal) => ({ ...goal })),
      findFirst: async ({ where }: { where: { id?: string } }) => {
        const found = goals.find((goal) => goal.id === where.id);
        return found ? { ...found } : null;
      },
      createManyAndReturn: async ({ data }: { data: Row[] }) =>
        data.map((input) => {
          const row: GoalRow = {
            approvedByType: null,
            approvedByUserId: null,
            ...input,
            title: String(input.title),
            id: `goal_${goals.length + 1}`,
            status: "PROPOSED",
          };
          goals.push(row);
          return { ...row };
        }),
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = goals.find((goal) => goal.id === where.id);
        if (!row) throw new Error("goal fake: not found");
        Object.assign(row, data);
        return { ...row };
      },
    },
  };
}

type WorldOptions = {
  answers?: Answers;
  session?: Partial<SessionRecord>;
  auditSeed?: Row[];
  // The project row the locale is read from (null = it vanished).
  project?: Row | null;
  // What the brand lookup answers when the access carries no default brand.
  brand?: Row | null;
};

function makeWorld(options: WorldOptions = {}) {
  const clock = { now: T0 };
  const session: SessionRecord = {
    v: 1,
    rev: "aaaaaaaa",
    editRev: EDIT_REV,
    status: "OPEN",
    step: "review",
    more: false,
    seedFirst: false,
    staticFirst: true,
    answers: options.answers ?? FULL_ANSWERS,
    seed: null,
    applyingSinceMs: null,
    applyToken: null,
    goalId: null,
    applied: null,
    lastFailure: null,
    createdAtMs: T0 - 1000,
    updatedAtMs: T0 - 1000,
    updatedByUserId: USER,
    ...options.session,
  };
  const command = makeCommandFake({
    seed: [
      {
        id: `gs_${PROJECT}`,
        workspaceId: WORKSPACE,
        projectId: PROJECT,
        topic: "GUIDED_SETUP",
        source: "SYSTEM",
        rawText: "GUIDED_SETUP",
        parsedIntent: { guidedSetup: session },
      },
    ],
  });
  const audit = makeAuditFake({ now: () => new Date(clock.now) });
  for (const seeded of options.auditSeed ?? []) {
    void audit.create({ data: seeded });
  }
  const { goals, fake: goalFake } = makeGoalFake();
  // Switchable failures of the two IO fakes.
  const faults = { receipt: false, audit: false };
  const commandWithFaults = {
    ...command,
    create: async (args: { data: Row }) => {
      if (faults.receipt && String(args.data.id).startsWith("gsa_")) {
        throw new Error("connection reset");
      }
      return command.create(args);
    },
  };
  const auditWithFaults = {
    ...audit,
    create: async (args: { data: Row }) => {
      if (faults.audit) throw new Error("audit down");
      return audit.create(args);
    },
  };
  const { prisma, calls } = makeAllowListPrisma({
    overrides: {
      command: commandWithFaults,
      auditLog: auditWithFaults,
      project: {
        findUnique: async () =>
          options.project === undefined
            ? { language: "en", country: "US" }
            : options.project,
      },
      brand: {
        findFirst: async () =>
          options.brand === undefined ? { id: "b1" } : options.brand,
      },
      projectGoal: goalFake,
    },
  });
  holder.current = prisma;

  const conn = { fn: vi.fn(async (): Promise<ChannelConnections> => ({})) };
  const mode = { value: "active" as GoalMode };
  const goalMode = vi.fn(async () => mode.value);
  const ensureActive = vi.fn(async () => ({ usable: true }));

  function deps(overrides: Partial<ApplyDeps> = {}): ApplyDeps {
    return {
      nowMs: () => clock.now,
      token: "tokenAAAA1",
      ensureActive,
      channelConnections: conn.fn,
      goalMode,
      ...overrides,
    };
  }
  const apply = (
    overrides: Partial<ApplyDeps> = {},
    expectedRev: string = EDIT_REV,
  ): Promise<ApplyResult> =>
    applyGuidedSetup(
      { access: ACCESS, userId: USER, expectedRev },
      deps(overrides),
    );

  const rows = () => command.snapshot();
  const sessionRow = (): SessionRecord => {
    const row = rows().find((r) => r.id === `gs_${PROJECT}`);
    const intent = row?.parsedIntent as { guidedSetup: SessionRecord };
    return intent.guidedSetup;
  };
  const receipts = () => rows().filter((r) => r.id !== `gs_${PROJECT}`);
  const auditActions = async (action: string) => {
    return audit.count({ where: { action } });
  };

  // A user save (edit or revert) through the real store and session rules.
  async function save(answers: Answers, editRev: string) {
    const result = await modifySession(PROJECT, (record) => {
      const saved = sessionModule.withAnswers(record, {
        step: "review",
        more: false,
        answers,
        nowMs: clock.now,
        userId: USER,
        ctx: {
          channelIds: [
            "instagram",
            "tiktok",
            "linkedin",
            "x",
            "seo",
            "ads",
          ].map((key) => `channel.${key}`),
          ideas: EMPTY_IDEA_OPTIONS,
        },
        rev: "ignored1",
        editRev,
      });
      return "error" in saved
        ? { error: saved.error }
        : { next: saved.next, value: true };
    });
    return result.status;
  }

  return {
    clock,
    faults,
    command,
    audit,
    goals,
    calls,
    conn,
    mode,
    goalMode,
    ensureActive,
    deps,
    apply,
    rows,
    sessionRow,
    receipts,
    auditActions,
    save,
  };
}

// Writers that report "nothing differs".
const UNCHANGED_WRITERS: Partial<ApplyWriters> = {
  patchBrandDossier: async () => "UNCHANGED",
  publishMergedConstitution: async () => "UNCHANGED",
  ensureUserGoal: async (_scope, _user, _goal, previous, _mode, hooks) => {
    await hooks?.onGoalId?.(previous ?? "goal_1");
    return { goalId: previous ?? "goal_1", outcome: "UNCHANGED" };
  },
  addClientRules: async () => ({ added: 0, skipped: 1 }),
  rememberKeyed: async () => "UNCHANGED",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

// -----------------------------------------------------------------------------
// The happy path and what it touches
// -----------------------------------------------------------------------------

describe("applyGuidedSetup: a full approve (G34, G58, G33)", () => {
  it("writes only the enumerated sinks: the OBSERVED (model, operation) set is pinned", async () => {
    const world = makeWorld();
    const result = await world.apply();
    expect(result).toEqual({
      ok: true,
      parts: ["profile", "goal", "channels", "guardrails"],
      unchanged: false,
      goalMode: "active",
      unconnected: [],
    });
    // Any new write (or read of a new model) shows up as a diff here.
    expect(observedOps(world.calls)).toEqual([
      "approvedClaim.deleteMany",
      "approvedClaim.findMany",
      "auditLog.count",
      "auditLog.create",
      "brandAssumption.deleteMany",
      "brandAssumption.findMany",
      "brandConstitution.create",
      "brandConstitution.findFirst",
      "brandConstitution.update",
      "brandConstitution.updateMany",
      "brandDecision.create",
      "brandDossier.create",
      "brandDossier.findUnique",
      "brandFact.deleteMany",
      "brandLearning.create",
      "brandLearning.deleteMany",
      "brandLearning.findFirst",
      "command.create",
      "command.findUnique",
      "command.updateMany",
      "negativeBriefRule.createMany",
      "negativeBriefRule.deleteMany",
      "negativeBriefRule.findMany",
      "project.findUnique",
      "projectGoal.createManyAndReturn",
      "projectGoal.findFirst",
      "projectGoal.findMany",
      "projectGoal.update",
    ]);
    expect(world.calls.some((call) => call.startsWith("$"))).toBe(false);
  });

  it("never reaches the act worlds and never touches the models outside the map", async () => {
    const world = makeWorld();
    await world.apply();
    for (const stub of Object.values(forbidden)) {
      expect(stub).not.toHaveBeenCalled();
    }
    const outsideMap = [
      "autonomyPolicy",
      "idea",
      "competitor",
      "projectSchedule",
      "creative",
      "task",
      "approval",
      "projectSetupState",
      "projectSignalProfile",
      "userDecision",
    ];
    for (const model of outsideMap) {
      expect(
        world.calls.filter((call) => call.startsWith(`${model}.`)),
      ).toEqual([]);
      // ... and the proxy really would have refused it.
      const table = holder.current[model] as Record<
        string,
        (...args: unknown[]) => unknown
      >;
      expect(() => table.create!({})).toThrow(/forbidden/);
    }
  });

  it("the proxy refuses another operation on an allowed model and every raw SQL entry point", () => {
    makeWorld();
    const table = (name: string) =>
      holder.current[name] as Record<string, (...args: unknown[]) => unknown>;
    expect(() => table("project").update!({})).toThrow(/forbidden/);
    expect(() => table("brand").update!({})).toThrow(/forbidden/);
    for (const raw of [
      "$executeRaw",
      "$executeRawUnsafe",
      "$queryRaw",
      "$queryRawUnsafe",
    ]) {
      expect(() => table(raw as string)).not.toThrow();
      expect(() => (holder.current[raw] as () => unknown)()).toThrow(
        /forbidden/,
      );
    }
  });

  it("a write outside the map inside a writer turns the apply red (mutation shape of G58)", async () => {
    const world = makeWorld();
    const mutated: Partial<ApplyWriters> = {
      patchBrandDossier: async (scope, patch, locale) => {
        const outcome = await writersModule.patchBrandDossier(
          scope,
          patch,
          locale,
        );
        const project = holder.current.project as {
          update: (args: unknown) => unknown;
        };
        project.update({ where: { id: PROJECT }, data: { name: "x" } });
        return outcome;
      },
    };
    const result = await world.apply({ writers: mutated });
    expect(result).toMatchObject({
      ok: false,
      code: "PARTIAL",
      failed: ["profile"],
    });
    expect(world.calls).toContain("project.update");
  });
});

describe("applyGuidedSetup: sinks and goal mode (G59)", () => {
  it("writes the plan's fields to the dossier, the constitution, the goal, memory and rules", async () => {
    const world = makeWorld();
    const seen: Record<string, unknown> = {};
    await world.apply({
      writers: {
        patchBrandDossier: async (scope, patch, locale) => {
          seen.dossier = patch;
          seen.locale = locale;
          seen.scope = scope;
          return "UPDATED";
        },
        publishMergedConstitution: async (_scope, patch, _locale, userId) => {
          seen.constitution = patch;
          seen.userId = userId;
          return "CREATED";
        },
        addClientRules: async (_scope, rules) => {
          seen.rules = rules;
          return { added: rules.length, skipped: 0 };
        },
        rememberKeyed: async (_scope, key, insight, polarity) => {
          seen[`memory:${key}`] = [insight, polarity];
          return "REMEMBERED";
        },
      },
    });
    expect(seen.scope).toEqual({
      workspaceId: WORKSPACE,
      projectId: PROJECT,
      brandId: "b1",
    });
    expect(seen.locale).toEqual({ language: "en", country: "US" });
    expect(seen.userId).toBe(USER);
    expect(seen.dossier).toEqual({
      summary: BUSINESS_KINDS[0]!.label,
      targetAudiences: [AUDIENCE_SEGMENTS[0]!.label],
      toneOfVoice: TONES[0]!.label,
    });
    expect(seen.constitution).toEqual({
      identity: BUSINESS_KINDS[0]!.label,
      audiences: [AUDIENCE_SEGMENTS[0]!.label],
      toneOfVoice: TONES[0]!.label,
    });
    expect(seen.rules).toEqual([GUARDRAILS[0]!.label]);
    expect(seen["memory:channels"]).toEqual([
      "Focus channels: Instagram, LinkedIn.",
      "WORKS",
    ]);
    expect(seen["memory:guardrails"]).toEqual([
      `Never: ${GUARDRAILS[0]!.label.replace(/^Never\s+/u, "")}.`,
      "AVOID",
    ]);
  });

  it("runs the parts in order: dossier, constitution, goal, channels, rules, rules memory", async () => {
    const world = makeWorld();
    const order: string[] = [];
    await world.apply({
      writers: {
        patchBrandDossier: async () => {
          order.push("dossier");
          return "UPDATED";
        },
        publishMergedConstitution: async () => {
          order.push("constitution");
          return "CREATED";
        },
        ensureUserGoal: async (...args) => {
          order.push("goal");
          return UNCHANGED_WRITERS.ensureUserGoal!(...args);
        },
        rememberKeyed: async (_scope, key) => {
          order.push(`memory:${key}`);
          return "REMEMBERED";
        },
        addClientRules: async () => {
          order.push("rules");
          return { added: 1, skipped: 0 };
        },
      },
    });
    expect(order).toEqual([
      "dossier",
      "constitution",
      "goal",
      "memory:channels",
      "rules",
      "memory:guardrails",
    ]);
  });

  it("'active' mode: the goal is created, approved by the USER and made ACTIVE", async () => {
    const world = makeWorld();
    world.mode.value = "active";
    const result = await world.apply();
    expect(result).toMatchObject({ ok: true, goalMode: "active" });
    expect(world.goals).toHaveLength(1);
    expect(world.goals[0]).toMatchObject({
      title: "Generate leads and bookings",
      metricKey: "registrations",
      status: "ACTIVE",
      approvedByType: "USER",
      approvedByUserId: USER,
      isMock: false,
    });
    expect(world.sessionRow().applied).toMatchObject({ goalMode: "active" });
  });

  it("'proposed' mode: the goal stays PROPOSED and nobody approves it", async () => {
    const world = makeWorld();
    world.mode.value = "proposed";
    const result = await world.apply();
    expect(result).toMatchObject({ ok: true, goalMode: "proposed" });
    expect(world.goals).toHaveLength(1);
    expect(world.goals[0]).toMatchObject({ status: "PROPOSED" });
    expect(world.goals[0]!.approvedByType).toBeNull();
    expect(world.goals[0]!.approvedByUserId).toBeNull();
    const card = (
      world.receipts()[0]!.parsedIntent as {
        card: { summary: { goalProposed: boolean } };
      }
    ).card;
    expect(card.summary.goalProposed).toBe(true);
    expect(forbidden.approveAll).not.toHaveBeenCalled();
  });

  it("a throwing goal-mode lookup means 'proposed' (fail safe)", async () => {
    const world = makeWorld();
    const result = await world.apply({
      goalMode: async () => {
        throw new Error("policy read failed");
      },
    });
    expect(result).toMatchObject({ ok: true, goalMode: "proposed" });
    expect(world.goals[0]).toMatchObject({ status: "PROPOSED" });
  });

  it("no goal answered: goalMode is null and no goal row exists", async () => {
    const world = makeWorld({
      answers: { tone: { picked: [TONES[0]!.id] } },
    });
    const result = await world.apply();
    expect(result).toMatchObject({ ok: true, goalMode: null });
    expect(world.goals).toEqual([]);
    expect(world.sessionRow().applied?.goalMode).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Claim: STALE / BUSY / ALREADY_APPLIED / stale recovery (G31)
// -----------------------------------------------------------------------------

describe("applyGuidedSetup: claim (G31)", () => {
  it("STALE when the rev is not the current editRev, and nothing is written", async () => {
    const world = makeWorld();
    const before = world.rows();
    const result = await world.apply({}, "someOtherRev");
    expect(result).toMatchObject({ ok: false, code: "STALE" });
    expect(world.rows()).toEqual(before);
    expect(await world.auditActions(AUDIT.applied)).toBe(0);
    expect(world.calls.filter((c) => c.startsWith("brand"))).toEqual([]);
  });

  it("BUSY while a fresh APPLYING claim exists, and the session is untouched", async () => {
    const world = makeWorld({
      session: {
        status: "APPLYING",
        applyingSinceMs: T0 - 10_000,
        applyToken: "someoneElse",
      },
    });
    const before = world.rows();
    const result = await world.apply();
    expect(result).toMatchObject({ ok: false, code: "BUSY" });
    expect(world.rows()).toEqual(before);
  });

  it("BUSY wins over STALE for a double click on a claim with an older rev", async () => {
    const world = makeWorld({
      session: {
        status: "APPLYING",
        applyingSinceMs: T0 - 5_000,
        applyToken: "someoneElse",
      },
    });
    const result = await world.apply({}, "oldRevision");
    expect(result).toMatchObject({ ok: false, code: "BUSY" });
  });

  it("a double click writes once: one claim wins, the other is BUSY", async () => {
    const world = makeWorld();
    const [first, second] = await Promise.all([
      world.apply({ token: "tokenAAAA1" }),
      world.apply({ token: "tokenBBBB2" }),
    ]);
    const results = [first, second];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([
      expect.objectContaining({ code: "BUSY" }),
    ]);
    expect(world.goals).toHaveLength(1);
    expect(world.receipts()).toHaveLength(1);
    expect(await world.auditActions(AUDIT.applied)).toBe(1);
  });

  it("the same rev after DONE is a free { ok, unchanged } with no writes at all", async () => {
    const world = makeWorld();
    const first = await world.apply();
    expect(first).toMatchObject({ ok: true, unchanged: false });
    const before = world.rows();
    const auditBefore = await world.auditActions(AUDIT.applied);
    const callsBefore = world.calls.length;

    const second = await world.apply({ token: "tokenBBBB2" });
    expect(second).toMatchObject({
      ok: true,
      unchanged: true,
      parts: ["profile", "goal", "channels", "guardrails"],
      goalMode: "active",
      unconnected: [],
    });
    expect(world.rows()).toEqual(before);
    expect(await world.auditActions(AUDIT.applied)).toBe(auditBefore);
    // Only the reads of the session (and nothing on a sink) happened.
    const newCalls = world.calls.slice(callsBefore);
    expect(
      newCalls.filter(
        (c) => !["command.findUnique", "command.updateMany"].includes(c),
      ),
    ).toEqual([]);
    expect(world.goals).toHaveLength(1);
  });

  it("an APPLYING claim older than 90 s reads as OPEN and is taken over", async () => {
    const world = makeWorld({
      session: {
        status: "APPLYING",
        applyingSinceMs: T0 - APPLY_LIMITS.staleApplyingMs - 1_000,
        applyToken: "crashedRun",
      },
    });
    const result = await world.apply();
    expect(result).toMatchObject({ ok: true, unchanged: false });
    const session = world.sessionRow();
    expect(session.status).toBe("DONE");
    expect(session.applyToken).toBeNull();
    expect(session.applied?.editRev).toBe(EDIT_REV);
  });

  it("an absent session is FAILED before anything else runs", async () => {
    const world = makeWorld();
    holder.current = makeAllowListPrisma({
      overrides: { command: makeCommandFake() },
    }).prisma;
    const result = await world.apply();
    expect(result).toMatchObject({ ok: false, code: "FAILED" });
    expect(world.ensureActive).not.toHaveBeenCalled();
  });

  it("without a default brand on the access, the project's brand is looked up", async () => {
    const world = makeWorld();
    const seen: string[] = [];
    const result = await applyGuidedSetup(
      {
        access: { ...ACCESS, defaultBrandId: undefined },
        userId: USER,
        expectedRev: EDIT_REV,
      },
      world.deps({
        writers: {
          rememberKeyed: async (scope) => {
            seen.push(scope.brandId);
            return "REMEMBERED";
          },
        },
      }),
    );
    expect(result).toMatchObject({ ok: true });
    expect(seen).toEqual(["b1", "b1"]);
    expect(world.calls).toContain("brand.findFirst");
  });

  it("a project without any brand is FAILED and the claim is released", async () => {
    const world = makeWorld({ brand: null });
    const result = await applyGuidedSetup(
      {
        access: { ...ACCESS, defaultBrandId: undefined },
        userId: USER,
        expectedRev: EDIT_REV,
      },
      world.deps(),
    );
    expect(result).toMatchObject({ ok: false, code: "FAILED" });
    expect(world.sessionRow()).toMatchObject({
      status: "OPEN",
      applyToken: null,
    });
    expect(world.receipts()).toEqual([]);
  });

  it("a paused or closed project is ON_HOLD before any write", async () => {
    const world = makeWorld();
    const before = world.rows();
    const result = await world.apply({
      ensureActive: async () => ({ usable: false }),
    });
    expect(result).toMatchObject({ ok: false, code: "ON_HOLD" });
    expect(world.rows()).toEqual(before);
    expect(await world.auditActions(AUDIT.applied)).toBe(0);
  });

  it("an unexpected error before the claim is FAILED and writes nothing", async () => {
    const world = makeWorld();
    const before = world.rows();
    const result = await world.apply({
      ensureActive: async () => {
        throw new Error("db down");
      },
    });
    expect(result).toMatchObject({ ok: false, code: "FAILED" });
    expect(world.rows()).toEqual(before);
  });

  it("an unexpected error after the claim releases it (OPEN, not stuck APPLYING)", async () => {
    const world = makeWorld({ project: null });
    const result = await world.apply();
    expect(result).toMatchObject({ ok: false, code: "FAILED" });
    const session = world.sessionRow();
    expect(session.status).toBe("OPEN");
    expect(session.applyToken).toBeNull();
    expect(session.applied).toBeNull();
    expect(world.receipts()).toEqual([]);
  });
});

describe("applyGuidedSetup: an empty plan (NOTHING)", () => {
  it("answers NOTHING, leaves the session OPEN and writes nothing", async () => {
    const world = makeWorld({
      answers: { goal: { picked: [], skipped: true } },
    });
    const result = await world.apply();
    expect(result).toMatchObject({ ok: false, code: "NOTHING" });
    const session = world.sessionRow();
    expect(session.status).toBe("OPEN");
    expect(session.applyToken).toBeNull();
    expect(session.applied).toBeNull();
    expect(world.receipts()).toEqual([]);
    expect(await world.auditActions(AUDIT.applied)).toBe(0);
    expect(
      world.calls.filter((c) => /^(brand|negative|projectGoal)/.test(c)),
    ).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// Durable per-project cap
// -----------------------------------------------------------------------------

describe("applyGuidedSetup: the durable per-project cap", () => {
  const appliedRow = (over: Row = {}): Row => ({
    workspaceId: WORKSPACE,
    projectId: PROJECT,
    action: AUDIT.applied,
    ...over,
  });
  const many = (count: number, over: Row = {}) =>
    Array.from({ length: count }, () => appliedRow(over));

  it("the 13th apply in 24 h answers RATE and writes nothing", async () => {
    const world = makeWorld({
      auditSeed: many(APPLY_LIMITS.perProjectPer24h),
    });
    const before = world.rows();
    const result = await world.apply();
    expect(result).toMatchObject({ ok: false, code: "RATE" });
    expect(world.rows()).toEqual(before);
    expect(world.calls.filter((c) => c.startsWith("brand"))).toEqual([]);
  });

  it("one below the cap still passes; rows of another project, older rows and apply_failed rows do not count", async () => {
    const world = makeWorld({
      auditSeed: [
        ...many(APPLY_LIMITS.perProjectPer24h - 1),
        ...many(5, { projectId: "other" }),
        ...many(5, {
          createdAt: new Date(T0 - APPLY_LIMITS.windowMs - 60_000),
        }),
        ...many(5, { action: AUDIT.applyFailed }),
      ],
    });
    const result = await world.apply();
    expect(result).toMatchObject({ ok: true });
  });

  it("is skipped for the free ALREADY_APPLIED no-op", async () => {
    const world = makeWorld();
    await world.apply();
    for (let i = 0; i < APPLY_LIMITS.perProjectPer24h; i += 1) {
      await world.audit.create({
        data: { projectId: PROJECT, action: AUDIT.applied },
      });
    }
    const result = await world.apply({ token: "tokenBBBB2" });
    expect(result).toMatchObject({ ok: true, unchanged: true });
  });
});

// -----------------------------------------------------------------------------
// Failure, retry, PARTIAL (G32)
// -----------------------------------------------------------------------------

describe("applyGuidedSetup: a failing part (G32)", () => {
  const failingChannels: Partial<ApplyWriters> = {
    rememberKeyed: async (scope, key, insight, polarity) => {
      if (key === "channels") throw new Error("memory store down");
      return writersModule.rememberKeyed(scope, key, insight, polarity);
    },
  };

  it("PARTIAL: session back to OPEN with lastFailure, no receipt, an apply_failed audit row", async () => {
    const world = makeWorld();
    const result = await world.apply({ writers: failingChannels });
    expect(result).toMatchObject({
      ok: false,
      code: "PARTIAL",
      saved: ["profile", "goal", "guardrails"],
      failed: ["channels"],
    });
    const message = (result as { message: string }).message;
    expect(message).toBe(
      `Some parts couldn't be saved. Saved: ${RECEIPT_PART_LABELS.profile}, ${RECEIPT_PART_LABELS.goal}, ${RECEIPT_PART_LABELS.guardrails}. Not saved: ${RECEIPT_PART_LABELS.channels}.`,
    );
    const session = world.sessionRow();
    expect(session.status).toBe("OPEN");
    expect(session.lastFailure).toEqual({ failed: ["channels"] });
    expect(session.applied).toBeNull();
    expect(session.applyToken).toBeNull();
    expect(world.receipts()).toEqual([]);
    expect(await world.auditActions(AUDIT.applyFailed)).toBe(1);
    expect(await world.auditActions(AUDIT.applied)).toBe(0);
  });

  it("Try again re-runs everything and succeeds: DONE, receipt written, lastFailure cleared", async () => {
    const world = makeWorld();
    await world.apply({ writers: failingChannels });
    const retry = await world.apply({ token: "tokenBBBB2" });
    expect(retry).toMatchObject({ ok: true, unchanged: false });
    const session = world.sessionRow();
    expect(session.status).toBe("DONE");
    expect(session.lastFailure).toBeNull();
    expect(session.applied?.receiptId).toBe(receiptIdOf(EDIT_REV));
    expect(world.receipts()).toHaveLength(1);
    // The goal made by the failed run is reused, never duplicated.
    expect(world.goals).toHaveLength(1);
  });

  it("the goal a failed run created is remembered in session.goalId", async () => {
    const world = makeWorld();
    await world.apply({ writers: failingChannels });
    expect(world.sessionRow().goalId).toBe("goal_1");
  });

  it("a goal created before a later part failed is archived when the goal answer changes on retry", async () => {
    const world = makeWorld();
    await world.apply({ writers: failingChannels });
    expect(world.goals).toHaveLength(1);
    expect(world.goals[0]).toMatchObject({ status: "ACTIVE" });

    const changed: Answers = {
      ...FULL_ANSWERS,
      goal: { picked: [goalOptionId("sales")] },
    };
    expect(await world.save(changed, "e2e2e2e2")).toBe("OK");

    const retry = await world.apply({ token: "tokenBBBB2" }, "e2e2e2e2");
    expect(retry).toMatchObject({ ok: true });
    expect(world.goals).toHaveLength(2);
    expect(world.goals[0]).toMatchObject({ id: "goal_1", status: "ARCHIVED" });
    expect(world.goals[1]).toMatchObject({
      title: "Increase sales",
      status: "ACTIVE",
    });
    expect(world.sessionRow().goalId).toBe("goal_2");
  });

  it("a failed part does not stop the parts after it", async () => {
    const world = makeWorld();
    const result = await world.apply({
      writers: {
        patchBrandDossier: async () => {
          throw new Error("dossier down");
        },
      },
    });
    expect(result).toMatchObject({
      ok: false,
      code: "PARTIAL",
      saved: ["goal", "channels", "guardrails"],
      failed: ["profile"],
    });
    expect(world.goals).toHaveLength(1);
  });
});

// -----------------------------------------------------------------------------
// The receipt (G33, G36, G73)
// -----------------------------------------------------------------------------

describe("applyGuidedSetup: the receipt (G33)", () => {
  it("is one WEB Command row with a deterministic id and closed-vocabulary text", async () => {
    const world = makeWorld();
    world.conn.fn.mockResolvedValue({
      instagram: { connected: false },
      linkedin: { connected: true },
    });
    const result = await world.apply();
    expect(result).toMatchObject({ ok: true, unconnected: ["instagram"] });

    const receipts = world.receipts();
    expect(receipts).toHaveLength(1);
    const [receipt] = receipts;
    expect(receipt).toMatchObject({
      id: receiptIdOf(EDIT_REV),
      source: "WEB",
      topic: null,
      ideaId: null,
      projectId: PROJECT,
      workspaceId: WORKSPACE,
      rawText: "Guided setup",
      replyText:
        "Your setup is saved. From now on your team works from this profile.",
      replyStatus: "ANSWERED",
      createdByUserId: USER,
    });
    expect(receipt!.parsedIntent).toEqual({
      card: {
        kind: "guided-setup",
        projectId: PROJECT,
        state: "done",
        summary: {
          goal: "Leads & bookings",
          goalProposed: false,
          channels: ["Instagram", "LinkedIn"],
          unconnected: ["instagram"],
          saved: ["Brand profile", "Goal", "Channel focus", "Rules"],
          canDraftPlan: true,
        },
      },
    });
    expect(world.sessionRow().applied?.receiptId).toBe(receiptIdOf(EDIT_REV));
    // No SYSTEM chat row: the only SYSTEM row is the session row itself.
    expect(
      world
        .rows()
        .filter((r) => r.source === "SYSTEM")
        .map((r) => r.id),
    ).toEqual([`gs_${PROJECT}`]);
  });

  it("carries nothing the person typed (only catalog labels and numbers)", async () => {
    const typed = "Sneaky https://evil.example/x";
    const world = makeWorld({
      answers: {
        ...FULL_ANSWERS,
        tone: { picked: [], other: typed },
      },
    });
    await world.apply();
    const text = JSON.stringify(world.receipts()[0]);
    expect(text).not.toContain("evil");
    expect(text).not.toContain("Sneaky");
  });

  it("canDraftPlan is false with only the ads channel", async () => {
    const world = makeWorld({
      answers: {
        goal: { picked: [goalOptionId("sales")] },
        channels: { picked: [channelOptionId("ads")] },
      },
    });
    await world.apply();
    const card = (
      world.receipts()[0]!.parsedIntent as {
        card: { summary: { canDraftPlan: boolean } };
      }
    ).card;
    expect(card.summary.canDraftPlan).toBe(false);
  });

  it("a second write of the same setup version cannot double-post (P2002 is ignored)", async () => {
    const world = makeWorld();
    // The receipt of a crashed earlier run already exists.
    await (
      holder.current.command as { create: (a: unknown) => Promise<unknown> }
    ).create({
      data: {
        id: receiptIdOf(EDIT_REV),
        workspaceId: WORKSPACE,
        projectId: PROJECT,
        source: "WEB",
        rawText: "Guided setup",
      },
    });
    const result = await world.apply();
    expect(result).toMatchObject({ ok: true });
    expect(world.receipts()).toHaveLength(1);
    expect(world.sessionRow().applied?.receiptId).toBe(receiptIdOf(EDIT_REV));
  });

  it("a receipt write that fails for another reason does not fail the setup", async () => {
    const world = makeWorld();
    world.faults.receipt = true;
    const result = await world.apply();
    expect(result).toMatchObject({ ok: true });
    expect(world.sessionRow().status).toBe("DONE");
    expect(world.sessionRow().applied?.receiptId).toBeNull();
  });
});

describe("applyGuidedSetup: unconnected channels", () => {
  it("lists exactly the picked social channels that are connected:false", async () => {
    const world = makeWorld({
      answers: {
        goal: { picked: [goalOptionId("awareness")] },
        channels: {
          picked: [
            channelOptionId("instagram"),
            channelOptionId("linkedin"),
            channelOptionId("seo"),
            channelOptionId("ads"),
          ],
        },
      },
    });
    world.conn.fn.mockResolvedValue({
      instagram: { connected: false },
      linkedin: { connected: true },
      tiktok: { connected: false }, // not picked
      ads: { connected: false }, // not a social channel
    });
    const result = await world.apply();
    expect(result).toMatchObject({ ok: true, unconnected: ["instagram"] });
    expect(world.conn.fn).toHaveBeenCalledWith(PROJECT);
  });

  it("a throwing lookup fails no part and yields no list", async () => {
    const world = makeWorld();
    world.conn.fn.mockRejectedValue(new Error("integrations down"));
    const result = await world.apply();
    expect(result).toMatchObject({ ok: true, unconnected: [] });
    const card = (
      world.receipts()[0]!.parsedIntent as {
        card: { summary: { unconnected: string[] } };
      }
    ).card;
    expect(card.summary.unconnected).toEqual([]);
    expect(world.sessionRow().status).toBe("DONE");
  });

  it("is not called when no social channel was picked", async () => {
    const world = makeWorld({
      answers: {
        goal: { picked: [goalOptionId("traffic")] },
        channels: { picked: [channelOptionId("seo")] },
      },
    });
    await world.apply();
    expect(world.conn.fn).not.toHaveBeenCalled();
  });
});

describe("applyGuidedSetup: an approve that changes nothing (G73)", () => {
  it("approve, edit, revert, approve again: no receipt, no new Command row, previous receiptId kept", async () => {
    const world = makeWorld();
    const first = await world.apply();
    expect(first).toMatchObject({ ok: true, unchanged: false });
    const firstReceipt = world.sessionRow().applied!.receiptId;
    expect(firstReceipt).toBe(receiptIdOf(EDIT_REV));
    const rowsAfterFirst = world.rows().map((r) => r.id);

    const edited: Answers = {
      ...FULL_ANSWERS,
      tone: { picked: [TONES[1]!.id] },
    };
    expect(await world.save(edited, "e2e2e2e2")).toBe("OK");
    expect(await world.save(FULL_ANSWERS, "e3e3e3e3")).toBe("OK");
    expect(world.sessionRow().status).toBe("OPEN");

    world.clock.now += 60_000;
    const auditBefore = await world.auditActions(AUDIT.applied);
    const second = await world.apply(
      { token: "tokenBBBB2", writers: UNCHANGED_WRITERS },
      "e3e3e3e3",
    );
    expect(second).toMatchObject({
      ok: true,
      unchanged: true,
      unconnected: [],
      parts: ["profile", "goal", "channels", "guardrails"],
    });
    // Nothing new in the chat.
    expect(world.rows().map((r) => r.id)).toEqual(rowsAfterFirst);
    expect(world.receipts()).toHaveLength(1);
    const session = world.sessionRow();
    expect(session.status).toBe("DONE");
    expect(session.applied).toMatchObject({
      editRev: "e3e3e3e3",
      receiptId: firstReceipt,
    });
    // ... but the audit trail records the approve.
    expect(await world.auditActions(AUDIT.applied)).toBe(auditBefore + 1);
    expect(world.conn.fn).toHaveBeenCalledTimes(1);
  });

  it("a first approve where every part is UNCHANGED writes no receipt and keeps receiptId null", async () => {
    const world = makeWorld();
    const result = await world.apply({ writers: UNCHANGED_WRITERS });
    expect(result).toMatchObject({ ok: true, unchanged: true });
    expect(world.receipts()).toEqual([]);
    expect(world.sessionRow()).toMatchObject({
      status: "DONE",
      applied: { receiptId: null },
    });
    expect(world.conn.fn).not.toHaveBeenCalled();
  });

  it("one changed part is enough for a receipt", async () => {
    const world = makeWorld();
    const result = await world.apply({
      writers: {
        ...UNCHANGED_WRITERS,
        rememberKeyed: async (_scope, key) =>
          key === "channels" ? "REMEMBERED" : "UNCHANGED",
      },
    });
    expect(result).toMatchObject({ ok: true, unchanged: false });
    expect(world.receipts()).toHaveLength(1);
  });
});

describe("applyGuidedSetup: the audit rows (G36)", () => {
  const CLOSED = /^[A-Za-z0-9_.:-]{1,40}$/;

  function assertClosed(value: unknown) {
    if (Array.isArray(value)) return value.forEach(assertClosed);
    if (value !== null && typeof value === "object") {
      return Object.values(value).forEach(assertClosed);
    }
    if (typeof value === "string") {
      expect(value).toMatch(CLOSED);
      expect(value).not.toMatch(/https?:|www\./i);
    }
  }

  async function auditOf(world: ReturnType<typeof makeWorld>, action: string) {
    const row = await world.audit.findFirst({ where: { action } });
    expect(row).not.toBeNull();
    return row!;
  }

  it("applied: counts, part names and revs only; projectId set", async () => {
    const world = makeWorld({
      answers: {
        ...FULL_ANSWERS,
        business: { picked: [], other: "Acme Ltd https://acme.example" },
      },
    });
    await world.apply();
    const row = await auditOf(world, AUDIT.applied);
    expect(row).toMatchObject({
      workspaceId: WORKSPACE,
      projectId: PROJECT,
      brandId: "b1",
      actorType: "USER",
      actorId: USER,
      entityType: "Project",
      entityId: PROJECT,
    });
    expect(row.metadata).toEqual({
      editRev: EDIT_REV,
      parts: ["profile", "goal", "channels", "guardrails"],
      changed: ["profile", "goal", "channels", "guardrails"],
      unchanged: false,
      goalMode: "active",
      rules: 1,
      receipt: true,
    });
    assertClosed(row.metadata);
    expect(JSON.stringify(row.metadata)).not.toContain("Acme");
  });

  it("apply_failed: part names only, never the error text", async () => {
    const world = makeWorld();
    await world.apply({
      writers: {
        rememberKeyed: async () => {
          throw new Error("secret detail https://internal.example/x");
        },
      },
    });
    const row = await auditOf(world, AUDIT.applyFailed);
    expect(row).toMatchObject({ projectId: PROJECT });
    expect(row.metadata).toEqual({
      editRev: EDIT_REV,
      saved: ["profile", "goal"],
      failed: ["channels", "guardrails"],
    });
    assertClosed(row.metadata);
  });

  it("a failing audit write never turns saved work into a failure", async () => {
    const world = makeWorld();
    world.faults.audit = true;
    const result = await world.apply();
    expect(result).toMatchObject({ ok: true });
    expect(world.sessionRow().status).toBe("DONE");
  });

  it("every Command row of the feature carries the projectId", async () => {
    const world = makeWorld();
    await world.apply();
    for (const row of world.rows()) expect(row.projectId).toBe(PROJECT);
  });
});

// -----------------------------------------------------------------------------
// The apply token (G62)
// -----------------------------------------------------------------------------

describe("applyGuidedSetup: the apply token (G62)", () => {
  // Holds the goal writer of run A until `release()` is called.
  function gate() {
    let release: () => void = () => undefined;
    let reached: () => void = () => undefined;
    const open = new Promise<void>((resolve) => {
      release = resolve;
    });
    const arrived = new Promise<void>((resolve) => {
      reached = resolve;
    });
    return { open, arrived, release, reached };
  }

  it("a stale-takeover second apply interleaved with the first creates exactly ONE goal, and the first finishes nothing", async () => {
    const world = makeWorld();
    const held = gate();
    const runA = world.apply({
      token: "tokenAAAA1",
      writers: {
        ensureUserGoal: async (...args) => {
          held.reached();
          await held.open;
          return writersModule.ensureUserGoal(...args);
        },
      },
    });
    await held.arrived;
    expect(world.sessionRow().applyToken).toBe("tokenAAAA1");

    // A is slow-but-alive: past the staleness limit a second Approve takes over.
    world.clock.now += APPLY_LIMITS.staleApplyingMs + 5_000;
    const runB = await world.apply({ token: "tokenBBBB2" });
    expect(runB).toMatchObject({ ok: true, unchanged: false });
    expect(world.goals).toHaveLength(1);

    held.release();
    const resultA = await runA;
    expect(resultA).toMatchObject({ ok: false, code: "BUSY" });
    expect(world.goals).toHaveLength(1);
    expect(world.receipts()).toHaveLength(1);
    expect(world.sessionRow().status).toBe("DONE");
    expect(world.sessionRow().applied?.receiptId).toBe(receiptIdOf(EDIT_REV));
    // A never tried to finish; B did, once.
    const finishers = finishApplySpy.mock.calls.map((call) => call[1]);
    expect(finishers).not.toContain("tokenAAAA1");
    expect(finishers).toEqual(["tokenBBBB2"]);
  });

  it("a run that lost the token stops at its next part and never calls finishApply", async () => {
    const world = makeWorld();
    const held = gate();
    const partsRun: string[] = [];
    const runA = world.apply({
      token: "tokenAAAA1",
      writers: {
        patchBrandDossier: async (...args) => {
          held.reached();
          await held.open;
          partsRun.push("dossier");
          return writersModule.patchBrandDossier(...args);
        },
        ensureUserGoal: async (...args) => {
          partsRun.push("goal");
          return writersModule.ensureUserGoal(...args);
        },
        rememberKeyed: async (...args) => {
          partsRun.push("memory");
          return writersModule.rememberKeyed(...args);
        },
      },
    });
    await held.arrived;

    // A save lands in the stale window: it clears the token.
    world.clock.now += APPLY_LIMITS.staleApplyingMs + 5_000;
    expect(
      await world.save(
        { ...FULL_ANSWERS, tone: { picked: [TONES[1]!.id] } },
        "e2e2e2e2",
      ),
    ).toBe("OK");
    expect(world.sessionRow().applyToken).toBeNull();

    held.release();
    const resultA = await runA;
    expect(resultA).toMatchObject({ ok: false, code: "BUSY" });
    // The part in flight finished, nothing after it ran.
    expect(partsRun).toEqual(["dossier"]);
    expect(world.goals).toEqual([]);
    expect(finishApplySpy).not.toHaveBeenCalled();
    // The answers saved during the stale run are NOT marked DONE.
    const session = world.sessionRow();
    expect(session.status).toBe("OPEN");
    expect(session.applied).toBeNull();
    expect(session.editRev).toBe("e2e2e2e2");
    expect(world.receipts()).toEqual([]);
    expect(await world.auditActions(AUDIT.applied)).toBe(0);
  });

  it("a run that loses the token during its LAST part finishes nothing and writes no receipt", async () => {
    const world = makeWorld();
    const held = gate();
    const runA = world.apply({
      token: "tokenAAAA1",
      writers: {
        rememberKeyed: async (scope, key, insight, polarity) => {
          if (key === "guardrails") {
            held.reached();
            await held.open;
          }
          return writersModule.rememberKeyed(scope, key, insight, polarity);
        },
      },
    });
    await held.arrived;
    world.clock.now += APPLY_LIMITS.staleApplyingMs + 5_000;
    expect(
      await world.save(
        { ...FULL_ANSWERS, tone: { picked: [TONES[1]!.id] } },
        "e2e2e2e2",
      ),
    ).toBe("OK");
    held.release();
    expect(await runA).toMatchObject({ ok: false, code: "BUSY" });
    expect(finishApplySpy).not.toHaveBeenCalled();
    expect(world.receipts()).toEqual([]);
    expect(await world.auditActions(AUDIT.applied)).toBe(0);
    expect(world.sessionRow()).toMatchObject({ status: "OPEN", applied: null });
  });

  it("the goal id is written under the token: a lost run cannot record it", async () => {
    const world = makeWorld();
    const held = gate();
    const runA = world.apply({
      token: "tokenAAAA1",
      writers: {
        ensureUserGoal: async (scope, userId, goal, previous, mode, hooks) => {
          held.reached();
          await held.open;
          return writersModule.ensureUserGoal(
            scope,
            userId,
            goal,
            previous,
            mode,
            hooks,
          );
        },
      },
    });
    await held.arrived;
    world.clock.now += APPLY_LIMITS.staleApplyingMs + 5_000;
    expect(await world.save(FULL_ANSWERS, "e2e2e2e2")).toBe("OK");
    held.release();
    expect(await runA).toMatchObject({ ok: false, code: "BUSY" });
    expect(world.sessionRow().goalId).toBeNull();
    expect(finishApplySpy).not.toHaveBeenCalled();
  });
});
