import "server-only";

import { z } from "zod";

import {
  ARTIFACT_KINDS,
  SESSION_LIMITS,
  STEP_STATUSES,
  progressOf,
} from "@/server/work-session/session";
import { WorkSessionService } from "@/server/work-session/work-session-service";

import type { ChatTool, ToolContext } from "./tools";

// The two tools of a work session (see server/work-session/session.ts). They
// only keep the checkpoint; the steps themselves are done with the ordinary
// tools, so every gate those tools have (approvals for publishing and spend,
// the project being active) applies inside a session exactly as outside one.

const scopeOf = (ctx: ToolContext) => ({
  workspaceId: ctx.workspaceId,
  projectId: ctx.projectId,
  brandId: ctx.brandId,
});

export const startWorkSession = {
  name: "start_work_session",
  label: "Planning the work…",
  kind: "note",
  // The goal and steps are text the agent writes now and reads back on later
  // messages, so it must not be able to write them after reading outside
  // content: open the session BEFORE researching.
  sensitive: true,
  phases: ["ACTIVE"],
  description: `Open a WORK SESSION for a request that needs several dependent actions done end to end in this conversation (for example: research the competitors, write three concepts, then render the best one). Call it FIRST, before doing any of the work or reading anything. \`goal\` = the outcome the client wants, in one sentence; \`steps\` = ${SESSION_LIMITS.minSteps}-${SESSION_LIMITS.maxStartSteps} short, concrete steps in the order you will do them. It only records the plan: nothing is produced yet. Once it is open you may do the steps one after another in this same message, calling update_work_session as each one begins and ends. NEVER for a single deliverable, a question or small talk, and not while another session is open. Publishing, spending and approvals still need the client exactly as outside a session.`,
  schema: z.object({
    goal: z.string().min(1),
    steps: z
      .array(z.string().min(1))
      .min(SESSION_LIMITS.minSteps)
      .max(SESSION_LIMITS.maxStartSteps),
  }),
  async execute(args: { goal: string; steps: string[] }, ctx: ToolContext) {
    const started = await WorkSessionService.start(scopeOf(ctx), {
      goal: args.goal,
      steps: args.steps,
      userId: ctx.userId,
    });

    if (started.status === "INVALID") {
      return { result: { outcome: "not_started", error: started.error } };
    }
    // Either way this message now runs under the session's allowance.
    if (ctx.session) ctx.session.id = started.id;

    if (started.status === "ALREADY_ACTIVE") {
      return {
        result: {
          outcome: "session_already_active",
          goal: started.session.goal,
          progress: progressOf(started.session),
          note: "A work session is already open. Carry on with it, or close it first (update_work_session with cancel: true) if the client wants something else.",
        },
      };
    }
    return {
      result: {
        outcome: "session_started",
        steps: started.session.steps.map((step) => ({
          id: step.id,
          title: step.title,
        })),
        note: "The session is open and nothing has been done yet. Tell the client the plan in a sentence or two, then do the steps now, one after another in this message: mark a step IN_PROGRESS when you begin it and DONE (with a one-line note and the taskId / ideaId of what a tool returned for it) when it is finished.",
      },
    };
  },
} as unknown as ChatTool;

export const updateWorkSession = {
  name: "update_work_session",
  label: "Updating progress…",
  kind: "note",
  phases: ["ACTIVE"],
  description: `Record progress on the OPEN work session. Give a step (\`stepId\`, e.g. "s2") and its new \`status\`: IN_PROGRESS when you begin it, DONE when it is finished (with a one-line \`note\` of what came out and \`artifacts\` = the taskId or ideaId a tool returned for it), BLOCKED when it waits for the client or an approval, SKIPPED when it is no longer needed. \`addSteps\` appends steps you find you need (at most ${SESSION_LIMITS.maxSteps} in all). \`cancel: true\` closes the session when the client asks to stop it (\`reason\` is optional). When every step is DONE or SKIPPED the session closes by itself. These notes are your own working memory, not something to read out to the client.`,
  schema: z.object({
    stepId: z.string().optional(),
    status: z.enum(STEP_STATUSES).optional(),
    note: z.string().optional(),
    artifacts: z
      .array(
        z.object({
          kind: z.enum(ARTIFACT_KINDS),
          id: z.string().min(1),
          label: z.string().optional(),
        }),
      )
      .max(SESSION_LIMITS.maxArtifactsPerStep)
      .optional(),
    addSteps: z.array(z.string().min(1)).max(6).optional(),
    cancel: z.boolean().optional(),
    reason: z.string().optional(),
  }),
  async execute(
    args: {
      stepId?: string;
      status?: (typeof STEP_STATUSES)[number];
      note?: string;
      artifacts?: {
        kind: (typeof ARTIFACT_KINDS)[number];
        id: string;
        label?: string;
      }[];
      addSteps?: string[];
      cancel?: boolean;
      reason?: string;
    },
    ctx: ToolContext,
  ) {
    const updated = await WorkSessionService.update(scopeOf(ctx), args, {
      // A message that read outside content (web, stored research) may not
      // write words into the checkpoint; only its state changes.
      freeText: !ctx.tainted,
      userId: ctx.userId,
    });

    if (updated.status === "NONE") {
      return {
        result: {
          outcome: "no_active_session",
          note: "There is no open work session (it ended or timed out). Carry on without one.",
        },
      };
    }
    if (updated.status === "REJECTED") {
      return { result: { outcome: "not_updated", error: updated.error } };
    }

    const progress = progressOf(updated.session);
    const outcome =
      updated.ended === "COMPLETED"
        ? "session_completed"
        : updated.ended === "CANCELLED"
          ? "session_cancelled"
          : "updated";
    const notes = [
      ...(updated.ended === "COMPLETED"
        ? [
            "Every step is settled and the session is closed. Tell the client what was produced.",
          ]
        : []),
      ...(updated.ignored.length > 0
        ? [
            "Part of this was not saved: this message used content from outside the conversation, so only statuses and ids are recorded now.",
          ]
        : []),
    ];
    return {
      result: {
        outcome,
        progress: `${progress.done} of ${progress.total} steps settled`,
        ...(progress.next ? { next: progress.next } : {}),
        ...(updated.ignored.length > 0 ? { ignored: updated.ignored } : {}),
        ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
      },
    };
  },
} as unknown as ChatTool;
