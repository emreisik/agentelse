import { z } from "zod";

// Work Session: a multi-step job the chat agent runs end to end in one
// conversation ("research the competitors, write three concepts, render the
// best one"). It is only a checkpoint: a goal, an ordered list of steps with
// their state, and links to what the steps produced. It has no queue, no worker
// and no Task of its own (the actions inside it are the ordinary chat tools),
// so nothing here depends on the legacy agency loop.
//
// Pure module (no server-only, no database) so the rules can be tested alone;
// work-session-service.ts persists it.

// The Command row that holds a session carries this topic. The general chat
// feed and the agent's history only read `topic: null` rows, so the checkpoint
// never shows up as a message and needs no migration.
export const WORK_SESSION_TOPIC = "WORK_SESSION";

export const STEP_STATUSES = [
  "PENDING",
  "IN_PROGRESS",
  "DONE",
  "BLOCKED",
  "SKIPPED",
] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

// ACTIVE until every step is settled (COMPLETED), the client stops it or its
// budget runs out (CANCELLED). A session nobody touches for a while is simply no
// longer live (isLive); nothing rewrites it.
export const SESSION_STATUSES = ["ACTIVE", "COMPLETED", "CANCELLED"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

// What a step can point at. Only things whose id the agent actually gets back
// from a tool result.
export const ARTIFACT_KINDS = ["task", "idea"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const SESSION_LIMITS = {
  minSteps: 2,
  maxStartSteps: 8,
  maxSteps: 12,
  goalChars: 300,
  stepChars: 140,
  noteChars: 300,
  reasonChars: 200,
  labelChars: 80,
  maxArtifactsPerStep: 6,
  // A session left alone this long stops counting as the project's live one.
  idleExpiryMs: 48 * 60 * 60 * 1000,
  // Model spend one session may use across all of its messages.
  maxSpendUsd: 5,
} as const;

const ARTIFACT_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type SessionArtifact = {
  kind: ArtifactKind;
  id: string;
  label?: string;
};

export type SessionStep = {
  id: string;
  title: string;
  status: StepStatus;
  note?: string;
  artifacts: SessionArtifact[];
};

export type WorkSession = {
  v: 1;
  // Changes on every write; the store compares it to catch two requests
  // updating the same session at once.
  rev: string;
  goal: string;
  status: SessionStatus;
  steps: SessionStep[];
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  endReason?: string;
  // Chat messages that worked on it, and the model spend they used.
  turns: number;
  spentUsd: number;
};

const ArtifactSchema = z.object({
  kind: z.enum(ARTIFACT_KINDS),
  id: z.string().min(1).max(64),
  label: z.string().max(SESSION_LIMITS.labelChars).optional(),
});

// Reads a stored checkpoint back. A row that does not match (hand-edited, from
// a later version) is treated as no session rather than trusted.
export const WorkSessionSchema = z.object({
  v: z.literal(1),
  rev: z.string(),
  goal: z.string(),
  status: z.enum(SESSION_STATUSES),
  steps: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        status: z.enum(STEP_STATUSES),
        note: z.string().optional(),
        artifacts: z.array(ArtifactSchema).default([]),
      }),
    )
    .min(1),
  startedAt: z.string(),
  updatedAt: z.string(),
  endedAt: z.string().optional(),
  endReason: z.string().optional(),
  turns: z.number().int().nonnegative(),
  spentUsd: z.number().nonnegative(),
});

// One line of plain text: no control characters, single spaces, bounded. What
// is stored is shown to the model on later turns, so it must not carry markup
// that looks like structure.
export function oneLine(text: string, max: number): string {
  const flat = text
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

const stepTitles = (titles: readonly string[]): string[] =>
  titles
    .map((title) => oneLine(title, SESSION_LIMITS.stepChars))
    .filter(Boolean);

export type CreateResult =
  { ok: true; session: WorkSession } | { ok: false; error: string };

export function createSession(
  input: { goal: string; steps: readonly string[] },
  now: Date,
  rev: string,
): CreateResult {
  const goal = oneLine(input.goal, SESSION_LIMITS.goalChars);
  const titles = stepTitles(input.steps);
  if (!goal) return { ok: false, error: "A work session needs a goal." };
  if (titles.length < SESSION_LIMITS.minSteps) {
    return {
      ok: false,
      error: `A work session needs at least ${SESSION_LIMITS.minSteps} steps; a single action does not need one.`,
    };
  }
  if (titles.length > SESSION_LIMITS.maxStartSteps) {
    return {
      ok: false,
      error: `Start with at most ${SESSION_LIMITS.maxStartSteps} steps; more can be added later.`,
    };
  }
  const stamp = now.toISOString();
  return {
    ok: true,
    session: {
      v: 1,
      rev,
      goal,
      status: "ACTIVE",
      steps: titles.map((title, index) => ({
        id: `s${index + 1}`,
        title,
        status: "PENDING",
        artifacts: [],
      })),
      startedAt: stamp,
      updatedAt: stamp,
      turns: 0,
      spentUsd: 0,
    },
  };
}

export function isLive(session: WorkSession, now: Date): boolean {
  if (session.status !== "ACTIVE") return false;
  const touched = Date.parse(session.updatedAt);
  return (
    Number.isFinite(touched) &&
    now.getTime() - touched < SESSION_LIMITS.idleExpiryMs
  );
}

export function remainingBudgetUsd(session: WorkSession): number {
  return Math.max(0, SESSION_LIMITS.maxSpendUsd - session.spentUsd);
}

export type SessionUpdate = {
  stepId?: string;
  status?: StepStatus;
  note?: string;
  artifacts?: readonly SessionArtifact[];
  addSteps?: readonly string[];
  cancel?: boolean;
  reason?: string;
};

export type UpdateOutcome =
  | {
      ok: true;
      session: WorkSession;
      // Set when this update closed the session.
      ended: "COMPLETED" | "CANCELLED" | null;
      // Parts of the update that were left out and why (see freeText).
      ignored: string[];
    }
  | { ok: false; error: string };

const settled = (step: SessionStep) =>
  step.status === "DONE" || step.status === "SKIPPED";

// Applies one update. `freeText: false` is for a message that already read
// content from outside the conversation (web, stored research): the model's
// words in that message could have come from a page, so notes, labels, new steps
// and reasons are dropped and only the state itself (statuses, artifact ids,
// cancelling) is recorded.
export function applyUpdate(
  session: WorkSession,
  update: SessionUpdate,
  options: { now: Date; freeText: boolean },
): UpdateOutcome {
  if (session.status !== "ACTIVE") {
    return { ok: false, error: "This work session has already ended." };
  }
  const stamp = options.now.toISOString();
  const ignored: string[] = [];

  if (update.cancel) {
    const reason =
      options.freeText && update.reason
        ? oneLine(update.reason, SESSION_LIMITS.reasonChars)
        : "";
    if (!options.freeText && update.reason) ignored.push("reason");
    return {
      ok: true,
      session: {
        ...session,
        status: "CANCELLED",
        endedAt: stamp,
        endReason: reason || "cancelled",
        updatedAt: stamp,
      },
      ended: "CANCELLED",
      ignored,
    };
  }

  const touchesStep =
    update.status !== undefined ||
    update.note !== undefined ||
    (update.artifacts?.length ?? 0) > 0;
  if (touchesStep && !update.stepId) {
    return { ok: false, error: "stepId is required to update a step." };
  }
  if (!touchesStep && !update.addSteps?.length) {
    return {
      ok: false,
      error:
        "Nothing to update: give a step with a status, a note or artifacts, or steps to add.",
    };
  }

  let steps = session.steps;
  if (update.stepId && touchesStep) {
    const target = steps.find((step) => step.id === update.stepId);
    if (!target) {
      return {
        ok: false,
        error: `Unknown step "${update.stepId}". Steps: ${steps.map((step) => step.id).join(", ")}.`,
      };
    }
    let note = target.note;
    if (update.note !== undefined) {
      if (options.freeText) {
        note = oneLine(update.note, SESSION_LIMITS.noteChars) || undefined;
      } else {
        ignored.push("note");
      }
    }
    const artifacts = mergeArtifacts(
      target.artifacts,
      update.artifacts ?? [],
      options.freeText,
    );
    if (!options.freeText && update.artifacts?.some((a) => a.label)) {
      ignored.push("artifact labels");
    }
    const changed: SessionStep = {
      ...target,
      status: update.status ?? target.status,
      note,
      artifacts,
    };
    steps = steps.map((step) => (step.id === target.id ? changed : step));
  }

  if (update.addSteps?.length) {
    if (!options.freeText) {
      ignored.push("added steps");
    } else {
      const titles = stepTitles(update.addSteps);
      if (steps.length + titles.length > SESSION_LIMITS.maxSteps) {
        return {
          ok: false,
          error: `A session can have at most ${SESSION_LIMITS.maxSteps} steps.`,
        };
      }
      steps = [
        ...steps,
        ...titles.map((title, index) => ({
          id: `s${steps.length + index + 1}`,
          title,
          status: "PENDING" as const,
          artifacts: [],
        })),
      ];
    }
  }

  const done = steps.every(settled);
  return {
    ok: true,
    session: {
      ...session,
      steps,
      status: done ? "COMPLETED" : "ACTIVE",
      ...(done ? { endedAt: stamp } : {}),
      updatedAt: stamp,
    },
    ended: done ? "COMPLETED" : null,
    ignored,
  };
}

function mergeArtifacts(
  existing: readonly SessionArtifact[],
  incoming: readonly SessionArtifact[],
  freeText: boolean,
): SessionArtifact[] {
  const merged = [...existing];
  for (const artifact of incoming) {
    if (!ARTIFACT_ID.test(artifact.id)) continue;
    if (merged.some((a) => a.kind === artifact.kind && a.id === artifact.id)) {
      continue;
    }
    if (merged.length >= SESSION_LIMITS.maxArtifactsPerStep) break;
    const label =
      freeText && artifact.label
        ? oneLine(artifact.label, SESSION_LIMITS.labelChars)
        : "";
    merged.push({
      kind: artifact.kind,
      id: artifact.id,
      ...(label ? { label } : {}),
    });
  }
  return merged;
}

// The model spent `usd` on one more message of this session. Reaching the
// session's ceiling closes it: the client can start another one, and that is
// a fresh decision of theirs.
export function recordSpend(
  session: WorkSession,
  usd: number,
  now: Date,
): WorkSession {
  const spentUsd = session.spentUsd + Math.max(0, usd);
  const stamp = now.toISOString();
  const over = spentUsd >= SESSION_LIMITS.maxSpendUsd;
  return {
    ...session,
    turns: session.turns + 1,
    spentUsd,
    updatedAt: stamp,
    ...(over && session.status === "ACTIVE"
      ? { status: "CANCELLED" as const, endedAt: stamp, endReason: "budget" }
      : {}),
  };
}

export function progressOf(session: WorkSession): {
  done: number;
  total: number;
  next: { id: string; title: string } | null;
} {
  const next = session.steps.find((step) => !settled(step));
  return {
    done: session.steps.filter(settled).length,
    total: session.steps.length,
    next: next ? { id: next.id, title: next.title } : null,
  };
}

// The checkpoint as the agent sees it at the start of a message. JSON, like the
// rest of its context, so a step title stays quoted data.
export function sessionForPrompt(session: WorkSession) {
  return {
    goal: session.goal,
    steps: session.steps.map((step) => ({
      id: step.id,
      title: step.title,
      status: step.status,
      ...(step.note ? { note: step.note } : {}),
      ...(step.artifacts.length > 0 ? { artifacts: step.artifacts } : {}),
    })),
  };
}
