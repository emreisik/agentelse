import "server-only";

import { ResultMaterializer } from "@/server/agency/intelligence/research-result-materializer";
import { ProjectSetupOrchestrator } from "@/server/agency/setup/project-setup-orchestrator";
import { AgencyTriggerRepository } from "@/server/repositories/agency-trigger.repository";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { isHubConnectError } from "@/server/security/errors";

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

export const ContinuousAgencyEngine = {
  async processTriggers(limit = 20): Promise<number> {
    const claimed = await AgencyTriggerRepository.claimPending(limit);
    let processed = 0;

    for (const trigger of claimed) {
      try {
        if (trigger.type === "TASK_COMPLETED") {
          const payload = (trigger.payload ?? {}) as { taskId?: string };
          if (payload.taskId) {
            await ResultMaterializer.materializeTask(payload.taskId);
            // Completed-task fan-outs registered by later waves (work-plan
            // progression, measurement planning) run as extra handlers.
            for (const handler of TASK_COMPLETED_HANDLERS) {
              await handler(payload.taskId, {
                workspaceId: trigger.workspaceId,
                projectId: trigger.projectId,
                brandId: trigger.brandId,
              });
            }
          }
        }
        // Other trigger types currently act as wake-ups: their existence
        // makes this tick run the downstream pipeline steps below.

        await AgencyTriggerRepository.markProcessed(trigger.id);
        processed += 1;
      } catch (error) {
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
      ...EXTRA_STEPS,
    ];

    for (const step of steps) {
      try {
        await step.run();
      } catch (error) {
        // BUDGET_EXCEEDED is the cap system working as intended — skip
        // quietly; anything else gets an audit trail entry but never
        // interrupts the remaining steps or the execution worker.
        if (isHubConnectError(error) && error.code === "BUDGET_EXCEEDED") {
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

const TASK_COMPLETED_HANDLERS: TaskCompletedHandler[] = [];

export function registerTaskCompletedHandler(
  handler: TaskCompletedHandler,
): void {
  TASK_COMPLETED_HANDLERS.push(handler);
}
