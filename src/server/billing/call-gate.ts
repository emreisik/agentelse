import "server-only";

import { randomUUID } from "node:crypto";

import { getBillingConfig } from "./config";
import { runMetered } from "./operation";
import {
  NoPlanError,
  QuotaExceededError,
  asBudgetStop,
  isQuotaError,
} from "./quota-errors";
import { getUsageScope, type UsageModule } from "./usage-context";

// Plan hakkı kapısı: giriş noktası olmayan tek bir ücretli motor çağrısı
// (ReasoningService.run) için. Çağrı ya zaten rezervasyonlu bir operasyonun
// (örn. bir yürütme işinin) içindedir, o zaman o rezervasyona katılır; ya da kendi
// azami maliyetini rezerve eder, çalıştırır, gerçek kullanımı mahsup eder.
//
// Hak yoksa hata, motor tüketicilerinin zaten tanıdığı BUDGET_EXCEEDED'a çevrilir
// (asBudgetStop): sinyal/fikir/medya işleri ertelenir, tick adımı hata yazmadan
// atlar, kullanıcıya "limit" denir. Kapalıyken (varsayılan) hiçbir şey olmaz.
//
// Kısa olumsuz önbellek: hakkı biten bir kiracının bekleyen işleri her tick'te bu
// kapıya gelir; aynı reddi her seferinde defterden sormak yerine 30 sn hatırlanır
// (daha küçük bir çağrı yine denenir, çünkü sığabilir).

const REFUSAL_TTL_MS = 30_000;
const MAX_REFUSALS = 5_000;

const refusals = new Map<
  string,
  { until: number; amount: bigint; error: QuotaExceededError | NoPlanError }
>();

export function resetCallGate(): void {
  refusals.clear();
}

export async function gatedAiCall<T>(
  input: {
    workspaceId: string;
    projectId?: string;
    userId?: string;
    module?: UsageModule;
    source: string;
    purpose: string;
    // Azami maliyet tahmini (mikro-USD). Yalnız hak kontrol edilirken çağrılır:
    // kapalıyken ya da rezervasyonlu bir operasyona katılırken hesaplanmaz.
    estimateMicros: () => bigint;
  },
  fn: () => Promise<T>,
): Promise<T> {
  if (getBillingConfig().mode === "off") return fn();

  const ambient = getUsageScope()?.meter;
  if (
    ambient &&
    ambient.workspaceId === input.workspaceId &&
    ambient.covered &&
    !ambient.closed
  ) {
    return fn();
  }

  const amount = input.estimateMicros();
  const now = Date.now();
  const cached = refusals.get(input.workspaceId);
  if (cached && cached.until > now) {
    if (cached.error instanceof NoPlanError || amount >= cached.amount) {
      throw asBudgetStop(cached.error);
    }
  }

  try {
    return await runMetered(
      {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        userId: input.userId,
        module: input.module,
        source: input.source,
        purpose: input.purpose,
        operationId: `${input.source}:${randomUUID()}`,
        attemptToken: "1",
        reserve: { AI_MICROS: amount },
        requireAccess: true,
      },
      fn,
    );
  } catch (error) {
    if (isQuotaError(error)) {
      if (refusals.size >= MAX_REFUSALS) refusals.clear();
      refusals.set(input.workspaceId, {
        until: now + REFUSAL_TTL_MS,
        amount,
        error,
      });
      throw asBudgetStop(error);
    }
    throw error;
  }
}
