import "server-only";

import type { LearningPolarity, ProjectGoalStatus } from "@prisma/client";

import type { PlanGoal } from "@/lib/content-channels";
import type { GoalMode } from "@/lib/guided-setup/contract";
import { prisma } from "@/lib/prisma";
import {
  ConstitutionConflictError,
  ConstitutionService,
} from "@/server/agency/constitution/constitution-service";
import {
  baseOf,
  mergeConstitution,
  type ConstitutionPatch,
  type ProjectLocale,
  type ThinSeed,
} from "@/server/brand/constitution-merge";
import { MemoryService, cleanInsight } from "@/server/memory/memory-service";
import { BrandConstitutionRepository } from "@/server/repositories/brand-constitution.repository";
import { ProjectGoalRepository } from "@/server/repositories/project-goal.repository";

// The guided-setup writers (spec 9.2). Every one is idempotent and takes plan
// fields only (static catalog labels, stored sanitized option labels, the
// person's own typed words): none of them accepts free model text. They import
// none of the "act" worlds (goal engine, autonomy policy, integrations,
// execution, command service, task planner): guard G35 scans this file.

export type Scope = { workspaceId: string; projectId: string; brandId: string };
type Locale = ProjectLocale;

export type DossierPatch = {
  summary?: string;
  positioning?: string;
  toneOfVoice?: string;
  targetAudiences?: string[];
};

const DOSSIER_KEYS = [
  "summary",
  "positioning",
  "toneOfVoice",
  "targetAudiences",
] as const;

const isBlank = (value: string | null | undefined) =>
  value === null || value === undefined || value.trim() === "";

// -----------------------------------------------------------------------------
// BrandDossier: partial upsert
// -----------------------------------------------------------------------------

// Writes ONLY the defined keys (never the full replace of updateBrandDossier
// Action). language/country mirror the project: set on create, and on update
// only while the dossier has none (a hand-edited value is never overwritten).
// Skips the write when nothing differs.
export async function patchBrandDossier(
  scope: Scope,
  patch: DossierPatch,
  locale: Locale,
): Promise<"UPDATED" | "UNCHANGED"> {
  const defined: DossierPatch = {};
  for (const key of DOSSIER_KEYS) {
    if (patch[key] === undefined) continue;
    if (key === "targetAudiences") defined[key] = [...(patch[key] ?? [])];
    else defined[key] = patch[key];
  }
  if (Object.keys(defined).length === 0) return "UNCHANGED";

  const existing = await prisma.brandDossier.findUnique({
    where: { brandId: scope.brandId },
  });

  if (!existing) {
    await prisma.brandDossier.create({
      data: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        brandId: scope.brandId,
        ...defined,
        language: locale.language,
        country: locale.country,
      },
    });
    return "UPDATED";
  }

  const data: DossierPatch & { language?: string; country?: string } = {};
  if (defined.summary !== undefined && defined.summary !== existing.summary) {
    data.summary = defined.summary;
  }
  if (
    defined.positioning !== undefined &&
    defined.positioning !== existing.positioning
  ) {
    data.positioning = defined.positioning;
  }
  if (
    defined.toneOfVoice !== undefined &&
    defined.toneOfVoice !== existing.toneOfVoice
  ) {
    data.toneOfVoice = defined.toneOfVoice;
  }
  if (
    defined.targetAudiences !== undefined &&
    JSON.stringify(defined.targetAudiences) !==
      JSON.stringify(existing.targetAudiences)
  ) {
    data.targetAudiences = defined.targetAudiences;
  }
  if (Object.keys(data).length === 0) return "UNCHANGED";

  if (isBlank(existing.language) && !isBlank(locale.language)) {
    data.language = locale.language;
  }
  if (isBlank(existing.country) && !isBlank(locale.country)) {
    data.country = locale.country;
  }
  await prisma.brandDossier.update({
    where: { brandId: scope.brandId },
    data,
  });
  return "UPDATED";
}

// -----------------------------------------------------------------------------
// Constitution: merged NEW version
// -----------------------------------------------------------------------------

const isUniqueViolation = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  (error as { code?: unknown }).code === "P2002";

const stringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

// The thin first version starts from what the dossier already says: the
// workers' context falls back to the dossier only while NO constitution is
// active, so an empty v1 would hide a hand-edited dossier from every worker.
async function dossierSeed(brandId: string): Promise<ThinSeed> {
  const dossier = await prisma.brandDossier.findUnique({ where: { brandId } });
  if (!dossier) return {};
  return {
    identity: dossier.summary,
    positioning: dossier.positioning,
    toneOfVoice: dossier.toneOfVoice,
    audiences: stringList(dossier.targetAudiences),
  };
}

const hasPatch = (patch: ConstitutionPatch) =>
  patch.identity !== undefined ||
  patch.positioning !== undefined ||
  patch.toneOfVoice !== undefined ||
  patch.audiences !== undefined;

// A MOCK active row is ABSENT (nothing mock is ever copied into a real
// version), an unparseable real payload FAILS the part (a thin version is never
// published over it). One retry from a fresh read when another writer got in
// between (typed conflict or the unique (brandId, version) violation).
export async function publishMergedConstitution(
  scope: Scope,
  patch: ConstitutionPatch,
  locale: Locale,
  userId: string,
): Promise<"CREATED" | "UPDATED" | "UNCHANGED"> {
  for (let attempt = 0; ; attempt += 1) {
    const active = await BrandConstitutionRepository.getActive(scope.brandId);
    const base = baseOf(
      active ? { isMock: active.isMock, payload: active.payload } : null,
    );
    if (base.kind === "unreadable") {
      throw new Error(
        "The active brand constitution could not be read; nothing was published over it.",
      );
    }
    const realBase = base.kind === "base" ? base.payload : null;
    // A setup that answered no profile question never creates a constitution.
    if (realBase === null && !hasPatch(patch)) return "UNCHANGED";

    const seed = realBase ? {} : await dossierSeed(scope.brandId);
    const merged = mergeConstitution(realBase, patch, locale, seed);
    if (!merged.changed) return "UNCHANGED";

    try {
      await ConstitutionService.publishVersion({
        scope,
        payload: merged.payload,
        isMock: false,
        sourceFindingIds: [],
        evidenceIds: [],
        note: "guided setup",
        decidedBy: { type: "USER", userId },
        ifActiveVersion: active?.version ?? null,
      });
    } catch (error) {
      const raced =
        error instanceof ConstitutionConflictError || isUniqueViolation(error);
      if (raced && attempt === 0) continue;
      throw error;
    }
    return realBase ? "UPDATED" : "CREATED";
  }
}

// -----------------------------------------------------------------------------
// Goal
// -----------------------------------------------------------------------------

type GoalRow = Awaited<
  ReturnType<typeof ProjectGoalRepository.listForProject>
>[number];

const NON_TERMINAL: readonly ProjectGoalStatus[] = [
  "PROPOSED",
  "APPROVED",
  "ACTIVE",
];
const STATUS_RANK: Partial<Record<ProjectGoalStatus, number>> = {
  ACTIVE: 0,
  APPROVED: 1,
  PROPOSED: 2,
};

// Creates the goal from a code preset and, in "active" mode, walks it to ACTIVE
// on the person's behalf (PROPOSED -> APPROVED by the USER -> ACTIVE, the shape
// of agency-strategy-actions). "proposed" mode stops at PROPOSED: a goal the
// autonomous director cannot see. Never a bulk approval.
export async function ensureUserGoal(
  scope: Scope,
  userId: string,
  goal: { key: PlanGoal; title: string; metricKey: string },
  previousGoalId: string | null,
  mode: GoalMode,
  hooks?: { onGoalId?: (id: string) => Promise<void> },
): Promise<{
  goalId: string;
  outcome: "CREATED" | "UNCHANGED" | "REPLACED";
}> {
  const goals = await ProjectGoalRepository.listForProject(scope.projectId);
  const title = goal.title.trim().toLowerCase();
  const reusable = goals
    .filter(
      (row) =>
        !row.isMock &&
        NON_TERMINAL.includes(row.status) &&
        row.title.trim().toLowerCase() === title,
    )
    .sort(
      (a, b) =>
        Number(b.id === previousGoalId) - Number(a.id === previousGoalId) ||
        (STATUS_RANK[a.status] ?? 3) - (STATUS_RANK[b.status] ?? 3),
    )[0];

  // The previous goal is retired BEFORE the session learns the new id (the
  // onGoalId hook overwrites the only copy of the old one) and before the
  // approval steps. Were it retired last, a failure in between would leave the
  // retry with previousGoalId === the new goal: the old goal would stay ACTIVE
  // beside it, two priority-1 goals that never heal. This way a failure leaves
  // the old id recorded (retired again on retry, a no-op once terminal) or a
  // retired old goal with the new one reused by title on retry.
  const retireIfReplaced = async (id: string): Promise<boolean> =>
    previousGoalId !== null && previousGoalId !== id
      ? retirePrevious(scope, previousGoalId)
      : false;

  let goalId: string;
  let changed = false;
  let replaced = false;
  if (reusable) {
    goalId = reusable.id;
    replaced = await retireIfReplaced(goalId);
    if (mode === "active") {
      changed = await activate(scope, userId, reusable);
    }
    await hooks?.onGoalId?.(goalId);
  } else {
    // currentFocus has no tie-break between equal priorities, so a new goal
    // yields to an ACTIVE priority-1 goal (the one being replaced excepted).
    const takenFirst = goals.some(
      (row) =>
        row.status === "ACTIVE" &&
        row.priority === 1 &&
        row.id !== previousGoalId,
    );
    const [created] = await ProjectGoalRepository.createMany([
      {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        brandId: scope.brandId,
        title: goal.title,
        metricKey: goal.metricKey,
        priority: takenFirst ? 2 : 1,
        isMock: false,
      },
    ]);
    if (!created) throw new Error("The goal could not be created.");
    goalId = created.id;
    changed = true;
    replaced = await retireIfReplaced(goalId);
    // Before the approval steps: the saga stores the id so a crash cannot
    // orphan it.
    await hooks?.onGoalId?.(goalId);
    if (mode === "active") {
      await ProjectGoalRepository.transition(
        goalId,
        scope.projectId,
        "APPROVED",
        {
          approvedByType: "USER",
          approvedByUserId: userId,
        },
      );
      await ProjectGoalRepository.transition(goalId, scope.projectId, "ACTIVE");
    }
  }

  return {
    goalId,
    outcome: replaced ? "REPLACED" : changed ? "CREATED" : "UNCHANGED",
  };
}

// PROPOSED -> APPROVED(USER) -> ACTIVE, APPROVED -> ACTIVE, ACTIVE untouched.
async function activate(
  scope: Scope,
  userId: string,
  row: GoalRow,
): Promise<boolean> {
  if (row.status === "ACTIVE") return false;
  if (row.status === "PROPOSED") {
    await ProjectGoalRepository.transition(
      row.id,
      scope.projectId,
      "APPROVED",
      {
        approvedByType: "USER",
        approvedByUserId: userId,
      },
    );
  }
  await ProjectGoalRepository.transition(row.id, scope.projectId, "ACTIVE");
  return true;
}

// The goal this session created earlier and the person has since replaced:
// ACTIVE|APPROVED -> ARCHIVED, PROPOSED -> REJECTED. Any other goal is never
// touched; a goal already terminal or paused is left as it is.
async function retirePrevious(
  scope: Scope,
  previousGoalId: string,
): Promise<boolean> {
  const previous = await ProjectGoalRepository.findByIdInProject(
    previousGoalId,
    scope.projectId,
  );
  if (!previous) return false;
  if (previous.status === "ACTIVE" || previous.status === "APPROVED") {
    await ProjectGoalRepository.transition(
      previous.id,
      scope.projectId,
      "ARCHIVED",
    );
    return true;
  }
  if (previous.status === "PROPOSED") {
    await ProjectGoalRepository.transition(
      previous.id,
      scope.projectId,
      "REJECTED",
    );
    return true;
  }
  return false;
}

// -----------------------------------------------------------------------------
// Client rules
// -----------------------------------------------------------------------------

const ruleKey = (text: string) => text.trim().toLowerCase();

// Additive; a rule whose trimmed lowercase text already exists in ANY category
// is skipped (the dedupe rule of the constitution promotion). The category
// survives every later constitution promotion.
export async function addClientRules(
  scope: Scope,
  rules: string[],
): Promise<{ added: number; skipped: number }> {
  const existing = await prisma.negativeBriefRule.findMany({
    where: { brandId: scope.brandId },
    select: { rule: true },
  });
  const seen = new Set(existing.map((row) => ruleKey(row.rule)));
  const fresh: string[] = [];
  let skipped = 0;
  for (const rule of rules) {
    const text = rule.trim();
    const key = ruleKey(text);
    if (!key || seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    fresh.push(text);
  }
  if (fresh.length > 0) {
    await prisma.negativeBriefRule.createMany({
      data: fresh.map((rule) => ({
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        brandId: scope.brandId,
        rule,
        category: "client-rule",
        active: true,
      })),
    });
  }
  return { added: fresh.length, skipped };
}

// -----------------------------------------------------------------------------
// Keyed memory line
// -----------------------------------------------------------------------------

// One line per key. remember() only reinforces IDENTICAL text, so "Focus
// channels: A" followed by "Focus channels: A, B" would leave two standing
// memories: the old keyed line is deleted first.
export async function rememberKeyed(
  scope: Scope,
  key: "channels" | "guardrails",
  insight: string,
  polarity: LearningPolarity,
): Promise<"UNCHANGED" | "REMEMBERED"> {
  const cleaned = cleanInsight(insight);
  if (!cleaned) return "UNCHANGED";
  const sourceRef = `guided-setup:${key}`;
  const existing = await prisma.brandLearning.findFirst({
    where: { brandId: scope.brandId, sourceRef },
  });
  if (
    existing &&
    existing.insight === cleaned &&
    existing.polarity === polarity
  ) {
    return "UNCHANGED";
  }
  await prisma.brandLearning.deleteMany({
    where: { brandId: scope.brandId, sourceRef },
  });
  const result = await MemoryService.remember({
    scope,
    insight: cleaned,
    polarity,
    source: "USER_EXPLICIT",
    sourceRef,
  });
  if (result.status === "REJECTED") {
    throw new Error("The memory line was rejected.");
  }
  return "REMEMBERED";
}
