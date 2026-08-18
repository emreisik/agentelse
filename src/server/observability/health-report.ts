import "server-only";

import { prisma } from "@/lib/prisma";
import { classifyError } from "@/server/observability/error-classifier";
import type { ErrorCategory } from "@/server/observability/error-classifier";
import { capabilityLabel } from "@/lib/labels";

// Sistem Sağlığı ekranının tek veri kaynağı. Hatalar dört ayrı tabloya
// dağılmış durumda (ExecutionJob, DeadLetterJob, ReasoningCall, Task) —
// burada tek bir okumada toplanır ve mesaja göre gruplanır, böylece
// "aynı hata 34 kez" tek satır olarak görünür.

export type ErrorGroup = {
  signature: string;
  category: ErrorCategory;
  summary: string;
  strategy: string;
  count: number;
  lastSeenAt: Date;
  sampleMessage: string;
  sources: string[];
};

export type SystemHealthReport = {
  windowHours: number;
  totals: {
    failedJobs: number;
    failedReasoningCalls: number;
    openDeadLetters: number;
    stuckJobs: number;
    autoRecoveries: number;
  };
  groups: ErrorGroup[];
  providers: Array<{
    key: string;
    status: string;
    configured: boolean;
    lastCheckAt: Date | null;
    lastErrorMessage: string | null;
    openIncidents: number;
  }>;
  deadLetters: Array<{
    id: string;
    reason: string;
    lastError: string | null;
    attempts: number;
    createdAt: Date;
    executionJobId: string | null;
    category: ErrorCategory;
    autoRecoverable: boolean;
  }>;
  recentRecoveries: Array<{
    id: string;
    action: string;
    entityId: string;
    createdAt: Date;
    metadata: unknown;
  }>;
};

const STUCK_AFTER_MS = 30 * 60_000;

// Değişken kısımları (id, sayı, tırnak içi değer) siler ki aynı hata tek
// grupta toplansın.
function signatureOf(message: string): string {
  return message
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      "<id>",
    )
    .replace(/\bc[a-z0-9]{20,}\b/gi, "<id>")
    .replace(/"[^"]{0,80}"/g, '"<değer>"')
    .replace(/\d+/g, "<n>")
    .slice(0, 200)
    .trim();
}

export async function buildSystemHealthReport(
  workspaceId: string,
  windowHours = 24,
): Promise<SystemHealthReport> {
  const since = new Date(Date.now() - windowHours * 3_600_000);
  const stuckCutoff = new Date(Date.now() - STUCK_AFTER_MS);

  const [
    failedJobs,
    failedReasoning,
    deadLetters,
    stuckJobs,
    providerRows,
    recoveries,
  ] = await Promise.all([
    prisma.executionJob.findMany({
      where: { workspaceId, status: "FAILED", updatedAt: { gte: since } },
      select: {
        errorMessage: true,
        updatedAt: true,
        capability: true,
        providerId: true,
      },
      orderBy: { updatedAt: "desc" },
      take: 500,
    }),
    prisma.reasoningCall.findMany({
      where: { workspaceId, status: "ERROR", createdAt: { gte: since } },
      select: { errorMessage: true, createdAt: true, purpose: true },
      orderBy: { createdAt: "desc" },
      take: 500,
    }),
    prisma.deadLetterJob.findMany({
      where: { resolvedAt: null },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    prisma.executionJob.count({
      where: {
        workspaceId,
        status: { in: ["RUNNING", "WAITING_PROVIDER"] },
        updatedAt: { lt: stuckCutoff },
      },
    }),
    prisma.providerDefinition.findMany({
      include: {
        health: true,
        incidents: { where: { resolved: false }, select: { id: true } },
      },
      orderBy: { key: "asc" },
    }),
    prisma.auditLog.findMany({
      where: {
        workspaceId,
        action: { startsWith: "self-healing." },
        createdAt: { gte: since },
      },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
  ]);

  const grouped = new Map<string, ErrorGroup>();
  const add = (message: string | null, at: Date, source: string) => {
    if (!message) return;
    const signature = signatureOf(message);
    const classification = classifyError(message);
    const existing = grouped.get(signature);
    if (existing) {
      existing.count += 1;
      if (at > existing.lastSeenAt) existing.lastSeenAt = at;
      if (!existing.sources.includes(source)) existing.sources.push(source);
      return;
    }
    grouped.set(signature, {
      signature,
      category: classification.category,
      summary: classification.summary,
      strategy: classification.strategy,
      count: 1,
      lastSeenAt: at,
      sampleMessage: message.slice(0, 500),
      sources: [source],
    });
  };

  for (const job of failedJobs) {
    add(
      job.errorMessage,
      job.updatedAt,
      `görev: ${capabilityLabel(job.capability)}`,
    );
  }
  for (const call of failedReasoning) {
    add(call.errorMessage, call.createdAt, `akıl yürütme: ${call.purpose}`);
  }
  for (const entry of deadLetters) {
    add(entry.lastError, entry.createdAt, "ölü kuyruk");
  }

  return {
    windowHours,
    totals: {
      failedJobs: failedJobs.length,
      failedReasoningCalls: failedReasoning.length,
      openDeadLetters: deadLetters.length,
      stuckJobs,
      autoRecoveries: recoveries.length,
    },
    groups: Array.from(grouped.values()).sort((a, b) => b.count - a.count),
    providers: providerRows.map((row) => ({
      key: row.key,
      status: row.health?.status ?? "UNAVAILABLE",
      configured: row.configured,
      lastCheckAt: row.health?.lastCheckAt ?? null,
      lastErrorMessage: row.health?.lastErrorMessage ?? null,
      openIncidents: row.incidents.length,
    })),
    deadLetters: deadLetters.map((entry) => {
      const classification = classifyError(entry.lastError);
      return {
        id: entry.id,
        reason: entry.reason,
        lastError: entry.lastError,
        attempts: entry.attempts,
        createdAt: entry.createdAt,
        executionJobId: entry.executionJobId,
        category: classification.category,
        autoRecoverable:
          classification.strategy === "RETRY" ||
          classification.strategy === "RETRY_AFTER_COOLDOWN",
      };
    }),
    recentRecoveries: recoveries.map((entry) => ({
      id: entry.id,
      action: entry.action,
      entityId: entry.entityId,
      createdAt: entry.createdAt,
      metadata: entry.metadata,
    })),
  };
}
