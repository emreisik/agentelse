import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  GOAL_PRESETS,
  GUIDED_ONLY_OPEN_QUESTION,
  type Answers,
  type IdeaOptions,
} from "@/lib/guided-setup/contract";
import { buildApplyPlan } from "@/lib/guided-setup/plan";
import { prisma } from "@/lib/prisma";
import { ConstitutionConflictError } from "@/server/agency/constitution/constitution-service";
import { thinConstitution } from "@/server/brand/constitution-merge";

// The writers run over small in-memory stand-ins for the tables they touch (the
// real goal state machine, the real memory service, the real merge); only the
// constitution publisher and its reader are mocked. The shared database is
// never reached.

type Row = Record<string, unknown> & { id: string };
type Where = Record<string, unknown>;

const db = vi.hoisted(() => ({
  log: [] as string[],
  dossier: null as Row | null,
  goals: [] as Row[],
  rules: [] as Row[],
  learnings: [] as Row[],
  seq: 0,
  getActive: vi.fn(),
  publishVersion: vi.fn(),
}));

const matches = (row: Row, where: Where = {}) =>
  Object.entries(where).every(([key, want]) => {
    const have = row[key];
    if (
      want !== null &&
      typeof want === "object" &&
      "equals" in (want as object)
    ) {
      const { equals } = want as { equals: string };
      return String(have).toLowerCase() === equals.toLowerCase();
    }
    if (want !== null && typeof want === "object" && "in" in (want as object)) {
      return (want as { in: unknown[] }).in.includes(have);
    }
    return have === want;
  });

const nextId = (prefix: string) => `${prefix}${(db.seq += 1)}`;

vi.mock("@/lib/prisma", () => ({
  prisma: {
    brandDossier: {
      findUnique: vi.fn(async () => {
        db.log.push("brandDossier.findUnique");
        return db.dossier;
      }),
      create: vi.fn(async ({ data }: { data: Row }) => {
        db.log.push("brandDossier.create");
        db.dossier = { ...data, id: nextId("d") };
        return db.dossier;
      }),
      update: vi.fn(async ({ data }: { data: Row }) => {
        db.log.push("brandDossier.update");
        db.dossier = { ...(db.dossier as Row), ...data };
        return db.dossier;
      }),
    },
    projectGoal: {
      findMany: vi.fn(async ({ where }: { where: Where }) => {
        db.log.push("projectGoal.findMany");
        return db.goals
          .filter((row) => matches(row, where))
          .sort((a, b) => Number(a.priority) - Number(b.priority));
      }),
      findFirst: vi.fn(async ({ where }: { where: Where }) => {
        db.log.push("projectGoal.findFirst");
        return db.goals.find((row) => matches(row, where)) ?? null;
      }),
      createManyAndReturn: vi.fn(async ({ data }: { data: Where[] }) => {
        db.log.push("projectGoal.createManyAndReturn");
        return data.map((input) => {
          const row = {
            approvedByType: null,
            approvedByUserId: null,
            ...input,
            id: nextId("newgoal"),
            status: "PROPOSED",
          } as Row;
          db.goals.push(row);
          return row;
        });
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Row }) => {
          db.log.push(`projectGoal.update:${String(data.status)}`);
          const row = db.goals.find((goal) => goal.id === where.id) as Row;
          Object.assign(row, data);
          return row;
        },
      ),
    },
    negativeBriefRule: {
      findMany: vi.fn(async ({ where }: { where: Where }) => {
        db.log.push("negativeBriefRule.findMany");
        return db.rules.filter((row) => matches(row, where));
      }),
      createMany: vi.fn(async ({ data }: { data: Row[] }) => {
        db.log.push("negativeBriefRule.createMany");
        for (const input of data) {
          db.rules.push({ ...input, id: nextId("r") });
        }
        return { count: data.length };
      }),
    },
    brandLearning: {
      findFirst: vi.fn(async ({ where }: { where: Where }) => {
        db.log.push("brandLearning.findFirst");
        return db.learnings.find((row) => matches(row, where)) ?? null;
      }),
      deleteMany: vi.fn(async ({ where }: { where: Where }) => {
        db.log.push("brandLearning.deleteMany");
        const keep = db.learnings.filter((row) => !matches(row, where));
        const count = db.learnings.length - keep.length;
        db.learnings = keep;
        return { count };
      }),
      create: vi.fn(async ({ data }: { data: Row }) => {
        db.log.push("brandLearning.create");
        const row = { ...data, id: nextId("l") };
        db.learnings.push(row);
        return row;
      }),
      update: vi.fn(async () => {
        db.log.push("brandLearning.update");
        return {};
      }),
    },
  },
}));

vi.mock("@/server/repositories/brand-constitution.repository", () => ({
  BrandConstitutionRepository: { getActive: db.getActive },
}));

vi.mock("@/server/agency/constitution/constitution-service", async () => {
  const actual = await vi.importActual<
    typeof import("@/server/agency/constitution/constitution-service")
  >("@/server/agency/constitution/constitution-service");
  return {
    ConstitutionConflictError: actual.ConstitutionConflictError,
    ConstitutionService: { publishVersion: db.publishVersion },
  };
});

const {
  addClientRules,
  ensureUserGoal,
  patchBrandDossier,
  publishMergedConstitution,
  rememberKeyed,
} = await import("./writers");

const scope = { workspaceId: "w1", projectId: "p1", brandId: "b1" };
const locale = { language: "tr", country: "TR" };

beforeEach(() => {
  db.log = [];
  db.dossier = null;
  db.goals = [];
  db.rules = [];
  db.learnings = [];
  db.seq = 0;
  db.getActive.mockReset();
  db.publishVersion.mockReset();
  db.publishVersion.mockResolvedValue({});
  db.getActive.mockResolvedValue(null);
});

const published = (call = 0) =>
  (db.publishVersion.mock.calls[call]?.[0] ?? null) as {
    payload: ReturnType<typeof thinConstitution>;
    isMock: boolean;
    ifActiveVersion: number | null;
    decidedBy: { type: string; userId: string };
    sourceFindingIds: string[];
    evidenceIds: string[];
    note: string;
    scope: typeof scope;
  } | null;

// -----------------------------------------------------------------------------
// Constitution (G21, G22, G23, G57)
// -----------------------------------------------------------------------------

function richPayload() {
  return {
    ...thinConstitution(locale),
    identity: "Rich identity",
    positioning: "Rich positioning",
    toneOfVoice: "Rich tone",
    audiences: ["Rich audience"],
    businessModel: "Subscriptions",
    valueProposition: "Fast",
    knownFacts: ["Founded in 2010"],
    competitors: ["Rival Co"],
    approvedClaims: ["Best in town"],
    forbiddenClaims: ["Cheapest"],
    negativeBrief: ["No slang"],
    assumptions: ["Assumed"],
    legalRestrictions: ["No health claims"],
    openQuestions: ["Something else?"],
  };
}

describe("publishMergedConstitution", () => {
  it("G21: an unparseable stored payload fails the part and publishes nothing", async () => {
    db.getActive.mockResolvedValue({
      version: 4,
      isMock: false,
      payload: { identity: 42, nonsense: true },
    });
    await expect(
      publishMergedConstitution(scope, { identity: "New" }, locale, "u1"),
    ).rejects.toThrow(/could not be read/);
    expect(db.publishVersion).not.toHaveBeenCalled();
  });

  it("G57: a MOCK active row is treated as absent: nothing of it is copied", async () => {
    db.getActive.mockResolvedValue({
      version: 2,
      isMock: true,
      payload: richPayload(),
    });
    const outcome = await publishMergedConstitution(
      scope,
      { identity: "Patched identity", audiences: ["Cafe owners"] },
      locale,
      "u1",
    );
    expect(outcome).toBe("CREATED");
    const call = published();
    expect(call?.isMock).toBe(false);
    expect(call?.payload.identity).toBe("Patched identity");
    expect(call?.payload.audiences).toEqual(["Cafe owners"]);
    expect(call?.payload.knownFacts).toEqual([]);
    expect(call?.payload.competitors).toEqual([]);
    expect(call?.payload.approvedClaims).toEqual([]);
    expect(call?.payload.businessModel).toBe("");
    expect(call?.payload.positioning).toBe("");
    expect(call?.payload.openQuestions).toEqual([GUIDED_ONLY_OPEN_QUESTION]);
    expect(JSON.stringify(call?.payload)).not.toContain("Rich");
    // The mock version is still the ACTIVE one the new version supersedes.
    expect(call?.ifActiveVersion).toBe(2);
  });

  it("seeds a thin v1 from the dossier so a hand-edited dossier is not hidden", async () => {
    db.dossier = {
      id: "d1",
      summary: "Dossier summary",
      positioning: "Dossier positioning",
      toneOfVoice: "Dossier tone",
      targetAudiences: ["Dossier audience", 7],
    };
    const outcome = await publishMergedConstitution(
      scope,
      { toneOfVoice: "Warm" },
      locale,
      "u1",
    );
    expect(outcome).toBe("CREATED");
    const payload = published()?.payload;
    expect(payload?.identity).toBe("Dossier summary");
    expect(payload?.positioning).toBe("Dossier positioning");
    expect(payload?.audiences).toEqual(["Dossier audience"]);
    // The person's pick wins over the seed.
    expect(payload?.toneOfVoice).toBe("Warm");
    expect(published()?.ifActiveVersion).toBeNull();
  });

  it("with no dossier and no row the thin v1 carries the marker and the project locale", async () => {
    await publishMergedConstitution(scope, { identity: "X" }, locale, "u1");
    const payload = published()?.payload;
    expect(payload?.openQuestions).toEqual([GUIDED_ONLY_OPEN_QUESTION]);
    expect(payload?.language).toBe("tr");
    expect(payload?.country).toBe("TR");
  });

  it("a real base is merged: only the four fields change, the version is a USER decision", async () => {
    const base = richPayload();
    db.getActive.mockResolvedValue({
      version: 5,
      isMock: false,
      payload: base,
    });
    const outcome = await publishMergedConstitution(
      scope,
      { identity: "New identity", audiences: ["A", "B"] },
      locale,
      "u9",
    );
    expect(outcome).toBe("UPDATED");
    const call = published();
    expect(call?.payload).toEqual({
      ...base,
      identity: "New identity",
      audiences: ["A", "B"],
    });
    expect(call?.decidedBy).toEqual({ type: "USER", userId: "u9" });
    expect(call?.ifActiveVersion).toBe(5);
    expect(call?.scope).toEqual(scope);
    expect(call?.sourceFindingIds).toEqual([]);
    expect(call?.evidenceIds).toEqual([]);
    expect(call?.note).toBe("guided setup");
  });

  it("G23: an unchanged merge does not publish", async () => {
    const base = richPayload();
    db.getActive.mockResolvedValue({
      version: 5,
      isMock: false,
      payload: base,
    });
    const outcome = await publishMergedConstitution(
      scope,
      { identity: base.identity, audiences: base.audiences },
      locale,
      "u1",
    );
    expect(outcome).toBe("UNCHANGED");
    expect(db.publishVersion).not.toHaveBeenCalled();
  });

  it("an empty patch never creates a constitution from nothing", async () => {
    const outcome = await publishMergedConstitution(scope, {}, locale, "u1");
    expect(outcome).toBe("UNCHANGED");
    expect(db.publishVersion).not.toHaveBeenCalled();
  });

  it("G22: retries ONCE from a fresh read after a ConstitutionConflictError", async () => {
    db.getActive
      .mockResolvedValueOnce({
        version: 1,
        isMock: false,
        payload: richPayload(),
      })
      .mockResolvedValueOnce({
        version: 2,
        isMock: false,
        payload: richPayload(),
      });
    db.publishVersion
      .mockRejectedValueOnce(new ConstitutionConflictError(1, 2))
      .mockResolvedValueOnce({});
    const outcome = await publishMergedConstitution(
      scope,
      { identity: "New" },
      locale,
      "u1",
    );
    expect(outcome).toBe("UPDATED");
    expect(db.getActive).toHaveBeenCalledTimes(2);
    expect(db.publishVersion).toHaveBeenCalledTimes(2);
    expect(published(0)?.ifActiveVersion).toBe(1);
    expect(published(1)?.ifActiveVersion).toBe(2);
  });

  it("G22: retries ONCE after a unique violation (P2002), not twice", async () => {
    const unique = Object.assign(new Error("Unique constraint"), {
      code: "P2002",
    });
    db.publishVersion.mockRejectedValue(unique);
    await expect(
      publishMergedConstitution(scope, { identity: "New" }, locale, "u1"),
    ).rejects.toBe(unique);
    expect(db.publishVersion).toHaveBeenCalledTimes(2);
    expect(db.getActive).toHaveBeenCalledTimes(2);
  });

  it("G22: two conflicts in a row surface the error after exactly two attempts", async () => {
    db.publishVersion.mockRejectedValue(new ConstitutionConflictError(null, 1));
    await expect(
      publishMergedConstitution(scope, { identity: "New" }, locale, "u1"),
    ).rejects.toBeInstanceOf(ConstitutionConflictError);
    expect(db.publishVersion).toHaveBeenCalledTimes(2);
  });

  it("any other error is not retried", async () => {
    db.publishVersion.mockRejectedValue(new Error("boom"));
    await expect(
      publishMergedConstitution(scope, { identity: "New" }, locale, "u1"),
    ).rejects.toThrow("boom");
    expect(db.publishVersion).toHaveBeenCalledTimes(1);
  });

  it("after a lost race the second read sees the winner's row and merges onto it", async () => {
    const winner = { ...richPayload(), identity: "Winner identity" };
    db.getActive
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ version: 1, isMock: false, payload: winner });
    db.publishVersion
      .mockRejectedValueOnce(new ConstitutionConflictError(null, 1))
      .mockResolvedValueOnce({});
    const outcome = await publishMergedConstitution(
      scope,
      { positioning: "Mine" },
      locale,
      "u1",
    );
    // No real base on the first read, a real one on the second.
    expect(outcome).toBe("UPDATED");
    expect(published(1)?.payload.identity).toBe("Winner identity");
    expect(published(1)?.payload.positioning).toBe("Mine");
  });
});

// -----------------------------------------------------------------------------
// BrandDossier (G28)
// -----------------------------------------------------------------------------

describe("patchBrandDossier", () => {
  it("G28: creates with the defined keys only plus the project language and country", async () => {
    const result = await patchBrandDossier(
      scope,
      { summary: "We sell coffee", targetAudiences: ["Locals"] },
      locale,
    );
    expect(result).toBe("UPDATED");
    expect(db.dossier).toEqual({
      id: expect.any(String),
      workspaceId: "w1",
      projectId: "p1",
      brandId: "b1",
      summary: "We sell coffee",
      targetAudiences: ["Locals"],
      language: "tr",
      country: "TR",
    });
    expect(db.dossier).not.toHaveProperty("positioning");
    expect(db.dossier).not.toHaveProperty("toneOfVoice");
  });

  it("G28: updates only the keys that differ and never touches the others", async () => {
    db.dossier = {
      id: "d1",
      summary: "Old summary",
      positioning: "Hand written positioning",
      toneOfVoice: "Same tone",
      targetAudiences: ["Locals"],
      language: "en",
      country: "GB",
    };
    const result = await patchBrandDossier(
      scope,
      { summary: "New summary", toneOfVoice: "Same tone" },
      locale,
    );
    expect(result).toBe("UPDATED");
    expect(db.dossier).toMatchObject({
      summary: "New summary",
      positioning: "Hand written positioning",
      toneOfVoice: "Same tone",
      targetAudiences: ["Locals"],
      language: "en",
      country: "GB",
    });
  });

  it("G28: language and country are set on update only while the dossier has none", async () => {
    db.dossier = {
      id: "d1",
      summary: "Old",
      language: null,
      country: "",
    };
    await patchBrandDossier(scope, { summary: "New" }, locale);
    expect(db.dossier).toMatchObject({ language: "tr", country: "TR" });
  });

  it("G28: a no-op writes nothing (arrays compared by value)", async () => {
    db.dossier = {
      id: "d1",
      summary: "Same",
      targetAudiences: ["A", "B"],
      language: "tr",
      country: "TR",
    };
    const result = await patchBrandDossier(
      scope,
      { summary: "Same", targetAudiences: ["A", "B"] },
      locale,
    );
    expect(result).toBe("UNCHANGED");
    expect(db.log).not.toContain("brandDossier.update");
    expect(db.log).not.toContain("brandDossier.create");
  });

  it("a mirror-only difference does not count as a change", async () => {
    db.dossier = { id: "d1", summary: "Same", language: null, country: null };
    const result = await patchBrandDossier(scope, { summary: "Same" }, locale);
    expect(result).toBe("UNCHANGED");
    expect(db.log).not.toContain("brandDossier.update");
  });

  it("an empty patch writes and reads nothing", async () => {
    expect(await patchBrandDossier(scope, {}, locale)).toBe("UNCHANGED");
    expect(db.log).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// Goal (G29, G59 writer half)
// -----------------------------------------------------------------------------

const SALES = { key: "sales" as const, ...GOAL_PRESETS.sales };
const AWARENESS = { key: "awareness" as const, ...GOAL_PRESETS.awareness };

function goalRow(over: Record<string, unknown> & { id: string }): Row {
  return {
    projectId: "p1",
    title: "Other goal",
    metricKey: null,
    priority: 3,
    status: "PROPOSED",
    approvedByType: null,
    approvedByUserId: null,
    isMock: false,
    ...over,
  };
}

describe("ensureUserGoal", () => {
  it("G29: active mode creates PROPOSED, approves it as the USER, then makes it ACTIVE", async () => {
    const result = await ensureUserGoal(scope, "u1", SALES, null, "active");
    expect(result.outcome).toBe("CREATED");
    expect(db.log).toEqual([
      "projectGoal.findMany",
      "projectGoal.createManyAndReturn",
      "projectGoal.findFirst",
      "projectGoal.update:APPROVED",
      "projectGoal.findFirst",
      "projectGoal.update:ACTIVE",
    ]);
    expect(db.goals).toHaveLength(1);
    expect(db.goals[0]).toMatchObject({
      id: result.goalId,
      title: SALES.title,
      metricKey: SALES.metricKey,
      status: "ACTIVE",
      approvedByType: "USER",
      approvedByUserId: "u1",
      priority: 1,
      isMock: false,
      workspaceId: "w1",
      brandId: "b1",
    });
  });

  it("G29/G59: proposed mode stops at PROPOSED with no approval fields", async () => {
    const result = await ensureUserGoal(scope, "u1", SALES, null, "proposed");
    expect(result.outcome).toBe("CREATED");
    expect(db.goals[0]).toMatchObject({
      status: "PROPOSED",
      approvedByType: null,
      approvedByUserId: null,
    });
    expect(db.log.some((entry) => entry.startsWith("projectGoal.update"))).toBe(
      false,
    );
  });

  it("G29: no title or metric comes from anywhere but the preset passed in", async () => {
    await ensureUserGoal(scope, "u1", AWARENESS, null, "proposed");
    expect(db.goals[0]).toMatchObject({
      title: "Grow brand awareness",
      metricKey: "brand_awareness",
    });
  });

  it("G29: calls onGoalId the moment the goal exists, before the approval steps", async () => {
    const order: string[] = [];
    await ensureUserGoal(scope, "u1", SALES, null, "active", {
      onGoalId: async (id) => {
        order.push(`hook:${id}`);
        order.push(`log-length:${db.log.length}`);
      },
    });
    expect(order).toEqual([
      `hook:${db.goals[0]?.id}`,
      // findMany + createManyAndReturn only: nothing after the create yet.
      "log-length:2",
    ]);
  });

  it("G29: onGoalId is also called for a reused goal", async () => {
    db.goals = [
      goalRow({ id: "g9", title: "increase SALES", status: "ACTIVE" }),
    ];
    const seen: string[] = [];
    await ensureUserGoal(scope, "u1", SALES, null, "active", {
      onGoalId: async (id) => {
        seen.push(id);
      },
    });
    expect(seen).toEqual(["g9"]);
  });

  it("G29: reuses a non-terminal goal by preset title (case-insensitive) and creates nothing", async () => {
    db.goals = [
      goalRow({ id: "g9", title: "  increase sales ", status: "ACTIVE" }),
    ];
    const result = await ensureUserGoal(scope, "u1", SALES, null, "active");
    expect(result).toEqual({ goalId: "g9", outcome: "UNCHANGED" });
    expect(db.log).not.toContain("projectGoal.createManyAndReturn");
    expect(db.log.some((entry) => entry.startsWith("projectGoal.update"))).toBe(
      false,
    );
  });

  it("G29: proposed mode leaves a reused goal untouched, whatever its status", async () => {
    db.goals = [goalRow({ id: "g9", title: SALES.title, status: "ACTIVE" })];
    const result = await ensureUserGoal(scope, "u1", SALES, null, "proposed");
    expect(result).toEqual({ goalId: "g9", outcome: "UNCHANGED" });
    expect(db.goals[0]?.status).toBe("ACTIVE");
    expect(db.log.some((entry) => entry.startsWith("projectGoal.update"))).toBe(
      false,
    );
  });

  it("G29: proposed mode leaves a reused PROPOSED goal PROPOSED", async () => {
    db.goals = [goalRow({ id: "g9", title: SALES.title, status: "PROPOSED" })];
    await ensureUserGoal(scope, "u1", SALES, null, "proposed");
    expect(db.goals[0]).toMatchObject({
      status: "PROPOSED",
      approvedByType: null,
    });
  });

  it("G29: active mode carries a reused PROPOSED goal to APPROVED(USER) then ACTIVE, an APPROVED one to ACTIVE", async () => {
    db.goals = [goalRow({ id: "g9", title: SALES.title, status: "PROPOSED" })];
    await ensureUserGoal(scope, "u1", SALES, null, "active");
    expect(db.goals[0]).toMatchObject({
      status: "ACTIVE",
      approvedByType: "USER",
      approvedByUserId: "u1",
    });

    db.goals = [
      goalRow({
        id: "g8",
        title: SALES.title,
        status: "APPROVED",
        approvedByType: "AI",
        approvedByUserId: null,
      }),
    ];
    db.log = [];
    await ensureUserGoal(scope, "u1", SALES, null, "active");
    expect(db.goals[0]?.status).toBe("ACTIVE");
    expect(
      db.log.filter((entry) => entry.startsWith("projectGoal.update")),
    ).toEqual(["projectGoal.update:ACTIVE"]);
  });

  it("G29: a terminal, mock or paused goal with the same title is not reused", async () => {
    db.goals = [
      goalRow({ id: "g1", title: SALES.title, status: "ARCHIVED" }),
      goalRow({ id: "g2", title: SALES.title, status: "REJECTED" }),
      goalRow({ id: "g3", title: SALES.title, status: "ACTIVE", isMock: true }),
    ];
    const result = await ensureUserGoal(scope, "u1", SALES, null, "proposed");
    expect(["g1", "g2", "g3"]).not.toContain(result.goalId);
    expect(db.log).toContain("projectGoal.createManyAndReturn");
  });

  it("G29: priority 2 when an ACTIVE priority-1 goal exists, 1 otherwise", async () => {
    db.goals = [
      goalRow({
        id: "g1",
        title: "Grow engagement",
        status: "ACTIVE",
        priority: 1,
      }),
    ];
    await ensureUserGoal(scope, "u1", SALES, null, "proposed");
    expect(db.goals.find((row) => row.title === SALES.title)?.priority).toBe(2);

    db.goals = [
      goalRow({
        id: "g1",
        title: "Grow engagement",
        status: "PROPOSED",
        priority: 1,
      }),
      goalRow({
        id: "g2",
        title: "Grow engagement",
        status: "ACTIVE",
        priority: 3,
      }),
    ];
    await ensureUserGoal(scope, "u1", SALES, null, "proposed");
    expect(db.goals.find((row) => row.title === SALES.title)?.priority).toBe(1);
  });

  it("G29: the previous ACTIVE goal is archived, the previous APPROVED goal too", async () => {
    db.goals = [
      goalRow({
        id: "old",
        title: AWARENESS.title,
        status: "ACTIVE",
        priority: 1,
      }),
      goalRow({ id: "bystander", title: "Grow engagement", status: "ACTIVE" }),
    ];
    const result = await ensureUserGoal(scope, "u1", SALES, "old", "active");
    expect(result.outcome).toBe("REPLACED");
    expect(db.goals.find((row) => row.id === "old")?.status).toBe("ARCHIVED");
    expect(db.goals.find((row) => row.id === "bystander")?.status).toBe(
      "ACTIVE",
    );
    // The replaced goal's priority does not push the new one to 2.
    expect(db.goals.find((row) => row.id === result.goalId)?.priority).toBe(1);

    db.goals = [
      goalRow({ id: "old2", title: AWARENESS.title, status: "APPROVED" }),
    ];
    await ensureUserGoal(scope, "u1", SALES, "old2", "proposed");
    expect(db.goals.find((row) => row.id === "old2")?.status).toBe("ARCHIVED");
  });

  it("G29: a failure after the new goal exists still lets the retry retire the old goal", async () => {
    db.goals = [
      goalRow({
        id: "old",
        title: AWARENESS.title,
        status: "ACTIVE",
        priority: 1,
      }),
    ];
    // The session keeps ONE goal id: the hook overwrites it, like recordGoalId.
    let recorded: string | null = "old";
    const hooks = {
      onGoalId: async (id: string) => {
        recorded = id;
      },
    };
    vi.mocked(prisma.projectGoal.update).mockRejectedValueOnce(
      new Error("connection blip"),
    );
    await expect(
      ensureUserGoal(scope, "u1", SALES, recorded, "active", hooks),
    ).rejects.toThrow("connection blip");

    const retry = await ensureUserGoal(
      scope,
      "u1",
      SALES,
      recorded,
      "active",
      hooks,
    );

    expect(db.goals.find((row) => row.id === "old")?.status).toBe("ARCHIVED");
    expect(db.goals.find((row) => row.id === retry.goalId)?.status).toBe(
      "ACTIVE",
    );
    expect(db.goals.filter((row) => row.status === "ACTIVE")).toHaveLength(1);
  });

  it("G29: the previous PROPOSED goal is rejected", async () => {
    db.goals = [
      goalRow({ id: "old", title: AWARENESS.title, status: "PROPOSED" }),
    ];
    const result = await ensureUserGoal(scope, "u1", SALES, "old", "proposed");
    expect(result.outcome).toBe("REPLACED");
    expect(db.goals.find((row) => row.id === "old")?.status).toBe("REJECTED");
  });

  it("G29: a previous goal that is already terminal is left alone and is not a replacement", async () => {
    db.goals = [
      goalRow({ id: "old", title: AWARENESS.title, status: "ARCHIVED" }),
    ];
    const result = await ensureUserGoal(scope, "u1", SALES, "old", "proposed");
    expect(result.outcome).toBe("CREATED");
    expect(db.goals.find((row) => row.id === "old")?.status).toBe("ARCHIVED");
  });

  it("G29: the previous id equal to the goal in force changes nothing (idempotent re-run)", async () => {
    const first = await ensureUserGoal(scope, "u1", SALES, null, "active");
    db.log = [];
    const again = await ensureUserGoal(
      scope,
      "u1",
      SALES,
      first.goalId,
      "active",
    );
    expect(again).toEqual({ goalId: first.goalId, outcome: "UNCHANGED" });
    expect(db.goals).toHaveLength(1);
    expect(db.log).toEqual(["projectGoal.findMany"]);
  });

  it("G29: a previous id from another project is never touched", async () => {
    db.goals = [
      goalRow({
        id: "foreign",
        projectId: "other",
        title: "X",
        status: "ACTIVE",
      }),
    ];
    await ensureUserGoal(scope, "u1", SALES, "foreign", "proposed");
    expect(db.goals.find((row) => row.id === "foreign")?.status).toBe("ACTIVE");
  });

  it("G29: other goals of the project are never touched", async () => {
    db.goals = [
      goalRow({
        id: "a",
        title: "Grow engagement",
        status: "ACTIVE",
        priority: 1,
      }),
      goalRow({ id: "b", title: "Drive website traffic", status: "PROPOSED" }),
    ];
    await ensureUserGoal(scope, "u1", SALES, null, "active");
    expect(db.goals.find((row) => row.id === "a")?.status).toBe("ACTIVE");
    expect(db.goals.find((row) => row.id === "b")?.status).toBe("PROPOSED");
  });
});

// -----------------------------------------------------------------------------
// Client rules
// -----------------------------------------------------------------------------

describe("addClientRules", () => {
  it("adds rules as active client-rule rows", async () => {
    const result = await addClientRules(scope, [
      "Never quote prices",
      "Never joke about allergies",
    ]);
    expect(result).toEqual({ added: 2, skipped: 0 });
    expect(db.rules).toEqual([
      expect.objectContaining({
        workspaceId: "w1",
        projectId: "p1",
        brandId: "b1",
        rule: "Never quote prices",
        category: "client-rule",
        active: true,
      }),
      expect.objectContaining({ rule: "Never joke about allergies" }),
    ]);
  });

  it("dedupes against every category by trimmed lowercase text", async () => {
    db.rules = [
      {
        id: "r1",
        brandId: "b1",
        rule: "  never QUOTE prices ",
        category: "negative-brief",
      },
      {
        id: "r2",
        brandId: "b1",
        rule: "No slang",
        category: "forbidden-claim",
        active: false,
      },
      {
        id: "r3",
        brandId: "other",
        rule: "Never joke",
        category: "client-rule",
      },
    ];
    const result = await addClientRules(scope, [
      "Never quote prices",
      "no slang",
      "Never joke",
    ]);
    expect(result).toEqual({ added: 1, skipped: 2 });
    expect(
      db.rules.filter(
        (row) => row.category === "client-rule" && row.brandId === "b1",
      ),
    ).toHaveLength(1);
  });

  it("dedupes inside one call and skips blank text", async () => {
    const result = await addClientRules(scope, [
      "A rule",
      " a RULE ",
      "   ",
      "",
    ]);
    expect(result).toEqual({ added: 1, skipped: 3 });
  });

  it("is idempotent: the second call adds nothing and writes nothing", async () => {
    await addClientRules(scope, ["A rule"]);
    db.log = [];
    const again = await addClientRules(scope, ["A rule"]);
    expect(again).toEqual({ added: 0, skipped: 1 });
    expect(db.log).not.toContain("negativeBriefRule.createMany");
  });
});

// -----------------------------------------------------------------------------
// Keyed memory (G30)
// -----------------------------------------------------------------------------

describe("rememberKeyed", () => {
  it("G30: first call stores one USER_EXPLICIT line with the keyed sourceRef", async () => {
    const result = await rememberKeyed(
      scope,
      "channels",
      "Focus channels: Instagram, LinkedIn.",
      "WORKS",
    );
    expect(result).toBe("REMEMBERED");
    expect(db.learnings).toHaveLength(1);
    expect(db.learnings[0]).toMatchObject({
      brandId: "b1",
      insight: "Focus channels: Instagram, LinkedIn.",
      polarity: "WORKS",
      sourceType: "USER_EXPLICIT",
      sourceRef: "guided-setup:channels",
    });
  });

  it("G30: UNCHANGED when the keyed line already holds the same insight: no write", async () => {
    await rememberKeyed(scope, "channels", "Focus channels: A.", "WORKS");
    db.log = [];
    const result = await rememberKeyed(
      scope,
      "channels",
      "Focus channels: A.",
      "WORKS",
    );
    expect(result).toBe("UNCHANGED");
    expect(db.log).toEqual(["brandLearning.findFirst"]);
  });

  it("G30: a changed insight deletes the keyed line BEFORE remembering, leaving one line", async () => {
    await rememberKeyed(scope, "channels", "Focus channels: A.", "WORKS");
    db.log = [];
    const result = await rememberKeyed(
      scope,
      "channels",
      "Focus channels: A, B.",
      "WORKS",
    );
    expect(result).toBe("REMEMBERED");
    expect(db.log.indexOf("brandLearning.deleteMany")).toBeGreaterThan(-1);
    expect(db.log.indexOf("brandLearning.deleteMany")).toBeLessThan(
      db.log.indexOf("brandLearning.create"),
    );
    expect(db.learnings.map((row) => row.insight)).toEqual([
      "Focus channels: A, B.",
    ]);
  });

  it("G30: the delete is scoped to this key and this brand", async () => {
    db.learnings = [
      {
        id: "x1",
        brandId: "b1",
        insight: "Never: a.",
        sourceRef: "guided-setup:guardrails",
        polarity: "AVOID",
      },
      {
        id: "x2",
        brandId: "b1",
        insight: "From chat",
        sourceRef: null,
        polarity: "WORKS",
      },
      {
        id: "x3",
        brandId: "other",
        insight: "Focus channels: Z.",
        sourceRef: "guided-setup:channels",
        polarity: "WORKS",
      },
    ];
    await rememberKeyed(scope, "channels", "Focus channels: A.", "WORKS");
    expect(db.learnings.map((row) => row.id).sort()).toEqual(
      ["l1", "x1", "x2", "x3"].sort(),
    );
  });

  it("G30: the guardrails key stores an AVOID line under its own sourceRef", async () => {
    await rememberKeyed(scope, "guardrails", "Never: quote prices.", "AVOID");
    expect(db.learnings[0]).toMatchObject({
      polarity: "AVOID",
      sourceRef: "guided-setup:guardrails",
      sourceType: "USER_EXPLICIT",
    });
  });

  it("G30: a blank insight writes nothing", async () => {
    expect(await rememberKeyed(scope, "channels", "  \n ", "WORKS")).toBe(
      "UNCHANGED",
    );
    expect(db.log).toEqual([]);
  });

  it("G30: the two lines of a full plan come from the closed-vocabulary templates, at most two", async () => {
    const ideas: IdeaOptions = { business: [], audience: [], angle: [] };
    const answers: Answers = {
      channels: { picked: ["channel.instagram", "channel.linkedin"] },
      guardrails: {
        picked: ["guardrail.no_prices", "guardrail.no_competitors"],
        other: "Never joke about allergies",
      },
    };
    const plan = buildApplyPlan({ answers, ideas });
    expect(plan.channels).not.toBeNull();
    expect(plan.guardrails?.memoryLine).not.toBeNull();
    await rememberKeyed(
      scope,
      "channels",
      plan.channels?.memoryLine ?? "",
      "WORKS",
    );
    await rememberKeyed(
      scope,
      "guardrails",
      plan.guardrails?.memoryLine ?? "",
      "AVOID",
    );
    expect(db.learnings).toHaveLength(2);
    const [channels, guardrails] = db.learnings.map((row) => row.insight);
    expect(channels).toMatch(/^Focus channels: [A-Za-z ,]+\.$/);
    expect(guardrails).toMatch(/^Never: [^.]+\.$/);
    // Typed words never reach the memory line.
    expect(guardrails).not.toContain("allergies");
  });
});

// -----------------------------------------------------------------------------
// Layering (the part of G35 that belongs to this file)
// -----------------------------------------------------------------------------

describe("writers.ts imports", () => {
  it("imports none of the act-worlds", () => {
    const source = readFileSync(path.join(__dirname, "writers.ts"), "utf8");
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map(
      (match) => match[1] ?? "",
    );
    const forbidden = [
      "goal-engine",
      "autonomy-policy.repository",
      "strategic-request",
      "agency-setup-actions",
      "publish-schedule-actions",
      "agency-config-actions",
      "/integrations/",
      "/execution/",
      "command-service",
      "task-planner",
      "capability-input",
      "needs-input",
      "goal-mode",
    ];
    for (const spec of imports) {
      for (const bad of forbidden) expect(spec).not.toContain(bad);
    }
    expect(source).not.toMatch(/approveAll/);
  });
});
