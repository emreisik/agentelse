import "server-only";

import type { AdsOperation, Prisma } from "@prisma/client";

import { newOperationTag } from "@/lib/ads/operation-tag";
import { prisma } from "@/lib/prisma";
import { MetaApiError } from "@/server/integrations/meta/errors";
import { classifyMetaError } from "@/server/integrations/meta/error-catalog";

// Niyet günlüğü (docs/meta-ads-plan.md §3.1, §4): her Meta yazmasından önce
// bir AdsOperation satırı açılır. Aynı iş (ExecutionJob) aynı yazmayı ikinci
// kez başlatırsa (süreç ölümü, takılan dispatch kurtarması) yeni satır
// açılmaz: var olan satır döner ve sağlayıcı oradan devam eder; böylece
// Meta'da çift nesne kurulmaz.

export type OperationKind =
  | "CREATE_CAMPAIGN"
  | "CREATE_ADSET"
  | "CREATE_CREATIVE"
  | "CREATE_AD"
  | "UPDATE_CAMPAIGN"
  | "UPDATE_ADSET"
  | "UPDATE_AD"
  | "SET_STATUS";

export type BeginInput = {
  workspaceId: string;
  projectId: string;
  kind: OperationKind;
  actorType: "USER" | "SYSTEM" | "RULE";
  executionJobId?: string;
  adAccountExternalId?: string;
  targetExternalId?: string;
  parentExternalId?: string;
  // Token'sız istek özeti.
  request: Record<string, unknown>;
  previousState?: Record<string, unknown>;
  launchId?: string;
  decisionId?: string;
};

function errorJson(error: unknown): Prisma.InputJsonValue {
  if (error instanceof MetaApiError) {
    const { class: klass } = classifyMetaError(error);
    return {
      class: klass,
      code: error.metaErrorCode ?? null,
      subcode: error.metaErrorSubcode ?? null,
      message: error.message,
      userMessage: error.details.userMessage ?? null,
      blameFieldSpecs: error.details.blameFieldSpecs ?? null,
      fbtraceId: error.details.fbtraceId ?? null,
    };
  }
  return { message: error instanceof Error ? error.message : String(error) };
}

export const AdsOperations = {
  // { resumed: true } — bu iş bu yazmayı daha önce başlatmış; çağıran
  // satırın durumuna göre devam eder, yeniden göndermez.
  async begin(
    input: BeginInput,
  ): Promise<{ op: AdsOperation; resumed: boolean }> {
    if (input.executionJobId) {
      const existing = await prisma.adsOperation.findUnique({
        where: {
          executionJobId_kind: {
            executionJobId: input.executionJobId,
            kind: input.kind,
          },
        },
      });
      if (existing) return { op: existing, resumed: true };
    }
    const op = await prisma.adsOperation.create({
      data: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        kind: input.kind,
        tag: newOperationTag(),
        actorType: input.actorType,
        executionJobId: input.executionJobId,
        adAccountExternalId: input.adAccountExternalId,
        targetExternalId: input.targetExternalId,
        parentExternalId: input.parentExternalId,
        request: input.request as Prisma.InputJsonValue,
        previousState: input.previousState as Prisma.InputJsonValue | undefined,
        launchId: input.launchId,
        decisionId: input.decisionId,
        status: "PENDING",
      },
    });
    return { op, resumed: false };
  },

  markSent(id: string) {
    return prisma.adsOperation.update({
      where: { id },
      data: { status: "SENT", sentAt: new Date(), attempts: { increment: 1 } },
    });
  },

  succeed(id: string, resultExternalId?: string) {
    return prisma.adsOperation.update({
      where: { id },
      data: { status: "SUCCEEDED", resultExternalId, completedAt: new Date() },
    });
  },

  reconciled(id: string, resultExternalId: string) {
    return prisma.adsOperation.update({
      where: { id },
      data: { status: "RECONCILED", resultExternalId, completedAt: new Date() },
    });
  },

  // Yanıt kayboldu: nesne kurulmuş olabilir, etiketle aranacak.
  unknown(id: string, error: unknown) {
    return prisma.adsOperation.update({
      where: { id },
      data: { status: "UNKNOWN", error: errorJson(error) },
    });
  },

  fail(id: string, error: unknown) {
    return prisma.adsOperation.update({
      where: { id },
      data: { status: "FAILED", error: errorJson(error), completedAt: new Date() },
    });
  },

  find(id: string) {
    return prisma.adsOperation.findUnique({ where: { id } });
  },

  // Lansman adımı (F3): anahtar (launchId, kind, stepKey). Bir lansman birden
  // çok reklam / kreatif kurar; işe bağlı tekil anahtar (executionJobId, kind)
  // kullanılamaz. En yeni kayıt döner; FAILED kayıt yeni denemeye izin verir.
  async beginStep(
    input: Omit<BeginInput, "executionJobId"> & {
      launchId: string;
      stepKey: string;
    },
  ): Promise<{ op: AdsOperation; resumed: boolean }> {
    const existing = await prisma.adsOperation.findFirst({
      where: {
        launchId: input.launchId,
        kind: input.kind,
        request: { path: ["stepKey"], equals: input.stepKey },
      },
      orderBy: { createdAt: "desc" },
    });
    if (existing && existing.status !== "FAILED") {
      return { op: existing, resumed: true };
    }
    const op = await prisma.adsOperation.create({
      data: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        kind: input.kind,
        tag: newOperationTag(),
        actorType: input.actorType,
        adAccountExternalId: input.adAccountExternalId,
        targetExternalId: input.targetExternalId,
        parentExternalId: input.parentExternalId,
        request: { ...input.request, stepKey: input.stepKey } as Prisma.InputJsonValue,
        previousState: input.previousState as Prisma.InputJsonValue | undefined,
        launchId: input.launchId,
        decisionId: input.decisionId,
        status: "PENDING",
        attempts: existing ? existing.attempts : 0,
      },
    });
    return { op, resumed: false };
  },

  // Bir lansmanın aynı adımının kaç kez başarısız olduğu (tek tekrar kuralı).
  failedAttempts(launchId: string, kind: OperationKind, stepKey: string) {
    return prisma.adsOperation.count({
      where: {
        launchId,
        kind,
        status: "FAILED",
        request: { path: ["stepKey"], equals: stepKey },
      },
    });
  },
};
