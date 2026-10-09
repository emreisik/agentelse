import "server-only";

import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { PRICE_TABLE_VERSION } from "@/server/reasoning/reasoning-pricing";

import {
  getUsageScope,
  moduleOf,
  type UsageModule,
  type UsageScope,
} from "./usage-context";

// Her ücretli dış çağrının gerçek kullanımını UsageEntry'ye yazar. Çağrıyı
// asla bozmaz: yazım hatası yutulur ve loglanır (OpenAI ücreti zaten alınmıştır;
// bir kayıt hatası kullanıcıya üretilmiş içeriği kaybettirmemeli).

export type UsageKind = "TEXT" | "IMAGE" | "SEARCH" | "EMBED" | "VIDEO";

export const UNATTRIBUTED_WORKSPACE = "unattributed";

export type RecordUsageInput = {
  kind: UsageKind;
  provider: "openai" | "fal";
  model: string;
  costUsd: number;
  // true: sağlayıcı kullanım döndürmedi ya da fiyat tahmini.
  costEstimated: boolean;
  success: boolean;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  webSearchCalls?: number;
  units?: number;
  errorCode?: string;
  // Verilmezse AsyncLocalStorage kapsamı kullanılır (yoksa "unattributed").
  scope?: Partial<UsageScope>;
  purpose?: string;
  // Aynı sağlayıcı yanıtı iki kez yazılmasın diye çağırana ait kimlik.
  callId?: string;
};

export function usdToMicros(usd: number): bigint {
  if (!Number.isFinite(usd) || usd <= 0) return BigInt(0);
  return BigInt(Math.round(usd * 1_000_000));
}

export async function recordUsage(input: RecordUsageInput): Promise<void> {
  try {
    const ambient = getUsageScope();
    const scope: Partial<UsageScope> = { ...ambient, ...input.scope };
    const purpose = input.purpose ?? scope.purpose ?? "unknown";
    const usageModule: UsageModule = scope.module ?? moduleOf(purpose);
    const callId = input.callId ?? randomUUID();
    const costMicros = usdToMicros(input.costUsd);

    // Operasyonun sayacı (operation.ts) DB yazımından ÖNCE ve ondan bağımsız
    // güncellenir: yazım hatası, mahsup edilecek gerçek tutarı kaybettirmemeli.
    // Başka workspace'in sayacına asla eklenmez.
    if (scope.meter && scope.meter.workspaceId === scope.workspaceId) {
      scope.meter.add({
        callId,
        kind: input.kind,
        costMicros,
        success: input.success,
        units: input.units,
      });
    }

    await prisma.usageEntry.create({
      data: {
        workspaceId: scope.workspaceId ?? UNATTRIBUTED_WORKSPACE,
        projectRef: scope.projectId,
        userId: scope.userId,
        module: usageModule,
        source: scope.source,
        operationId: scope.operationId,
        callId,
        kind: input.kind,
        purpose,
        provider: input.provider,
        model: input.model,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        cachedTokens: input.cachedTokens,
        webSearchCalls: input.webSearchCalls,
        units: input.units,
        costMicros,
        costEstimated: input.costEstimated,
        success: input.success,
        errorCode: input.errorCode,
        durationMs: Math.max(0, Math.round(input.durationMs)),
        priceTable: PRICE_TABLE_VERSION,
      },
    });
  } catch (error) {
    // Aynı callId ikinci kez gelirse zaten yazılmıştır — sessizce geç.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return;
    }
    console.error("[usage] could not record usage", error);
  }
}
