import "server-only";

import type { ProviderHealthStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { ProviderRegistry } from "@/server/execution/provider-registry";
import { classifyError } from "@/server/observability/error-classifier";

// Provider health: the ProviderDefinition/ProviderHealth/ProviderIncident
// models were defined in the schema, but no code was writing to them. This
// service derives each provider's status from the ExecutionJob results in
// the last N minutes, opens/closes an incident on status change, and feeds
// the CapabilityRouter's circuit-breaker decision.

const WINDOW_MS = 30 * 60_000;
// Rate within the window, not consecutive: a single failure shouldn't take
// a provider down, but a burst of failures should take it down fast.
const MIN_SAMPLE = 3;
const DEGRADED_FAILURE_RATE = 0.5;
const DOWN_FAILURE_RATE = 0.9;

export type ProviderHealthSnapshot = {
  key: string;
  status: ProviderHealthStatus;
  isConfigured: boolean;
  total: number;
  failed: number;
  lastErrorMessage: string | null;
  lastCheckAt: Date | null;
};

// Circuit-breaker "half-open" behavior: once a provider drops to
// UNAVAILABLE/DEGRADED/RATE_LIMITED, CapabilityRouter stops giving it work
// (see unhealthyProviderKeys) — which means it can NEVER accumulate new
// samples in the window (a job that's never dispatched produces no result
// either). The previous code kept the last known (bad) status FOREVER in
// this case: even after the real failure had long since aged out of the
// 30-minute window, the provider was never retried again (this happened in
// production with openclaw + meta-api — see this session's notes). Once the
// window has no samples left (jobs.length === 0, meaning not a single job
// hit this provider in the last WINDOW_MS), we fall back to AVAILABLE and
// let the next dispatch try again — if the problem is really still there, a
// fresh failure immediately drops it back to UNAVAILABLE; if it really
// passed, the provider quietly recovers.
//
// AUTH_REQUIRED (bad key / exhausted balance) used to be preserved forever
// on the assumption that a human must intervene. But once the key or
// balance is fixed, nothing tells the breaker: the provider stays locked, no
// job is ever dispatched to it, and no new sample can ever clear it (seen in
// production: openai-creative locked for days after a missing key was
// fixed). So it decays like the others, but more conservatively — only when
// the window is completely empty (no job of any outcome for the whole
// WINDOW_MS) AND the provider is configured right now. If the key is still
// bad, the next attempts fail again and the breaker re-closes as soon as
// MIN_SAMPLE failures are on record. DISABLED is a deliberate choice, never
// decays.
export function decayStatus(
  previous: ProviderHealthStatus | undefined,
  context: { jobsInWindow: number; configured: boolean } = {
    jobsInWindow: Number.POSITIVE_INFINITY,
    configured: false,
  },
): ProviderHealthStatus {
  if (previous === "DISABLED") return previous;
  if (previous === "AUTH_REQUIRED") {
    return context.jobsInWindow === 0 && context.configured
      ? "AVAILABLE"
      : previous;
  }
  return "AVAILABLE";
}

function statusFromSamples(
  total: number,
  failed: number,
  lastError: string | null,
): ProviderHealthStatus {
  if (total === 0) return "AVAILABLE";
  const rate = failed / total;
  if (rate < DEGRADED_FAILURE_RATE) return "AVAILABLE";

  // The error type determines the status: quota/key problems don't resolve
  // by waiting, so they fall into separate states and the circuit breaker
  // handles them differently.
  const classification = classifyError(lastError);
  if (classification.category === "RATE_LIMIT") return "RATE_LIMITED";
  if (
    classification.category === "AUTH" ||
    classification.category === "BILLING"
  ) {
    return "AUTH_REQUIRED";
  }
  return rate >= DOWN_FAILURE_RATE ? "UNAVAILABLE" : "DEGRADED";
}

export const ProviderHealthService = {
  // Guarantees a ProviderDefinition row exists for every provider in the
  // registry — health and incident records depend on it.
  async syncDefinitions(): Promise<void> {
    for (const provider of ProviderRegistry.registered()) {
      await prisma.providerDefinition.upsert({
        where: { key: provider.key },
        create: {
          key: provider.key,
          name: provider.key,
          providerType: provider.type,
          configured: provider.isConfigured,
        },
        update: { configured: provider.isConfigured },
      });
    }
  },

  // Recomputes health from the job results in the latest window. Can be
  // called on every tick; a write only produces an incident when the status
  // actually changes.
  async refresh(now = new Date()): Promise<ProviderHealthSnapshot[]> {
    await this.syncDefinitions();

    const since = new Date(now.getTime() - WINDOW_MS);
    const definitions = await prisma.providerDefinition.findMany({
      include: { health: true },
    });
    const snapshots: ProviderHealthSnapshot[] = [];

    for (const definition of definitions) {
      const jobs = await prisma.executionJob.findMany({
        where: {
          providerId: definition.key,
          updatedAt: { gte: since },
          status: { in: ["COMPLETED", "FAILED"] },
        },
        select: { status: true, errorMessage: true, updatedAt: true },
        orderBy: { updatedAt: "desc" },
      });

      // Only errors that are evidence the provider is ACTUALLY broken
      // (classifyError().degradesProvider) feed the circuit breaker —
      // "our request was bad" type failures like a content validation
      // error (e.g. Instagram's "Only photo or video..." rejection)
      // shouldn't drop the provider to UNAVAILABLE, because the provider
      // itself is healthy.
      const failures = jobs.filter(
        (job) =>
          job.status === "FAILED" &&
          classifyError(job.errorMessage).degradesProvider,
      );
      const lastErrorMessage = failures[0]?.errorMessage ?? null;
      const status =
        jobs.length < MIN_SAMPLE
          ? decayStatus(definition.health?.status, {
              jobsInWindow: jobs.length,
              configured: definition.configured,
            })
          : statusFromSamples(jobs.length, failures.length, lastErrorMessage);

      const previous = definition.health?.status;
      await prisma.providerHealth.upsert({
        where: { providerId: definition.id },
        create: {
          providerId: definition.id,
          status,
          lastCheckAt: now,
          lastErrorMessage,
        },
        update: { status, lastCheckAt: now, lastErrorMessage },
      });

      if (previous !== status) {
        await this.recordStatusChange(
          definition.id,
          previous,
          status,
          lastErrorMessage,
          now,
        );
      }

      snapshots.push({
        key: definition.key,
        status,
        isConfigured: definition.configured,
        total: jobs.length,
        failed: failures.length,
        lastErrorMessage,
        lastCheckAt: now,
      });
    }

    return snapshots;
  },

  // Closes open incidents on recovery to healthy, opens a new one on
  // degradation.
  async recordStatusChange(
    providerDefinitionId: string,
    previous: ProviderHealthStatus | undefined,
    next: ProviderHealthStatus,
    lastErrorMessage: string | null,
    now: Date,
  ): Promise<void> {
    if (next === "AVAILABLE") {
      await prisma.providerIncident.updateMany({
        where: { providerId: providerDefinitionId, resolved: false },
        data: { resolved: true, resolvedAt: now },
      });
      return;
    }

    const alreadyOpen = await prisma.providerIncident.findFirst({
      where: { providerId: providerDefinitionId, resolved: false },
    });
    if (alreadyOpen) return;

    await prisma.providerIncident.create({
      data: {
        providerId: providerDefinitionId,
        message: [
          `${previous ?? "AVAILABLE"} → ${next}`,
          lastErrorMessage ? `Last error: ${lastErrorMessage}` : null,
        ]
          .filter(Boolean)
          .join(" · "),
      },
    });
  },

  // The set the circuit breaker reads: these providers get no new work.
  async unhealthyProviderKeys(): Promise<ReadonlySet<string>> {
    const rows = await prisma.providerHealth.findMany({
      where: { status: { in: ["UNAVAILABLE", "AUTH_REQUIRED", "DISABLED"] } },
      include: { provider: { select: { key: true } } },
    });
    return new Set(rows.map((row) => row.provider.key));
  },
};
