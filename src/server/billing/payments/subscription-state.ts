import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  paidPlanRunning,
  pastDueGraceEnd,
} from "@/lib/billing/entitlements-core";
import {
  RENEWAL_LAG_MS,
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
//  - `paidThrough` YALNIZ ödenmiş fatura (paid) ile ilerler; geri gitmez (tek istisna:
//    iade/itiraz erişimi hemen bitirir, bkz. refunds.ts).
//  - Parası iade/itiraz edilen fatura (BillingReversal) ASLA "ödenmiş" sayılmaz: aynı
//    faturanın yeniden işlenmesi (Checkout dönüş adresi, yeniden gönderilen olay) erişimi
//    geri getirmez.
//  - Durum, iptal bayrağı ve plan GÖRÜNTÜYE dayanır: kilitten önce okunmuş eski bir
//    görüntü, daha yeni uygulanmış olanı ezmez (stripeSyncedAt). Ödeme ve iptal monotondur.
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

type LinkDecision =
  | "link"
  | "unknown-plan"
  | "duplicate-subscription"
  | "live-subscription-exists";

type RowForLink = {
  planKey: string | null;
  status: string;
  paidThrough: Date | null;
  graceUntil: Date | null;
  cancelAtPeriodEnd: boolean;
  stripeSubscriptionId: string | null;
  stripeLivemode: boolean | null;
};

// Yalnız hâlâ erişim veren bir abonelik ikinci bir aboneliğin bağlanmasını engeller.
// Ödenmiş süresi bitmiş ("zombi") ACTIVE satır, iptal olayı kaçmış olsa da yeni ödemeyi
// engellemez; canlı ödeme yapan bir satırı TEST aboneliği ezemez (tersi serbest: canlı
// ödeme, test bağını değiştirir).
function decideLink(
  row: RowForLink | null,
  sub: StripeSubscriptionFacts,
  now: Date,
): LinkDecision {
  if (!sub.planKey || !sub.interval) return "unknown-plan";
  if (
    row?.stripeSubscriptionId &&
    row.stripeSubscriptionId !== sub.id &&
    (row.status === "ACTIVE" || row.status === "PAST_DUE") &&
    paidPlanRunning(row, now)
  ) {
    const sameMode = (row.stripeLivemode ?? sub.livemode) === sub.livemode;
    if (sameMode) return "duplicate-subscription";
    if (row.stripeLivemode === true) return "live-subscription-exists";
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

  const result = await prisma.$transaction(
    async (tx): Promise<SubscriptionSyncResult> => {
      await lockWorkspace(tx, workspaceId);
      const row = await tx.subscription.findUnique({ where: { workspaceId } });
      const notes: string[] = [];

      // Parası iade/itiraz edilen fatura ödenmiş SAYILMAZ (Stripe onu "paid" bırakır).
      const reversed = await reversedInvoiceIds(tx, [
        input.paid?.id,
        sub.latestInvoice?.id,
      ]);
      const paidReversed = Boolean(input.paid && reversed.has(input.paid.id));
      const paid = paidReversed ? null : (input.paid ?? null);
      const latest =
        sub.latestInvoice && !reversed.has(sub.latestInvoice.id)
          ? sub.latestInvoice
          : null;

      // -- bağlanmamış abonelik --------------------------------------------
      if (row?.stripeSubscriptionId !== sub.id) {
        if (!paid) {
          return {
            applied: false,
            note: paidReversed
              ? "invoice-reversed"
              : row?.stripeSubscriptionId
                ? "stale-subscription"
                : "awaiting-payment",
          };
        }
        const decision = decideLink(row, sub, now);
        if (decision !== "link") return { applied: false, note: decision };

        const periodEnd = paid.periodEnd ?? sub.currentPeriodEnd;
        if (!periodEnd) return { applied: false, note: "no-paid-period" };

        // Eski satırın geçmişi (ilk ay indirimi, ödenmiş süre) YALNIZ aynı Stripe modundaysa
        // yeni aboneliğe geçer: test kartıyla alınmış bir indirim ya da süre, canlı aboneliğe
        // sızmasın (canlıda ilk ay indirimi hâlâ sunulur, test süresi canlı erişim vermez).
        const sameMode = (row?.stripeLivemode ?? sub.livemode) === sub.livemode;
        const introUsedBefore = sameMode && row?.introOffer === true;
        const isFirstInvoice = paid.billingReason === "subscription_create";
        const intro =
          isFirstInvoice && !introUsedBefore && sub.metadata.intro === "1";
        const canceled = sub.status === "canceled";
        // İptal edilmiş ama ödenmiş süresi SÜREN satır (ör. yıllık plan, panelden anında
        // iptal): yeni abonelik bu süreyi kısaltmaz.
        const keptPaidThrough =
          sameMode &&
          row?.status === "CANCELED" &&
          row.paidThrough &&
          row.paidThrough.getTime() >
            Math.max(now.getTime(), periodEnd.getTime())
            ? row.paidThrough
            : null;
        if (keptPaidThrough) notes.push("kept-paid-time");
        const data = {
          planKey: sub.planKey!,
          interval: sub.interval!,
          status: canceled ? "CANCELED" : "ACTIVE",
          quotaAnchor: sub.startDate ?? paid.periodStart ?? now,
          paidThrough: keptPaidThrough ?? periodEnd,
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
          stripeSyncedAt: sub.fetchedAt,
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
      // Bu görüntü, satıra zaten uygulanmış olandan ESKİ mi (kilitten önce okunmuştu)?
      // Eskiyse durum/iptal bayrağı/plan değişmez; ödeme ve iptal yine uygulanır.
      const stale =
        row.stripeSyncedAt !== null &&
        sub.fetchedAt.getTime() < row.stripeSyncedAt.getTime();
      if (stale) notes.push("stale-snapshot");
      if (paidReversed) notes.push("invoice-reversed");
      const data: Prisma.SubscriptionUpdateInput = {};
      let reopened = false;
      let status = row.status;
      // Stripe da aboneliği iyi durumda görüyor (ödeme gecikmesi/iptal yok).
      const goodStanding = sub.status === "active" || sub.status === "trialing";

      // 1. Para: ödenmiş süre yalnız ilerler.
      if (paid) {
        const periodEnd = paid.periodEnd;
        if (periodEnd && (!row.paidThrough || periodEnd > row.paidThrough)) {
          data.paidThrough = periodEnd;
          reopened = true;
        }
        if (goodStanding) {
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
      } else if (
        !stale &&
        goodStanding &&
        row.status === "PAST_DUE" &&
        latest?.status === "paid" &&
        // Bu dalda süre ilerletilemez (anlık görüntü faturanın dönemini taşımaz): ACTIVE'e
        // yalnız mevcut ödenmiş süre hâlâ örtüyorsa dönülür. Örtmüyorsa PAST_DUE ve ek süre
        // kalır; yenilenen dönemi ödeme olayı / süpürme (fatura ile) getirir. Aksi hâlde
        // kartını düzelten müşteri, ek sürenin yerine geçen ESKİ süre yüzünden salt-okunur olurdu.
        row.paidThrough !== null &&
        row.paidThrough.getTime() + RENEWAL_LAG_MS > now.getTime()
      ) {
        // Ödeme olayı kaçsa da Stripe aboneliği "active" + son fatura ödenmiş görüyor:
        // gecikme bitti (paidThrough ödeme olayıyla ilerler).
        data.status = "ACTIVE";
        data.graceUntil = null;
        status = "ACTIVE";
        reopened = true;
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
        !stale &&
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
        !stale &&
        (status === "ACTIVE" || status === "PAST_DUE") &&
        row.cancelAtPeriodEnd !== sub.cancelAtPeriodEnd
      ) {
        data.cancelAtPeriodEnd = sub.cancelAtPeriodEnd;
      }

      // 4. Plan / aralık.
      if (
        !stale &&
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
          cycleAdvanced: data.paidThrough !== undefined,
          // Yükseltmenin parası: uygulamanın yaptığı (always_invoice) orantı faturası.
          updateInvoice:
            latest?.status === "paid" &&
            latest.billingReason === "subscription_update"
              ? latest
              : null,
        });
        notes.push(...planChange.notes);
        if (planChange.reopened) reopened = true;
      }

      const changed = Object.keys(data).length > 0;
      const syncedAt =
        !stale &&
        (!row.stripeSyncedAt ||
          sub.fetchedAt.getTime() > row.stripeSyncedAt.getTime())
          ? sub.fetchedAt
          : null;
      if (changed || syncedAt) {
        await tx.subscription.update({
          where: { workspaceId },
          data: { ...data, ...(syncedAt ? { stripeSyncedAt: syncedAt } : {}) },
        });
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

// Parası iade/itiraz edilmiş fatura kimlikleri (kilit altında okunur).
async function reversedInvoiceIds(
  tx: Tx,
  ids: Array<string | null | undefined>,
): Promise<Set<string>> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (wanted.length === 0) return new Set();
  const rows = await tx.billingReversal.findMany({
    where: { stripeInvoiceId: { in: wanted } },
    select: { stripeInvoiceId: true },
  });
  return new Set(rows.map((row) => row.stripeInvoiceId));
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
  // Bu eşitlemede ödenmiş süre ilerledi mi (yeni dönem ödendi).
  cycleAdvanced: boolean;
  // Aboneliğin SON faturası ödenmiş bir plan değişikliği (orantı) faturasıysa o.
  updateInvoice: { id: string } | null;
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
    // Yükseltme parası ödenmeden hak vermeyiz. Ödenmiş sayılan yalnız plan değişikliği
    // (orantı) faturasıdır; aboneliğin eski bir ödenmiş faturası (panelden "sonraki faturada
    // orantıla" ile yapılan değişiklik) hak doğurmaz. Ödeme olayı aynı eşitlemeyi çağırır.
    if (input.updateInvoice) {
      await grantUpgradeDelta({
        tx,
        workspaceId,
        row,
        from: localPlan,
        to: stripePlan,
        invoiceId: input.updateInvoice.id,
        introWindow: input.introWindow,
        now,
      });
      data.planKey = stripePlan;
      data.interval = stripeInterval;
      clearPending();
      notes.push("upgraded");
      return { reopened: true, notes };
    }
    // Dışarıdan yapılmış, orantısı sonraki faturaya bırakılmış yükseltme: yeni plan,
    // yenileme faturası ödenince başlar. Yeni pencere yeni planın kotasıyla açılır; ek
    // fark hakkı verilmez.
    if (input.cycleInvoicePaid && input.cycleAdvanced) {
      data.planKey = stripePlan;
      data.interval = stripeInterval;
      clearPending();
      notes.push("upgraded-at-renewal");
      return { reopened: true, notes };
    }
    notes.push("upgrade-awaiting-payment");
    return { reopened: false, notes };
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
