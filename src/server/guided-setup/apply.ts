import "server-only";

import { createHash } from "node:crypto";

import {
  CHANNELS,
  CHANNEL_KEYS,
  PLAN_GOAL_LABEL,
  type ChannelConnections,
  type ChannelKey,
} from "@/lib/content-channels";
import {
  APPLY_LIMITS,
  AUDIT,
  EMPTY_IDEA_OPTIONS,
  FIRST_PLAN,
  RECEIPT_PART_LABELS,
  channelOptionId,
  type ApplyPart,
  type ApplyPlan,
  type ApplyResult,
  type GoalMode,
  type GuidedSetupCardData,
  type SessionRecord,
} from "@/lib/guided-setup/contract";
import { buildApplyPlan } from "@/lib/guided-setup/plan";
import { prisma } from "@/lib/prisma";
import type { ConstitutionPatch } from "@/server/brand/constitution-merge";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";

import {
  claimApply,
  finishApply,
  holdsToken,
  normalizeAnswers,
  recordGoalId,
  type ClaimResult,
  type FinishInput,
} from "./session";
import {
  isUniqueViolation,
  modifySession,
  readIdeas,
  readSession,
} from "./store";
import {
  addClientRules,
  ensureUserGoal,
  patchBrandDossier,
  publishMergedConstitution,
  rememberKeyed,
  type DossierPatch,
  type Scope,
} from "./writers";

// The Approve saga (spec 9.4, 9.5, 9.7): DB only, no model call, no network
// fetch. It persists the plan the person reviewed (dossier, constitution, one
// goal, two memory lines, client rules), writes an audit row and, only when
// something changed, one chat receipt. Everything that could act on the world
// (goal engine, autonomy policy, integrations, execution) is out of reach by
// construction: guard G35 scans this file's imports, and the two lookups that
// need those worlds (channel connections, goal mode) arrive by injection.

export type ApplyAccess = {
  userId: string;
  workspaceId: string;
  projectId: string;
  defaultBrandId?: string;
};

export type ApplyWriters = {
  patchBrandDossier: typeof patchBrandDossier;
  publishMergedConstitution: typeof publishMergedConstitution;
  ensureUserGoal: typeof ensureUserGoal;
  addClientRules: typeof addClientRules;
  rememberKeyed: typeof rememberKeyed;
};

export type ApplyDeps = {
  nowMs: () => number;
  // One random token per Approve call: it identifies THIS run in the session
  // row so a run that was taken over after going stale can tell (6.3).
  token: string;
  // ensureProjectActive from the Server Action.
  ensureActive: (projectId: string) => Promise<{ usable: boolean }>;
  // Best-effort lookups, injected so this file imports neither integrations nor
  // the autonomy policy (guard G35). A throw is never fatal.
  channelConnections: (projectId: string) => Promise<ChannelConnections>;
  goalMode: (projectId: string) => Promise<GoalMode>;
  // Test seam: replace individual writers (failures, interleavings).
  writers?: Partial<ApplyWriters>;
};

// Closed vocabulary, shared with the panel's error strings (copy.md).
const MESSAGE = {
  onHold: "This project is paused. Resume it first, then approve.",
  busy: "Your setup is being saved. Give it a moment.",
  stale: "This setup changed in another tab.",
  nothing: "There is nothing to save yet.",
  rate: "You've saved this setup many times today. Try again tomorrow.",
  failed: "Couldn't save your setup. Try again.",
  partial: (saved: ApplyPart[], failed: ApplyPart[]) =>
    `Some parts couldn't be saved. Saved: ${labelList(saved)}. Not saved: ${labelList(failed)}.`,
} as const;

const RECEIPT = {
  rawText: "Guided setup",
  replyText:
    "Your setup is saved. From now on your team works from this profile.",
} as const;

function labelList(parts: readonly ApplyPart[]): string {
  return parts.length > 0
    ? parts.map((part) => RECEIPT_PART_LABELS[part]).join(", ")
    : "none";
}

function fail(
  code: Extract<ApplyResult, { ok: false }>["code"],
  message: string,
  saved: ApplyPart[] = [],
  failed: ApplyPart[] = [],
): ApplyResult {
  return { ok: false, code, message, saved, failed };
}

// A run that no longer owns the session stops with this and finishes nothing.
class TokenLost extends Error {
  constructor() {
    super("The apply run no longer owns the session.");
  }
}

const receiptIdFor = (projectId: string, editRev: string) =>
  `gsa_${createHash("sha256")
    .update(`${projectId}:${editRev}`)
    .digest("hex")
    .slice(0, 24)}`;

const CHANNEL_IDS = CHANNEL_KEYS.map(channelOptionId);

// Best effort by contract: the trail must never turn saved work into a failure.
async function audit(
  access: ApplyAccess,
  brandId: string | undefined,
  action: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    await AuditLogRepository.record({
      workspaceId: access.workspaceId,
      projectId: access.projectId,
      ...(brandId ? { brandId } : {}),
      actorType: "USER",
      actorId: access.userId,
      action,
      entityType: "Project",
      entityId: access.projectId,
      metadata,
    });
  } catch (error) {
    console.error(
      "[guided-setup] audit write failed:",
      error instanceof Error ? error.message : error,
    );
  }
}

type PartRun = { part: ApplyPart; run: () => Promise<boolean> };

export async function applyGuidedSetup(
  input: { access: ApplyAccess; userId: string; expectedRev: string },
  deps: ApplyDeps,
): Promise<ApplyResult> {
  const { access, userId, expectedRev } = input;
  const { projectId, workspaceId } = access;
  const { token } = deps;
  const writers: ApplyWriters = {
    patchBrandDossier,
    publishMergedConstitution,
    ensureUserGoal,
    addClientRules,
    rememberKeyed,
    ...deps.writers,
  };
  let claimed = false;

  // Finishes the claimed run. LOST = another run or a save owns the session now.
  const finish = async (result: FinishInput): Promise<"OK" | "LOST"> => {
    const modified = await modifySession(
      projectId,
      (record) => {
        const finished = finishApply(record, token, result);
        return "error" in finished
          ? { error: "LOST" }
          : { next: finished.next, value: true };
      },
      { attempts: 5 },
    );
    if (modified.status === "OK") return "OK";
    if (modified.status === "REJECTED" && modified.error === "LOST") {
      return "LOST";
    }
    throw new Error("The session could not be finished.");
  };

  try {
    // 1. Session.
    const session = await readSession(projectId);
    if (!session) return fail("FAILED", MESSAGE.failed);

    // 2. Paused or closed projects change nothing.
    const activation = await deps.ensureActive(projectId);
    if (!activation.usable) return fail("ON_HOLD", MESSAGE.onHold);

    // Durable per-project cap. The free ALREADY_APPLIED no-op of step 3 writes
    // nothing, so it must not be refused by (or counted against) the cap.
    const alreadyApplied =
      session.status === "DONE" && session.applied?.editRev === expectedRev;
    if (!alreadyApplied) {
      const since = new Date(deps.nowMs() - APPLY_LIMITS.windowMs);
      const used = await prisma.auditLog.count({
        where: {
          projectId,
          action: AUDIT.applied,
          createdAt: { gte: since },
        },
      });
      if (used >= APPLY_LIMITS.perProjectPer24h) {
        return fail("RATE", MESSAGE.rate);
      }
    }

    // 3. Claim, checked in the order ALREADY_APPLIED, BUSY, STALE.
    // The callback may run again after a lost compare-and-swap: the box keeps
    // the verdict of the LAST attempt, which is the one that counts.
    const verdict: { last?: ClaimResult } = {};
    const claimedRow = await modifySession(projectId, (current) => {
      const result = claimApply(current, expectedRev, deps.nowMs(), token);
      verdict.last = result;
      return result.outcome === "CLAIMED"
        ? { next: result.next, value: true }
        : { error: result.outcome };
    });
    if (claimedRow.status === "NONE") return fail("FAILED", MESSAGE.failed);
    const last = verdict.last;
    if (last?.outcome === "ALREADY_APPLIED") {
      return {
        ok: true,
        parts: last.applied.parts,
        unchanged: true,
        goalMode: last.applied.goalMode,
        unconnected: [],
      };
    }
    if (last?.outcome === "STALE") return fail("STALE", MESSAGE.stale);
    // BUSY, or every compare-and-swap attempt lost to a concurrent writer.
    if (claimedRow.status !== "OK") return fail("BUSY", MESSAGE.busy);
    claimed = true;
    const record: SessionRecord = claimedRow.record;

    // 4. The plan, from the stored session and the stored ideas row.
    const ideasRow = await readIdeas(projectId);
    const ideaOptions = ideasRow?.options ?? EMPTY_IDEA_OPTIONS;
    const answers = normalizeAnswers(record.answers, {
      channelIds: CHANNEL_IDS,
      ideas: ideaOptions,
    });
    const mode: GoalMode = await deps
      .goalMode(projectId)
      .catch(() => "proposed");
    const plan = buildApplyPlan({
      answers,
      ideas: ideaOptions,
      goalMode: mode,
    });
    if (plan.empty) {
      if ((await finish({ status: "OPEN", nowMs: deps.nowMs() })) === "LOST") {
        return fail("BUSY", MESSAGE.busy);
      }
      return fail("NOTHING", MESSAGE.nothing);
    }

    const [project, brandId] = await Promise.all([
      prisma.project.findUnique({
        where: { id: projectId },
        select: { language: true, country: true },
      }),
      access.defaultBrandId
        ? Promise.resolve(access.defaultBrandId)
        : prisma.brand
            .findFirst({
              where: { projectId },
              orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
              select: { id: true },
            })
            .then((brand) => brand?.id),
    ]);
    if (!project || !brandId) throw new Error("The project has no brand.");
    const scope: Scope = { workspaceId, projectId, brandId };
    const locale = { language: project.language, country: project.country };

    // 5. Parts, in order, each in its own try/catch and each preceded by a
    // token check.
    const holds = async () => {
      const current = await readSession(projectId);
      return current !== null && holdsToken(current, token);
    };
    const recordGoal = async (goalId: string) => {
      const written = await modifySession(projectId, (current) => {
        const result = recordGoalId(current, token, goalId);
        return "error" in result
          ? { error: "LOST" }
          : { next: result.next, value: true };
      });
      if (written.status === "OK") return;
      if (written.status === "REJECTED" && written.error === "LOST") {
        throw new TokenLost();
      }
      throw new Error("The goal id could not be recorded.");
    };

    const details = { rules: 0 };
    const runs = partsOf({
      plan,
      scope,
      locale,
      userId,
      previousGoalId: record.goalId,
      mode,
      writers,
      recordGoal,
      details,
    });

    const saved: ApplyPart[] = [];
    const failed: ApplyPart[] = [];
    const changed: ApplyPart[] = [];
    for (const { part, run } of runs) {
      if (!(await holds())) return fail("BUSY", MESSAGE.busy);
      try {
        if (await run()) changed.push(part);
        saved.push(part);
      } catch (error) {
        if (error instanceof TokenLost) return fail("BUSY", MESSAGE.busy);
        failed.push(part);
        console.error(
          `[guided-setup] apply part "${part}" failed:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
    if (!(await holds())) return fail("BUSY", MESSAGE.busy);

    // 6a. A failed part: no receipt, back to OPEN with lastFailure.
    if (failed.length > 0) {
      await audit(access, brandId, AUDIT.applyFailed, {
        editRev: expectedRev,
        saved,
        failed,
      });
      const finished = await finish({
        status: "OPEN",
        failed,
        nowMs: deps.nowMs(),
      });
      if (finished === "LOST") return fail("BUSY", MESSAGE.busy);
      return fail("PARTIAL", MESSAGE.partial(saved, failed), saved, failed);
    }

    // 6b. Every part reported UNCHANGED: nothing to tell the chat about.
    const goalMode = plan.goal ? plan.goal.mode : null;
    const parts = saved;
    if (changed.length === 0) {
      await audit(access, brandId, AUDIT.applied, {
        editRev: expectedRev,
        parts,
        unchanged: true,
        goalMode,
      });
      const finished = await finish({
        status: "DONE",
        parts,
        goalMode,
        receiptId: record.applied?.receiptId ?? null,
        nowMs: deps.nowMs(),
      });
      if (finished === "LOST") return fail("BUSY", MESSAGE.busy);
      return { ok: true, parts, unchanged: true, goalMode, unconnected: [] };
    }

    // 6c. Something changed: one receipt (deterministic id), audit, DONE.
    const unconnected = await unconnectedChannels(plan, projectId, deps);
    const receiptId = receiptIdFor(projectId, expectedRev);
    const receiptWritten = await writeReceipt({
      id: receiptId,
      access,
      brandId,
      plan,
      parts,
      unconnected,
    });
    await audit(access, brandId, AUDIT.applied, {
      editRev: expectedRev,
      parts,
      changed,
      unchanged: false,
      goalMode,
      rules: details.rules,
      receipt: receiptWritten,
    });
    const finished = await finish({
      status: "DONE",
      parts,
      goalMode,
      receiptId: receiptWritten
        ? receiptId
        : (record.applied?.receiptId ?? null),
      nowMs: deps.nowMs(),
    });
    if (finished === "LOST") return fail("BUSY", MESSAGE.busy);
    return { ok: true, parts, unchanged: false, goalMode, unconnected };
  } catch (error) {
    console.error(
      "[guided-setup] apply failed:",
      error instanceof Error ? error.message : error,
    );
    // Release our claim so the person is not stuck behind APPLYING for 90 s.
    if (claimed) {
      await finish({ status: "OPEN", nowMs: deps.nowMs() }).catch(
        () => undefined,
      );
    }
    return fail("FAILED", MESSAGE.failed);
  }
}

// The plan's parts as runnable steps, in the order of the saga. Each returns
// whether it changed anything.
function partsOf(input: {
  plan: ApplyPlan;
  scope: Scope;
  locale: { language: string; country: string };
  userId: string;
  previousGoalId: string | null;
  mode: GoalMode;
  writers: ApplyWriters;
  recordGoal: (goalId: string) => Promise<void>;
  details: { rules: number };
}): PartRun[] {
  const { plan, scope, locale, userId, writers } = input;
  const runs: PartRun[] = [];

  const profile = plan.profile;
  if (profile) {
    runs.push({
      part: "profile",
      run: async () => {
        // The workers' layer first (dossier), then Brand Core (constitution).
        const dossier: DossierPatch = {
          ...(profile.identity !== undefined
            ? { summary: profile.identity }
            : {}),
          ...(profile.positioning !== undefined
            ? { positioning: profile.positioning }
            : {}),
          ...(profile.toneOfVoice !== undefined
            ? { toneOfVoice: profile.toneOfVoice }
            : {}),
          ...(profile.audiences !== undefined
            ? { targetAudiences: profile.audiences }
            : {}),
        };
        const patch: ConstitutionPatch = {
          ...(profile.identity !== undefined
            ? { identity: profile.identity }
            : {}),
          ...(profile.positioning !== undefined
            ? { positioning: profile.positioning }
            : {}),
          ...(profile.toneOfVoice !== undefined
            ? { toneOfVoice: profile.toneOfVoice }
            : {}),
          ...(profile.audiences !== undefined
            ? { audiences: profile.audiences }
            : {}),
        };
        const first = await writers.patchBrandDossier(scope, dossier, locale);
        const second = await writers.publishMergedConstitution(
          scope,
          patch,
          locale,
          userId,
        );
        return first !== "UNCHANGED" || second !== "UNCHANGED";
      },
    });
  }

  const goal = plan.goal;
  if (goal) {
    runs.push({
      part: "goal",
      run: async () => {
        const result = await writers.ensureUserGoal(
          scope,
          userId,
          { key: goal.key, title: goal.title, metricKey: goal.metricKey },
          input.previousGoalId,
          input.mode,
          { onGoalId: input.recordGoal },
        );
        return result.outcome !== "UNCHANGED";
      },
    });
  }

  const channels = plan.channels;
  if (channels) {
    runs.push({
      part: "channels",
      run: async () =>
        (await writers.rememberKeyed(
          scope,
          "channels",
          channels.memoryLine,
          "WORKS",
        )) !== "UNCHANGED",
    });
  }

  const guardrails = plan.guardrails;
  if (guardrails) {
    runs.push({
      part: "guardrails",
      run: async () => {
        const rules = await writers.addClientRules(
          scope,
          guardrails.rules.map((rule) => rule.text),
        );
        input.details.rules = rules.added;
        const memory = guardrails.memoryLine
          ? await writers.rememberKeyed(
              scope,
              "guardrails",
              guardrails.memoryLine,
              "AVOID",
            )
          : "UNCHANGED";
        return rules.added > 0 || memory !== "UNCHANGED";
      },
    });
  }

  return runs;
}

// The social channels the person picked that have no connected account.
// Best effort: a failing lookup yields none (no "Connect accounts" button) and
// fails no part. A channel the lookup does not mention is not listed.
async function unconnectedChannels(
  plan: ApplyPlan,
  projectId: string,
  deps: ApplyDeps,
): Promise<ChannelKey[]> {
  const social = (plan.channels?.keys ?? []).filter(
    (key) => CHANNELS[key].group === "social",
  );
  if (social.length === 0) return [];
  let connections: ChannelConnections = {};
  try {
    connections = await deps.channelConnections(projectId);
  } catch {
    return [];
  }
  return social.filter((key) => connections[key]?.connected === false);
}

// Closed-vocabulary receipt: it becomes user/assistant history for the agent
// and the legacy classifier. The id is deterministic, so a second write for the
// same setup version hits the primary key (P2002) and is ignored. Returns
// whether the receipt exists afterwards.
async function writeReceipt(input: {
  id: string;
  access: ApplyAccess;
  brandId: string;
  plan: ApplyPlan;
  parts: ApplyPart[];
  unconnected: ChannelKey[];
}): Promise<boolean> {
  const { plan, access } = input;
  const focus = plan.channels?.keys ?? [];
  const card: GuidedSetupCardData = {
    kind: "guided-setup",
    projectId: access.projectId,
    state: "done",
    summary: {
      ...(plan.goal
        ? {
            goal: PLAN_GOAL_LABEL[plan.goal.key].label,
            goalProposed: plan.goal.mode === "proposed",
          }
        : {}),
      ...(focus.length > 0
        ? {
            channels: focus.map((key) => CHANNELS[key].label),
            unconnected: input.unconnected,
          }
        : {}),
      saved: input.parts.map((part) => RECEIPT_PART_LABELS[part]),
      canDraftPlan:
        plan.goal !== null &&
        focus.some((key) => !FIRST_PLAN.excludedChannels.includes(key)),
    },
  };
  try {
    await prisma.command.create({
      data: {
        id: input.id,
        workspaceId: access.workspaceId,
        projectId: access.projectId,
        brandId: input.brandId,
        topic: null,
        source: "WEB",
        rawText: RECEIPT.rawText,
        replyText: RECEIPT.replyText,
        replyStatus: "ANSWERED",
        parsedIntent: { card } as never,
        createdByUserId: access.userId,
      },
    });
    return true;
  } catch (error) {
    if (isUniqueViolation(error)) return true;
    console.error(
      "[guided-setup] receipt write failed:",
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}
