import "server-only";

import { randomUUID } from "node:crypto";

import type { ExecutionJob } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { JOB_RESERVATION_TTL_MS, TASK_CEILING } from "@/lib/billing/plans";
import { moduleOf } from "@/server/billing/usage-context";
import type {
  ExecutionPolicyContext,
  ExecutionProvider,
  ProviderUsageEstimate,
} from "@/server/execution/types";
import { AgentelseError } from "@/server/security/errors";

import { getBillingConfig } from "./config";
import {
  beginOperation,
  releaseAttemptReservations,
  type Operation,
  type OperationReserve,
  type OperationSpec,
} from "./operation";
import { parkJob } from "./park";
import { isQuotaError } from "./quota-errors";
import { usdToMicros } from "./usage-recorder";

// Bir yürütme işinin plan hakkı kapısı (ExecutionService.startExecution). İş,
// sağlayıcı çağrılmadan ve Task "çalışıyor" yapılmadan ÖNCE rezerve eder; hak
// yetmezse iş HATA OLMAZ, WAITING_BUDGET'e park edilir ve startExecution onu
// olduğu gibi döndürür. Tek yer olduğu için worker, sohbet (inline) ve reklam
// lansmanı sürücüsü aynı davranışı alır, hiçbirinin ayrı bir yakalama koduna
// ihtiyacı yoktur ve park ile "olay işlendi" işareti arasında yetim kalan iş
// oluşmaz (olay, startExecution döndükten sonra kapatılır).

const TERMINAL_TASK = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

export type JobBilling =
  | { kind: "run"; operation: Operation }
  // İş çalıştırılmayacak: park edildi ya da görevi artık istenmiyor.
  | { kind: "stop"; job: ExecutionJob };

// A bug in a provider's declaration must not take job starts down while billing
// is off (nothing changes there), and must not hand out free work while it is on:
// then the start is refused as "ledger unavailable" (retried, no attempt spent).
function safeEstimate(
  declare: () => ProviderUsageEstimate | undefined,
): ProviderUsageEstimate | undefined {
  try {
    return declare();
  } catch (error) {
    console.error(
      "[billing] provider usage declaration failed:",
      error instanceof Error ? error.message : error,
    );
    if (getBillingConfig().mode === "off") return undefined;
    throw new AgentelseError(
      "BILLING_UNAVAILABLE",
      "Usage estimate is temporarily unavailable",
      { retryable: true },
    );
  }
}

function ceilingFor(
  estimate: ProviderUsageEstimate | undefined,
): bigint | undefined {
  if (!estimate) return undefined;
  if (estimate.class === "ai") {
    return usdToMicros(estimate.maxCostUsd * TASK_CEILING.aiMultiplier);
  }
  return usdToMicros(
    estimate.images > 0
      ? estimate.images * TASK_CEILING.perImageUsd
      : TASK_CEILING.noImageUsd,
  );
}

export function jobOperationSpec(input: {
  job: ExecutionJob;
  provider: ExecutionProvider;
  context: ExecutionPolicyContext;
  attemptToken: string;
}): OperationSpec {
  const { job, provider, context } = input;
  // Sağlayıcı ne harcayacağını kendisi beyan eder (yanında durduğu kodla birlikte
  // kayar); beyan etmeyenler (yayın/yazma, mock) ücretsiz sınıftır.
  // Kapalıyken beyan hesaplanmaz bile (hiçbir şey değişmez, hata da çıkamaz).
  const estimate =
    getBillingConfig().mode === "off"
      ? undefined
      : safeEstimate(() =>
          provider.usageEstimate?.({
            executionJobId: job.id,
            correlationId: job.correlationId,
            idempotencyKey: job.idempotencyKey,
            capability: job.capability,
            context,
            payload: (job.requestPayload as unknown) ?? undefined,
          }),
        );
  const reserve: OperationReserve =
    estimate?.class === "content"
      ? estimate.images > 0
        ? { IMAGE: estimate.images }
        : {}
      : estimate?.class === "ai"
        ? { AI_MICROS: usdToMicros(estimate.maxCostUsd) }
        : {};
  return {
    // Görev başına azami maliyet: yalnız faturalama açıkken (kapalıyken sayaçta
    // tavan yoktur, hiçbir çağrı kesilmez).
    ceilingMicros:
      getBillingConfig().mode === "off" ? undefined : ceilingFor(estimate),
    workspaceId: job.workspaceId,
    projectId: job.projectId,
    source: "execution",
    purpose: job.capability,
    module: moduleOf(job.capability),
    operationId: `exec:${job.id}`,
    attemptToken: input.attemptToken,
    reserve,
    // Bir iş dakikalar sürer ama sağlayıcı yeniden denemeleri uzatabilir: süpürücü
    // koşan işin hakkını elinden almasın.
    ttlMs: JOB_RESERVATION_TTL_MS,
    // Ücretli sağlayıcının işi, hak harcamasa bile (uyarlama, fotoğraflı gönderi)
    // geçerli bir plan ister; ücretsiz sınıf (yayın, reklam yazması) istemez.
    requireAccess: estimate !== undefined,
  };
}

export async function beginJobBilling(input: {
  job: ExecutionJob;
  provider: ExecutionProvider;
  context: ExecutionPolicyContext;
  attemptToken?: string;
}): Promise<JobBilling> {
  const attemptToken = input.attemptToken ?? randomUUID();
  const spec = jobOperationSpec({ ...input, attemptToken });
  const { job } = input;

  if (getBillingConfig().mode !== "off") {
    // Görevi iptal edilmiş/bitmiş iş hak harcamaz ve diriltilmez: önce kapat. (Devam
    // adımı bu iş için önceden hak ayırmış olabilir; adıyla iade edilir.)
    const task = await prisma.task.findUnique({
      where: { id: job.taskId },
      select: { status: true },
    });
    if (task && TERMINAL_TASK.has(task.status)) {
      await prisma.executionJob.updateMany({
        where: { id: job.id, status: "QUEUED" },
        data: { status: "CANCELLED", completedAt: new Date() },
      });
      await releaseAttemptReservations({
        workspaceId: job.workspaceId,
        operationId: spec.operationId,
        attemptToken,
      });
      return {
        kind: "stop",
        job: await prisma.executionJob.findUniqueOrThrow({
          where: { id: job.id },
        }),
      };
    }
  }

  try {
    return { kind: "run", operation: await beginOperation(spec) };
  } catch (error) {
    if (!isQuotaError(error)) throw error;
    await parkJob(job.id, error);
    return {
      kind: "stop",
      job: await prisma.executionJob.findUniqueOrThrow({
        where: { id: job.id },
      }),
    };
  }
}
