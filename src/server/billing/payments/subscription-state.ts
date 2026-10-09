import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { pastDueGraceEnd } from "@/lib/billing/entitlements-core";
import {
  isPlanKey,
  quotaFor,
  sellableUnits,
  upgradeDelta,
  type PlanKey,
} from "@/lib/billing/plans";
import { quotaWindowAt, remainingFraction } from "@/lib/billing/windows";

import { ensurePeriod, GrantKeyConflictError, grantUsage } from "../ledger";
import { resumeParkedWork } from "../park";
import {
  isBillingInterval,
  isUpgrade,
  type BillingInterval,
} from "../stripe/catalog";
import type {
  StripeInvoiceFacts,
  StripeSubscriptionFacts,
} from "../stripe/facts";

// Stripe aboneliğinin DURUMUNU yerel Subscription satırına ve kullanım defterine
// yansıtan TEK yer. Her tetikleyici (webhook olayı, Checkout dönüşü, plan değiştirme /
// iptal eylemi) aynı fonksiyonu, Stripe'tan YENİ okunmuş verilerle çağırır; olay
// sırası ya da tekrar teslim sonucu değiştirmez (monoton ve idempotent).
//
// Sözleşme (docs/billing-quota.md):
//  - `paidThrough` YALNIZ ödenmiş fatura (paid) ile ilerler; geri gitmez.
//  - Satır YALNIZ ödeme kanıtıyla yazılır/bağlanır (satır varlığı LEGACY kararını
//    değiştirir): ödenmemiş abonelik olayı satır yaratmaz.
//  - Yükseltme anında geçerlidir ve ORANTILI fark hakkı verir; düşürme/aralık
//    değişikliği ödenmiş sürenin sonunda (pending*) devreye girer.
//  - Hepsi workspace kilidi altında tek işlemde (satır + hibe birlikte yazılır ya da
//    hiçbiri).

export type SubscriptionSyncResult =
  | { applied: true; changed: boolean; reopened: boolean; notes: string[] }
  | { applied: false; note: string };

// Bekleyen değişikliğin devreye girme anı ödenmiş sürenin SONUNDAN bu kadar önce
// sayılır: Stripe dönem sonu ile bizim pencere sınırımız saniye farkı taşısa da
// değişiklik bir ay geç kalmasın. Sınırlar en az 28 gün arayla olduğundan güvenlidir.
export const PENDING_SLACK_MS = 6 * 60 * 60 * 1000;

type Tx = Prisma.TransactionClient;

type LinkDecision = "link" | "unknown-plan" | "duplicate-subscription";

function decideLink(
  row: {
    status: string;
    stripeSubscriptionId: string | null;
    stripeLivemode: boolean | null;
  } | null,
  sub: StripeSubscriptionFacts,
): LinkDecision {
  if (!sub.planKey || !sub.interval) return "unknown-plan";
  if (
    row?.stripeSubscriptionId &&
    row.stripeSubscriptionId !== sub.id &&
    (row.stripeLivemode ?? sub.livemode) === sub.livemode &&
    (row.status === "ACTIVE" || row.status === "PAST_DUE")
  ) {
    return "duplicate-subscription";
  }
  return "link";
}

function endedReasonFor(cancellationReason: string | null): string {
  if (cancellationReason === "payment_failed") return "PAYMENT_FAILED";
  if (cancellationReason === "payment_disputed") return "CHARGEBACK";
  return "CANCELED";
}

export async function lockWorkspace(
  tx: Tx,
  workspaceId: string,
): Promise<void> {
  // ledger.ts ile AYNI kilit adı: hibe, pencere açma ve ödeme işleyicisi sıralanır.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`usage:${workspaceId}`}, 0))`;
}

export async function syncSubscriptionState(input: {
  workspaceId: string;
  sub: StripeSubscriptionFacts;
  // Bu çağrıda ödenmiş sayılan fatura (yoksa yalnız durum/plan/iptal eşitlenir).
  paid?: StripeInvoiceFacts | null;
  now?: Date;
}): Promise<SubscriptionSyncResult> {
  const now = input.now ?? new Date();
  const { workspaceId, sub } = input;
  const paid = input.paid ?? null;

  const result = await prisma.$transaction(
    async (tx): Promise<SubscriptionSyncResult> => {
      await lockWorkspace(tx, workspaceId);
      const row = await tx.subscription.findUnique({ where: { workspaceId } });
      const notes: string[] = [];

      // -- bağlanmamış abonelik --------------------------------------------
      if (row?.stripeSubscriptionId !== sub.id) {
        if (!paid) {
          return {
            applied: false,
            note: row?.stripeSubscriptionId
              ? "stale-subscription"
              : "awaiting-payment",
          };
        }
        const decision = decideLink(row, sub);
        if (decision !== "link") return { applied: false, note: decision };

        const periodEnd = paid.periodEnd ?? sub.currentPeriodEnd;
        if (!periodEnd) return { applied: false, note: "no-paid-period" };

        const introUsedBefore = row?.introOffer === true;
        const isFirstInvoice = paid.billingReason === "subscription_create";
        const intro =
          isFirstInvoice && !introUsedBefore && sub.metadata.intro === "1";
        const canceled = sub.status === "canceled";
        const data = {
          planKey: sub.planKey!,
          interval: sub.interval!,
          status: canceled ? "CANCELED" : "ACTIVE",
          quotaAnchor: sub.startDate ?? paid.periodStart ?? now,
          paidThrough: periodEnd,
          graceUntil: null,
          endedAt: canceled ? (sub.endedAt ?? now) : null,
          endedReason: canceled ? endedReasonFor(sub.cancellationReason) : null,
          cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
          periodIndex: isFirstInvoice && !introUsedBefore ? 1 : 2,
          introOffer: introUsedBefore || intro,
          pendingPlanKey: null,
          pendingInterval: null,
          pendingEffectiveAt: null,
          stripeSubscriptionId: sub.id,
          stripeLivemode: sub.livemode,
        };
        await tx.subscription.upsert({
          where: { workspaceId },
          create: { workspaceId, ...data },
          update: data,
        });
        notes.push("linked");
        return { applied: true, changed: true, reopened: true, notes };
      }

      // -- bağlı abonelik -----------------------------------------------------
      const data: Prisma.SubscriptionUpdateInput = {};
      let reopened = false;
      let status = row.status;

      // 1. Para: ödenmiş süre yalnız ilerler.
      if (paid) {
        const periodEnd = paid.periodEnd;
        if (periodEnd && (!row.paidThrough || periodEnd > row.paidThrough)) {
          data.paidThrough = periodEnd;
          reopened = true;
        }
        if (sub.status !== "canceled") {
          if (row.status !== "ACTIVE") {
            // Ödeme düzeldi ya da iade sonrası yeniden ödeme geldi.
            data.status = "ACTIVE";
            data.endedAt = null;
            data.endedReason = null;
            status = "ACTIVE";
            reopened = true;
          }
          if (row.graceUntil) data.graceUntil = null;
        }
        if (
          paid.billingReason === "subscription_cycle" &&
          row.periodIndex < 2
        ) {
          data.periodIndex = 2;
        }
      }

      // 2. Durum (para olmayan geçişler): iptal ve ödeme gecikmesi.
      if (sub.status === "canceled") {
        if (status !== "CANCELED") {
          data.status = "CANCELED";
          data.endedAt = sub.endedAt ?? now;
          data.endedReason = endedReasonFor(sub.cancellationReason);
          data.graceUntil = null;
          status = "CANCELED";
        }
        if (
          row.pendingPlanKey ||
          row.pendingInterval ||
          row.pendingEffectiveAt
        ) {
          data.pendingPlanKey = null;
          data.pendingInterval = null;
          data.pendingEffectiveAt = null;
        }
      } else if (
        (sub.status === "past_due" || sub.status === "unpaid") &&
        status === "ACTIVE" &&
        !paid
      ) {
        data.status = "PAST_DUE";
        // Ek süre YALNIZ PAST_DUE'ya girerken başlar (her yeniden denemede uzamaz).
        data.graceUntil = pastDueGraceEnd(now);
        status = "PAST_DUE";
      }

      // 3. "Dönem sonunda iptal" işareti.
      if (
        (status === "ACTIVE" || status === "PAST_DUE") &&
        row.cancelAtPeriodEnd !== sub.cancelAtPeriodEnd
      ) {
        data.cancelAtPeriodEnd = sub.cancelAtPeriodEnd;
      }

      // 4. Plan / aralık.
      if (
        (status === "ACTIVE" || status === "PAST_DUE") &&
        sub.planKey &&
        sub.interval
      ) {
        const planChange = await reconcilePlan({
          tx,
          workspaceId,
          row,
          sub,
          data,
          now,
          paidThrough:
            (data.paidThrough as Date | undefined) ?? row.paidThrough,
          introWindow: row.introOffer && row.periodIndex === 1,
          cycleInvoicePaid: paid?.billingReason === "subscription_cycle",
        });
        notes.push(...planChange.notes);
        if (planChange.reopened) reopened = true;
      }

      const changed = Object.keys(data).length > 0;
      if (changed) {
        await tx.subscription.update({ where: { workspaceId }, data });
      }
      return { applied: true, changed, reopened, notes };
    },
    { maxWait: 10_000, timeout: 20_000 },
  );

  if (result.applied && result.reopened) {
    await afterEntitlementGrowth(workspaceId, now);
  }
  return result;
}

// Hakkı artmış olabilecek bir değişiklikten sonra (ödeme, yükseltme, bağlama): penceresi
// açılır ve hakkı bekleyen işler devam eder. İşlem DIŞINDA, hataları ödemeyi geri
// çevirmez (periyodik tick aynı işi telafi eder).
export async function afterEntitlementGrowth(
  workspaceId: string,
  now: Date,
): Promise<void> {
  try {
    await ensurePeriod(workspaceId, { now });
    await resumeParkedWork({ workspaceId, now });
  } catch (error) {
    console.error(
      "[billing] could not open the window / resume parked work after a payment:",
      error instanceof Error ? error.name : error,
    );
  }
}

async function reconcilePlan(input: {
  tx: Tx;
  workspaceId: string;
  row: NonNullable<Awaited<ReturnType<Tx["subscription"]["findUnique"]>>>;
  sub: StripeSubscriptionFacts;
  data: Prisma.SubscriptionUpdateInput;
  now: Date;
  paidThrough: Date | null;
  introWindow: boolean;
  cycleInvoicePaid: boolean;
}): Promise<{ reopened: boolean; notes: string[] }> {
  const { tx, workspaceId, row, sub, data, now } = input;
  const notes: string[] = [];
  const stripePlan = sub.planKey!;
  const stripeInterval = sub.interval!;
  const localPlan = isPlanKey(row.planKey) ? row.planKey : null;
  const localInterval = isBillingInterval(row.interval) ? row.interval : null;

  const clearPending = () => {
    if (row.pendingPlanKey || row.pendingInterval || row.pendingEffectiveAt) {
      data.pendingPlanKey = null;
      data.pendingInterval = null;
      data.pendingEffectiveAt = null;
    }
  };

  // Satırda plan yoksa (tutarsız) Stripe'ınkini benimse.
  if (!localPlan || !localInterval) {
    data.planKey = stripePlan;
    data.interval = stripeInterval;
    clearPending();
    notes.push("plan-adopted");
    return { reopened: true, notes };
  }

  if (stripePlan === localPlan && stripeInterval === localInterval) {
    clearPending();
    return { reopened: false, notes };
  }

  // Zamanlanmış değişiklik yenileme faturası ödenince devreye girer (ensurePeriod
  // bunu pencere açarken de yapar; burada satır her kipte tutarlı kalsın diye).
  if (
    input.cycleInvoicePaid &&
    row.pendingEffectiveAt &&
    row.pendingEffectiveAt.getTime() <= now.getTime() &&
    (row.pendingPlanKey ?? localPlan) === stripePlan &&
    (row.pendingInterval ?? localInterval) === stripeInterval
  ) {
    data.planKey = stripePlan;
    data.interval = stripeInterval;
    clearPending();
    notes.push("pending-applied");
    return { reopened: true, notes };
  }

  if (
    isUpgrade(
      { planKey: localPlan, interval: localInterval },
      { planKey: stripePlan, interval: stripeInterval },
    )
  ) {
    // Yükseltme parası ödenmeden hak vermeyiz (fatura ödendi görünene dek bekle; ödeme
    // olayı aynı eşitlemeyi yeniden çağırır).
    if (sub.latestInvoice?.status !== "paid") {
      notes.push("upgrade-awaiting-payment");
      return { reopened: false, notes };
    }
    await grantUpgradeDelta({
      tx,
      workspaceId,
      row,
      from: localPlan,
      to: stripePlan,
      invoiceId: sub.latestInvoice.id,
      introWindow: input.introWindow,
      now,
    });
    data.planKey = stripePlan;
    data.interval = stripeInterval;
    clearPending();
    notes.push("upgraded");
    return { reopened: true, notes };
  }

  // Düşürme (ya da daha ucuz aralık): ödenmiş sürenin sonunda devreye girer.
  if (!input.paidThrough) {
    notes.push("downgrade-without-paid-period");
    return { reopened: false, notes };
  }
  const effectiveAt = new Date(input.paidThrough.getTime() - PENDING_SLACK_MS);
  const wantedPlan = stripePlan === localPlan ? null : stripePlan;
  const wantedInterval =
    stripeInterval === localInterval ? null : stripeInterval;
  if (
    row.pendingPlanKey !== wantedPlan ||
    row.pendingInterval !== wantedInterval ||
    row.pendingEffectiveAt?.getTime() !== effectiveAt.getTime()
  ) {
    data.pendingPlanKey = wantedPlan;
    data.pendingInterval = wantedInterval;
    data.pendingEffectiveAt = effectiveAt;
    notes.push("downgrade-scheduled");
  }
  return { reopened: false, notes };
}

async function grantUpgradeDelta(input: {
  tx: Tx;
  workspaceId: string;
  row: NonNullable<Awaited<ReturnType<Tx["subscription"]["findUnique"]>>>;
  from: PlanKey;
  to: PlanKey;
  invoiceId: string;
  introWindow: boolean;
  now: Date;
}): Promise<void> {
  const { tx, workspaceId, row, now } = input;
  if (!row.quotaAnchor) return;
  const window = quotaWindowAt(row.quotaAnchor, now);
  if (!window) return;
  // İlk ay penceresinde (kampanya) iki plan da aynı çarpanla ölçülür.
  const firstMonth = input.introWindow && window.index === 0;
  const delta = upgradeDelta(
    quotaFor(input.from, { firstMonth }),
    quotaFor(input.to, { firstMonth }),
    remainingFraction(window, now),
  );
  for (const unit of sellableUnits()) {
    const amount = delta[unit];
    if (amount <= 0) continue;
    try {
      await grantUsage(
        {
          workspaceId,
          unit,
          pool: "PERIOD",
          amount,
          reason: "PLAN_CHANGE",
          // Değişimin kimliği: ödenen orantı faturası + plan çifti.
          idempotencyKey: `plan-change:${input.invoiceId}:${input.from}>${input.to}`,
          periodStart: window.start,
          now,
        },
        tx,
      );
    } catch (error) {
      // Aynı değişim başka bir yoldan zaten verildi: tekrar vermek yerine geç.
      if (!(error instanceof GrantKeyConflictError)) throw error;
    }
  }
}
