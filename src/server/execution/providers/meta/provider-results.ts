import "server-only";

import { prisma } from "@/lib/prisma";

// MetaApiProvider sonuçları süreç belleğinde değil ExecutionJob.rawResult
// içinde tutulur (docs/meta-ads-plan.md F1): execute() ile getStatus()
// arasında süreç yeniden başlarsa, Meta'da kurulmuş bir nesnenin kimliği
// "Unknown execution reference" ile kaybolmaz. pollOnce iş sonuçlanınca
// rawResult'ı sonucun kendi rawResult'ıyla değiştirir.

export type ProviderResult = {
  status: "COMPLETED" | "FAILED" | "RUNNING";
  rawResult?: unknown;
  errorMessage?: string;
  errorCode?: string;
  retryable?: boolean;
  // RUNNING: yanıtı kaybolan bir oluşturma yazması uzlaştırılıyor.
  pendingOperationId?: string;
  // Uzlaşınca rawResult'a hangi anahtarla yazılacağı (campaignId, adSetId...).
  resultKey?: string;
  extraResult?: Record<string, unknown>;
  // META_LAUNCH (F3): adım makinesinin kaydı ve modu.
  launchId?: string;
  launchMode?: "create" | "activate" | "discard";
  actorType?: "USER" | "SYSTEM";
};

const KEY = "providerResult";

export async function saveProviderResult(
  correlationId: string,
  result: ProviderResult,
): Promise<void> {
  const job = await prisma.executionJob.findUnique({
    where: { correlationId },
    select: { id: true, rawResult: true },
  });
  if (!job) return;
  const base =
    job.rawResult && typeof job.rawResult === "object"
      ? (job.rawResult as Record<string, unknown>)
      : {};
  await prisma.executionJob.update({
    where: { id: job.id },
    data: { rawResult: { ...base, [KEY]: result } as never },
  });
}

export async function loadProviderResult(
  correlationId: string,
): Promise<ProviderResult | undefined> {
  const job = await prisma.executionJob.findUnique({
    where: { correlationId },
    select: { rawResult: true },
  });
  const raw = job?.rawResult;
  if (!raw || typeof raw !== "object") return undefined;
  const stored = (raw as Record<string, unknown>)[KEY];
  if (!stored || typeof stored !== "object") return undefined;
  const status = (stored as { status?: unknown }).status;
  return status === "COMPLETED" || status === "FAILED" || status === "RUNNING"
    ? (stored as ProviderResult)
    : undefined;
}
