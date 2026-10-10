import "server-only";

import { getEnv } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { TRIAL, type PlanKey } from "@/lib/billing/plans";
import { addDaysUTC } from "@/lib/billing/windows";

import { getBillingConfig } from "./config";
import { ensurePeriod } from "./ledger";

// 7 günlük sınırlı ücretsiz deneme (Faz 5 kayıt akışı bağlar). Bir workspace
// hayatında YALNIZ BİR deneme alır: trialEndsAt bir kez yazılır, hiç silinmez
// (yeniden aktivasyonda ikinci deneme yok).
export type StartTrialResult =
  | { ok: true; trialEndsAt: Date }
  | {
      ok: false;
      reason: "ALREADY_TRIALED" | "ALREADY_SUBSCRIBED" | "BILLING_OFF";
    };

export async function startTrial(
  workspaceId: string,
  options: { planKey?: PlanKey; now?: Date } = {},
): Promise<StartTrialResult> {
  const now = options.now ?? new Date();
  if (getBillingConfig().mode === "off") {
    return { ok: false, reason: "BILLING_OFF" };
  }

  const result = await prisma.$transaction(
    async (tx): Promise<StartTrialResult> => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`usage:${workspaceId}`}, 0))`;
      const existing = await tx.subscription.findUnique({
        where: { workspaceId },
      });
      if (existing?.trialEndsAt)
        return { ok: false, reason: "ALREADY_TRIALED" };
      // Ücretli (ya da ücretli süresi süren) abonelik varsa deneme verilmez.
      if (
        existing &&
        existing.status !== "LEGACY" &&
        existing.status !== "TRIALING"
      ) {
        return { ok: false, reason: "ALREADY_SUBSCRIBED" };
      }
      const trialEndsAt = addDaysUTC(now, TRIAL.days);
      const data = {
        planKey: options.planKey ?? existing?.planKey ?? null,
        status: "TRIALING",
        quotaAnchor: now,
        trialEndsAt,
      };
      await tx.subscription.upsert({
        where: { workspaceId },
        create: { workspaceId, interval: "MONTH", ...data },
        update: data,
      });
      return { ok: true, trialEndsAt };
    },
    { maxWait: 10_000, timeout: 15_000 },
  );
  if (!result.ok) return result;

  // Deneme penceresini aç (ayrı işlem: kilit çıkışta bırakıldı).
  await ensurePeriod(workspaceId, { now });
  return result;
}

// -- Kayıtta deneme (Faz 5) -----------------------------------------------------------

export type SignupTrialResult =
  | { started: true; trialEndsAt: Date }
  | {
      started: false;
      reason:
        | "BILLING_OFF"
        | "LEGACY_COHORT"
        | "DAILY_CAP"
        | "ALREADY_TRIALED"
        | "ALREADY_SUBSCRIBED"
        | "ERROR";
    };

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TRIALS_PER_DAY = 100;

// Kayıt akışının çağırdığı deneme: yeni workspace kartsız 7 gün alır (TRIAL.quota). ASLA
// fırlatmaz: kayıt faturalama yüzünden başarısız olmaz (deneme verilemezse workspace
// denemesiz kalır ve plan seçer). Üç koruma:
//  - BILLING_MODE=off: hiçbir şey yazılmaz (satır varlığı LEGACY kararını değiştirir; kapalıyken
//    kohort yalnız açılış tarihinden türer).
//  - Eski müşteri kohortu: BILLING_LEGACY_BEFORE'dan ÖNCE açılmış (satırsız) workspace LEGACY
//    sayılır; deneme satırı onu kohorttan çıkarıp 7 günlük geçişten yoksun bırakırdı. Yeni
//    kayıt "şimdi" açıldığı için tarih ileride bir değerse yeni kayıtlar da kohorttadır.
//  - Günlük üst sınır (TRIAL_MAX_PER_DAY): her deneme gerçek AI maliyeti taşır ve kayıtta
//    e-posta doğrulaması yoktur; sınır aşılırsa yeni kayıt deneme almaz. Sayım, son 24 saatte
//    BAŞLAYAN denemelerdir (trialEndsAt bir kez yazılır: başlangıç + 7 gün).
export async function startSignupTrial(
  workspaceId: string,
  options: { now?: Date } = {},
): Promise<SignupTrialResult> {
  const now = options.now ?? new Date();
  try {
    const config = getBillingConfig();
    if (config.mode === "off") return { started: false, reason: "BILLING_OFF" };
    if (config.legacyBefore && now.getTime() < config.legacyBefore.getTime()) {
      return { started: false, reason: "LEGACY_COHORT" };
    }
    const cap = getEnv().TRIAL_MAX_PER_DAY ?? DEFAULT_TRIALS_PER_DAY;
    const startedLastDay = await prisma.subscription.count({
      where: {
        trialEndsAt: {
          gt: new Date(now.getTime() + (TRIAL.days - 1) * DAY_MS),
        },
      },
    });
    if (startedLastDay >= cap) {
      console.error(
        `[billing] signup trial not given: ${startedLastDay} trials already started in the last 24 hours (TRIAL_MAX_PER_DAY=${cap})`,
      );
      return { started: false, reason: "DAILY_CAP" };
    }
    const trial = await startTrial(workspaceId, { now });
    return trial.ok
      ? { started: true, trialEndsAt: trial.trialEndsAt }
      : { started: false, reason: trial.reason };
  } catch (error) {
    console.error(
      "[billing] could not start the signup trial:",
      error instanceof Error ? error.name : error,
    );
    return { started: false, reason: "ERROR" };
  }
}
