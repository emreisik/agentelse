import "server-only";

import {
  FOCUS_DISABLED_TICK_STEPS,
  isAgencyFocusMode,
} from "@/server/agency/agency-focus";
import { isLegacyUnitEnabled } from "@/server/agency/legacy-loop";
import { ResultMaterializer } from "@/server/agency/intelligence/research-result-materializer";
import { ProjectSetupOrchestrator } from "@/server/agency/setup/project-setup-orchestrator";
import { AgencyTriggerRepository } from "@/server/repositories/agency-trigger.repository";
import { AgencyCycleRepository } from "@/server/repositories/agency-cycle.repository";
import { AgencyLoopStateRepository } from "@/server/repositories/agency-loop-state.repository";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { runAsBackground } from "@/server/billing/usage-context";
import { isAgentelseError } from "@/server/security/errors";

// The Agency OS main loop (spec section 33). NOT recursion — a DB-polled
// pipeline where every sub-step reads rows the prior step produced, runs
// under a batch limit, and is individually fault-isolated: one failing stage
// never takes down execution or the other stages.
//
// Wave 2 skeleton: trigger processing + setup advancement. Waves 3-5 append
// the intelligence/opportunity/idea/decision/measurement/learning steps via
// the STEP list below.

type TickStep = { name: string; run: () => Promise<unknown> };

// Later waves push additional steps here (signal scans, insight synthesis,
// opportunity evaluation, idea generation, council, director, measurement,
// learning) — order matters and mirrors the pipeline.
const EXTRA_STEPS: TickStep[] = [];

export function registerAgencyTickStep(step: TickStep): void {
  EXTRA_STEPS.push(step);
}

type TriggerRef = {
  id: string;
  workspaceId: string;
  projectId: string;
  brandId: string;
  type: string;
};

// Runs ONE unit of trigger work (the result materializer or a registered
// handler) so its failure cannot keep the units after it from running. They
// used to share one try/catch: a throwing legacy handler (say, work-plan
// progression) stopped every handler registered after it, including the real
// product ones (a published Creative never flipped to PUBLISHED, the Meta ad
// chain never continued). The failure is still collected so the trigger is
// marked FAILED and audited, exactly as before.
async function runIsolated(
  name: string,
  trigger: TriggerRef,
  taskId: string,
  failures: unknown[],
  run: () => Promise<unknown>,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    failures.push(error);
    try {
      await AuditLogRepository.record({
        workspaceId: trigger.workspaceId,
        projectId: trigger.projectId,
        brandId: trigger.brandId,
        actorType: "SYSTEM",
        action: `agency.trigger.handler_failed.${name}`,
        entityType: "AgencyTrigger",
        entityId: trigger.id,
        metadata: {
          triggerType: trigger.type,
          taskId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    } catch {
      // Audit failure must never break the trigger loop.
    }
  }
}

// One failure keeps its own message (the trigger row shows it); several are
// joined so none is lost.
function combineFailures(failures: unknown[]): Error {
  if (failures.length === 1 && failures[0] instanceof Error) {
    return failures[0];
  }
  return new Error(
    failures
      .map((failure) =>
        failure instanceof Error ? failure.message : String(failure),
      )
      .join("; "),
  );
}

export const ContinuousAgencyEngine = {
  async processTriggers(limit = 20): Promise<number> {
    const claimed = await AgencyTriggerRepository.claimPending(limit);
    let processed = 0;

    for (const trigger of claimed) {
      const scope = {
        workspaceId: trigger.workspaceId,
        projectId: trigger.projectId,
        brandId: trigger.brandId,
      };
      // AgencyLoopState/AgencyCycle telemetry is scoped to trigger types
      // that actually run a handler today (TASK_COMPLETED/FAILED/CANCELLED)
      // — other types (SCHEDULE, USER_COMMAND, etc.) just fall through to
      // markProcessed with no handler of their own, so recording a "cycle"
      // for them would overstate what actually happened. See
      // AgencyLoopState/AgencyCycle's schema comments.
      const isTaskTrigger =
        trigger.type === "TASK_COMPLETED" ||
        trigger.type === "TASK_FAILED" ||
        trigger.type === "TASK_CANCELLED";
      let cycle: { id: string } | undefined;
      if (isTaskTrigger) {
        await AgencyLoopStateRepository.getOrCreate(scope).catch(
          () => undefined,
        );
        cycle = await AgencyCycleRepository.start(scope, {
          type: trigger.type,
          id: trigger.id,
        }).catch(() => undefined);
      }

      try {
        let didWork = false;
        const failures: unknown[] = [];
        if (trigger.type === "TASK_COMPLETED") {
          const payload = (trigger.payload ?? {}) as { taskId?: string };
          if (payload.taskId) {
            const taskId = payload.taskId;
            await runIsolated(
              "result-materializer",
              trigger,
              taskId,
              failures,
              () => ResultMaterializer.materializeTask(taskId),
            );
            // Completed-task fan-outs registered by later waves (work-plan
            // progression, measurement planning) run as extra handlers.
            for (const handler of TASK_COMPLETED_HANDLERS) {
              if (handler.name && !isLegacyUnitEnabled(handler.name)) continue;
              await runIsolated(
                handler.name ?? "task-completed",
                trigger,
                taskId,
                failures,
                () => handler.run(taskId, scope),
              );
            }
            didWork = true;
          }
        } else if (
          trigger.type === "TASK_FAILED" ||
          trigger.type === "TASK_CANCELLED"
        ) {
          // Symmetric to TASK_COMPLETED above, minus ResultMaterializer
          // (there's no successful result to materialize). No result to
          // materialize either way — a failed/cancelled task never reaches
          // pollOnce's "COMPLETED" branch.
          const payload = (trigger.payload ?? {}) as {
            taskId?: string;
            terminalStatus?: "FAILED" | "CANCELLED";
          };
          if (payload.taskId) {
            const taskId = payload.taskId;
            const status =
              payload.terminalStatus ??
              (trigger.type === "TASK_FAILED" ? "FAILED" : "CANCELLED");
            for (const handler of TASK_TERMINAL_HANDLERS) {
              if (handler.name && !isLegacyUnitEnabled(handler.name)) continue;
              await runIsolated(
                handler.name ?? "task-terminal",
                trigger,
                taskId,
                failures,
                () => handler.run(taskId, status, scope),
              );
            }
            didWork = true;
          }
        }
        // Other trigger types currently act as wake-ups: their existence
        // makes this tick run the downstream pipeline steps below.

        // Every unit above ran; now surface what failed so the trigger is
        // marked FAILED and its cycle recorded as FAILED (the catch below)
        // instead of being reported processed.
        if (failures.length > 0) throw combineFailures(failures);

        if (isTaskTrigger) {
          await (
            didWork
              ? AgencyLoopStateRepository.recordProgress(
                  trigger.projectId,
                  trigger.type,
                )
              : AgencyLoopStateRepository.recordNoProgress(
                  trigger.projectId,
                  trigger.type,
                )
          ).catch(() => undefined);
          if (cycle) {
            await AgencyCycleRepository.complete(
              cycle.id,
              didWork ? "COMPLETED" : "NOOP",
            ).catch(() => undefined);
          }
        }

        await AgencyTriggerRepository.markProcessed(trigger.id);
        processed += 1;
      } catch (error) {
        if (isTaskTrigger) {
          await AgencyLoopStateRepository.recordNoProgress(
            trigger.projectId,
            trigger.type,
          ).catch(() => undefined);
          if (cycle) {
            await AgencyCycleRepository.complete(cycle.id, "FAILED", {
              errorCount: 1,
            }).catch(() => undefined);
          }
        }
        await AgencyTriggerRepository.markFailed(
          trigger.id,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    return processed;
  },

  async tick(): Promise<void> {
    const steps: TickStep[] = [
      { name: "triggers", run: () => this.processTriggers(20) },
      { name: "setup", run: () => ProjectSetupOrchestrator.advanceAll(5) },
      // Focus mode (agency-focus.ts) skips steps outside social/ads work;
      // LEGACY_AGENCY_LOOP (legacy-loop.ts) winds down the old pipeline steps.
      ...EXTRA_STEPS.filter(
        (step) =>
          isLegacyUnitEnabled(step.name) &&
          (!isAgencyFocusMode() || !FOCUS_DISABLED_TICK_STEPS.has(step.name)),
      ),
    ];

    for (const step of steps) {
      try {
        // Tick sistemin kendi akışıdır: içindeki ücretli işlemler plan hakkının arka
        // plan payına tabidir (billing/usage-context.ts runAsBackground).
        await runAsBackground(() => step.run());
      } catch (error) {
        // BUDGET_EXCEEDED is the cap system working as intended — skip
        // quietly; anything else gets an audit trail entry but never
        // interrupts the remaining steps or the execution worker.
        if (isAgentelseError(error) && error.code === "BUDGET_EXCEEDED") {
          continue;
        }
        try {
          await AuditLogRepository.record({
            workspaceId: "system",
            actorType: "SYSTEM",
            action: `agency.tick.step_failed.${step.name}`,
            entityType: "ContinuousAgencyEngine",
            entityId: step.name,
            metadata: {
              error: error instanceof Error ? error.message : String(error),
            },
          });
        } catch {
          // Audit failure must never crash the tick.
        }
      }
    }
  },
};

type TaskCompletedHandler = (
  taskId: string,
  scope: { workspaceId: string; projectId: string; brandId: string },
) => Promise<void>;

// `name` identifies the handler for LEGACY_AGENCY_LOOP gating (legacy-loop.ts)
// and for its audit trail when it fails. Unnamed handlers always run.
const TASK_COMPLETED_HANDLERS: { name?: string; run: TaskCompletedHandler }[] =
  [];

export function registerTaskCompletedHandler(
  handler: TaskCompletedHandler,
  name?: string,
): void {
  TASK_COMPLETED_HANDLERS.push({ name, run: handler });
}

// Symmetric to TaskCompletedHandler — fired for a task's TASK_FAILED/
// TASK_CANCELLED trigger (see task.repository.ts's transition()). This is
// what lets WorkPlanProgressor/MeasurementEngine react to a failure instead
// of only ever seeing completions.
type TaskTerminalHandler = (
  taskId: string,
  status: "FAILED" | "CANCELLED",
  scope: { workspaceId: string; projectId: string; brandId: string },
) => Promise<void>;

const TASK_TERMINAL_HANDLERS: { name?: string; run: TaskTerminalHandler }[] =
  [];

export function registerTaskTerminalHandler(
  handler: TaskTerminalHandler,
  name?: string,
): void {
  TASK_TERMINAL_HANDLERS.push({ name, run: handler });
}
