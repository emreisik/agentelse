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
import { getUsageScope, isBackground, type UsageModule } from "./usage-context";

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
//
// Önbellek BAŞLATICIYA göre ayrıdır (Faz 3C): sistemin çağrısı arka plan payı yüzünden
// reddedilebilir, aynı boyutta bir kullanıcı çağrısı ise sığar. Sistemin reddi bu yüzden
// yalnız sistemin sonraki çağrılarını eler; kullanıcının reddi (hak gerçekten bitti)
// ikisini de eler. Plansız (NoPlanError) ret başlatıcıdan bağımsızdır, kullanıcı
// bölmesinde durur.

const REFUSAL_TTL_MS = 30_000;
const MAX_REFUSALS = 5_000;

type Initiator = "user" | "system";
type Refusal = {
  until: number;
  amount: bigint;
  error: QuotaExceededError | NoPlanError;
};

const refusals = new Map<string, Refusal>();

const refusalKey = (workspaceId: string, initiator: Initiator) =>
  `${workspaceId}:${initiator}`;

// Bu çağrıyı eleyen canlı ret: kullanıcı çağrısı yalnız kullanıcı retlerine, sistem
// çağrısı ikisine de takılır. Ret, aynı boyutta ya da daha büyük çağrıyı eler (daha
// küçüğü sığabilir); plansız ret her boyutu eler.
function blockingRefusal(
  workspaceId: string,
  initiator: Initiator,
  amount: bigint,
  now: number,
): Refusal | undefined {
  const slots: Initiator[] =
    initiator === "user" ? ["user"] : ["user", "system"];
  for (const slot of slots) {
    const entry = refusals.get(refusalKey(workspaceId, slot));
    if (!entry || entry.until <= now) continue;
    if (entry.error instanceof NoPlanError || amount >= entry.amount) {
      return entry;
    }
  }
  return undefined;
}

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
  // Ledger ile önbellek aynı etiketi okur: operasyona açıkça verilir.
  const initiator: Initiator = isBackground() ? "system" : "user";
  const refused = blockingRefusal(input.workspaceId, initiator, amount, now);
  if (refused) throw asBudgetStop(refused.error);

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
        initiator,
        requireAccess: true,
      },
      fn,
    );
  } catch (error) {
    if (isQuotaError(error)) {
      if (refusals.size >= MAX_REFUSALS) refusals.clear();
      // Plansız ret herkesi eler: kullanıcı bölmesine yazılır.
      const slot = error instanceof NoPlanError ? "user" : initiator;
      refusals.set(refusalKey(input.workspaceId, slot), {
        until: now + REFUSAL_TTL_MS,
        amount,
        error,
      });
      throw asBudgetStop(error);
    }
    throw error;
  }
}
