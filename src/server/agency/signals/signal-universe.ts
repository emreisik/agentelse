import "server-only";

import type { SignalCategory } from "@prisma/client";

import { signalFingerprint } from "@/server/agency/fingerprint";
import { TaskPlanner } from "@/server/commands/task-planner";
import { AutonomyPolicyRepository } from "@/server/repositories/autonomy-policy.repository";
import {
  SignalRepository,
  type CreateSignalResult,
} from "@/server/repositories/signal.repository";
import { SignalProfileRepository } from "@/server/repositories/signal-profile.repository";
import { TaskRepository } from "@/server/repositories/task.repository";
import { prisma } from "@/lib/prisma";

import { nextScanAt } from "./scan-cadence";

export type RawSignalInput = {
  workspaceId: string;
  projectId: string;
  brandId: string;
  source: string;
  category: SignalCategory;
  externalRef?: string;
  title: string;
  summary?: string;
  payload?: unknown;
  occurredAt?: Date;
  reliability?: number;
};

// The signal front door (spec section 16). Signals are NOT tasks — ingesting
// one only creates a Signal row; the IntelligenceEngine scores/promotes it on
// a later tick.
export const SignalUniverse = {
  async ingestRaw(input: RawSignalInput): Promise<CreateSignalResult> {
    const result = await SignalRepository.create({
      ...input,
      freshness: 1,
      fingerprint: signalFingerprint({
        category: input.category,
        source: input.source,
        externalRef: input.externalRef,
        title: input.title,
      }),
    });

    if (!result.duplicate) {
      // Counted (not capped) — signal volume is visible in daily stats.
      await AutonomyPolicyRepository.checkAndIncrement(
        {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          brandId: input.brandId,
        },
        "signalsIngested",
      ).catch(() => undefined);
    }
    return result;
  },

  // Profiles whose nextScanAt is due get a SIGNAL_SCAN task (ACTIVE projects
  // only), bounded by concurrency + daily caps. The scan task's provider
  // returns `signals` which ResultMaterializer ingests.
  async runDueScans(limit = 10): Promise<number> {
    const due = await SignalProfileRepository.listDue(limit);
    let started = 0;

    for (const profile of due) {
      const project = await prisma.project.findUnique({
        where: { id: profile.projectId },
        select: { status: true },
      });
      if (project?.status !== "ACTIVE") {
        // Not active — push the scan forward without running it.
        await SignalProfileRepository.setNextScan(
          profile.id,
          nextScanAt(profile.intensity),
        );
        continue;
      }

      const scope = {
        workspaceId: profile.workspaceId,
        projectId: profile.projectId,
        brandId: profile.brandId,
      };

      const policy = await AutonomyPolicyRepository.getOrCreate(scope);
      const activeTasks = await TaskRepository.countActiveSystemTasks(
        profile.projectId,
      );
      if (
        !policy.unlimitedMode &&
        activeTasks >= policy.maxConcurrentResearchTasks
      ) {
        continue;
      }

      try {
        await AutonomyPolicyRepository.checkAndIncrement(scope, "tasksCreated");
      } catch {
        continue; // Daily cap reached — skip this project this tick.
      }

      await TaskPlanner.planForCapability({
        ...scope,
        capability: "SIGNAL_SCAN",
        request: `Scan ${profile.category} signal sources`,
        createdByType: "SYSTEM",
        payloadExtra: { signalCategory: profile.category },
      });

      await SignalProfileRepository.updateScanTimes(
        profile.id,
        new Date(),
        nextScanAt(profile.intensity),
      );
      started += 1;
    }

    return started;
  },
};
