import "server-only";

import { prisma } from "@/lib/prisma";
import {
  EXTRA_PACKS,
  PLANS,
  isPlanKey,
  type ExtraPackKey,
  type PlanKey,
} from "@/lib/billing/plans";

import {
  isBillingInterval,
  isUpgrade,
  type BillingInterval,
} from "../stripe/catalog";
import { StripeApiError, StripeNetworkError } from "../stripe/client";
import type { StripeMode } from "../stripe/config";
import { StripeShapeError, type StripeInvoiceRow } from "../stripe/facts";
import type { StripeGateway } from "../stripe/gateway";
import { ensureBillingCustomer, forgetBillingCustomer } from "./customers";
import { handleCheckoutSession } from "./events";
import { syncSubscriptionState } from "./subscription-state";

// Kullanıcının başlattığı ödeme eylemleri (Checkout, portal, plan değiştirme, iptal).
// Sunucu tarafında tek yetki noktası: fiyat plans.ts'ten gelir, Stripe kimlikleri
// yalnız BU workspace'in kendi kayıtlarından okunur, istemciden yalnız plan anahtarı /
// aralık / paket anahtarı alınır ve doğrulanır. Rol denetimi çağıranda (server action).

export type PaymentDeps = {
  gateway: StripeGateway;
  mode: StripeMode;
  // Mutlak uygulama adresi (Checkout dönüşleri için), sonunda "/" yok.
  appUrl: string;
};

export type BillingActionError =
  | "FORBIDDEN"
  | "PAYMENTS_CLOSED"
  | "RATE_LIMITED"
  | "ALREADY_SUBSCRIBED"
  | "NO_SUBSCRIPTION"
  | "NO_CUSTOMER"
  | "PLAN_REQUIRED"
  | "DISCOUNT_NOT_AVAILABLE"
  | "PAYMENT_PROBLEM"
  | "CARD_DECLINED"
  | "INVALID_INPUT"
  | "PROVIDER_ERROR";

export type ActionResult<T extends object = object> =
  | ({ ok: true } & T)
  | { ok: false; error: BillingActionError; message: string };

const MESSAGES: Record<BillingActionError, string> = {
  FORBIDDEN: "Only a workspace owner or admin can change billing.",
  PAYMENTS_CLOSED: "Payments are not open yet.",
  RATE_LIMITED: "Too many attempts. Wait a few minutes and try again.",
  ALREADY_SUBSCRIBED:
    "This workspace already has an active subscription. Change the plan or resume it from My Subscription.",
  NO_SUBSCRIPTION: "There is no active subscription to change.",
  NO_CUSTOMER: "No billing profile exists yet. Subscribe to a plan first.",
  PLAN_REQUIRED: "Extra packs are available while you have a plan.",
  DISCOUNT_NOT_AVAILABLE:
    "The first-month discount is only available on a first monthly subscription.",
  PAYMENT_PROBLEM:
    "The last payment did not go through. Update the payment method first, then change the plan.",
  CARD_DECLINED:
    "The card was declined or needs extra verification. Nothing was changed. Try another card from Manage payment method.",
  INVALID_INPUT: "That choice is not valid.",
  PROVIDER_ERROR:
    "The payment provider could not complete this just now. Nothing was charged. Try again in a moment.",
};

export function fail(error: BillingActionError): {
  ok: false;
  error: BillingActionError;
  message: string;
} {
  return { ok: false, error, message: MESSAGES[error] };
}

// Stripe hatasını kullanıcıya gösterilecek güvenli bir sınıfa çevirir; ayrıntı yalnız
// sunucu günlüğüne gider (kart verisi hiç görülmez, Stripe mesajı da gösterilmez).
export function describeProviderError(error: unknown): BillingActionError {
  if (error instanceof StripeApiError) {
    // Stripe's own message (never shown to the customer) tells the operator what to fix,
    // e.g. "no billing portal configuration"; it carries no card or key data.
    console.error(
      `[billing] Stripe error status=${error.status} code=${error.code ?? "-"} type=${error.type ?? "-"} request=${error.requestId ?? "-"}: ${error.message.slice(0, 240)}`,
    );
    if (
      error.type === "card_error" ||
      error.code === "card_declined" ||
      error.code === "payment_intent_authentication_failure" ||
      error.code === "payment_method_unactivated"
    ) {
      return "CARD_DECLINED";
    }
    return "PROVIDER_ERROR";
  }
  if (error instanceof StripeNetworkError) {
    console.error("[billing] Stripe unreachable:", error.message);
    return "PROVIDER_ERROR";
  }
  if (error instanceof StripeShapeError) {
    console.error("[billing]", error.message);
    return "PROVIDER_ERROR";
  }
  throw error;
}

// İlk ay kampanyası: yalnız ilk aylık aboneliğe (bu workspace daha önce Stripe ile
// ödeme yapmadı, kampanyayı kullanmadı) ve kampanya fiyatı olan plana.
export function firstMonthEligible(
  row: { introOffer: boolean; stripeSubscriptionId: string | null } | null,
  planKey: PlanKey,
  interval: BillingInterval,
): boolean {
  return (
    interval === "MONTH" &&
    !row?.stripeSubscriptionId &&
    !row?.introOffer &&
    PLANS[planKey].firstMonthCents < PLANS[planKey].monthlyCents
  );
}

const returnUrl = (deps: PaymentDeps, query: string) =>
  `${deps.appUrl}/billing?${query}`;

// -- Checkout ---------------------------------------------------------------------

export async function startSubscriptionCheckout(
  input: {
    workspaceId: string;
    email?: string | null;
    name?: string | null;
    planKey: unknown;
    interval: unknown;
    applyFirstMonth: boolean;
  },
  deps: PaymentDeps,
): Promise<ActionResult<{ url: string }>> {
  if (!isPlanKey(input.planKey) || !isBillingInterval(input.interval)) {
    return fail("INVALID_INPUT");
  }
  const { planKey, interval } = input;
  const row = await prisma.subscription.findUnique({
    where: { workspaceId: input.workspaceId },
  });
  // Ödeme süren abonelik varken ikinci abonelik açılmaz (çift tahsilat).
  if (
    row?.stripeSubscriptionId &&
    (row.status === "ACTIVE" || row.status === "PAST_DUE")
  ) {
    return fail("ALREADY_SUBSCRIBED");
  }
  const eligible = firstMonthEligible(row, planKey, interval);
  if (input.applyFirstMonth && !eligible) return fail("DISCOUNT_NOT_AVAILABLE");

  try {
    const create = async () => {
      const customerId = await ensureBillingCustomer({
        workspaceId: input.workspaceId,
        livemode: deps.mode === "live",
        gateway: deps.gateway,
        email: input.email,
        name: input.name,
      });
      return deps.gateway.createSubscriptionCheckout({
        customerId,
        workspaceId: input.workspaceId,
        planKey,
        interval,
        firstMonth: input.applyFirstMonth,
        successUrl: returnUrl(
          deps,
          "tab=subscription&checkout=success&session_id={CHECKOUT_SESSION_ID}",
        ),
        cancelUrl: returnUrl(deps, "tab=plans&checkout=cancelled"),
      });
    };
    const session = await createWithCustomerRecovery(
      create,
      input.workspaceId,
      deps,
    );
    return { ok: true, url: session.url };
  } catch (error) {
    return fail(describeProviderError(error));
  }
}

export async function startPackCheckout(
  input: {
    workspaceId: string;
    email?: string | null;
    name?: string | null;
    packKey: unknown;
  },
  deps: PaymentDeps,
  now: Date = new Date(),
): Promise<ActionResult<{ url: string }>> {
  if (
    typeof input.packKey !== "string" ||
    !Object.prototype.hasOwnProperty.call(EXTRA_PACKS, input.packKey)
  ) {
    return fail("INVALID_INPUT");
  }
  const packKey = input.packKey as ExtraPackKey;
  const row = await prisma.subscription.findUnique({
    where: { workspaceId: input.workspaceId },
  });
  const hasPlan =
    row &&
    (row.status === "ACTIVE" ||
      row.status === "PAST_DUE" ||
      (row.status === "CANCELED" &&
        row.paidThrough !== null &&
        row.paidThrough.getTime() > now.getTime()));
  if (!hasPlan) return fail("PLAN_REQUIRED");

  try {
    const create = async () => {
      const customerId = await ensureBillingCustomer({
        workspaceId: input.workspaceId,
        livemode: deps.mode === "live",
        gateway: deps.gateway,
        email: input.email,
        name: input.name,
      });
      return deps.gateway.createPackCheckout({
        customerId,
        workspaceId: input.workspaceId,
        packKey,
        successUrl: returnUrl(
          deps,
          "tab=usage&purchase=success&session_id={CHECKOUT_SESSION_ID}",
        ),
        cancelUrl: returnUrl(deps, "tab=usage&purchase=cancelled"),
      });
    };
    const session = await createWithCustomerRecovery(
      create,
      input.workspaceId,
      deps,
    );
    return { ok: true, url: session.url };
  } catch (error) {
    return fail(describeProviderError(error));
  }
}

// Stripe'ta silinmiş bir müşteriye bağlı eski eşleme Checkout'u kırar: eşlemeyi bırakıp
// bir kez yeniden dene.
async function createWithCustomerRecovery<T>(
  create: () => Promise<T>,
  workspaceId: string,
  deps: PaymentDeps,
): Promise<T> {
  try {
    return await create();
  } catch (error) {
    if (
      error instanceof StripeApiError &&
      error.code === "resource_missing" &&
      error.param === "customer"
    ) {
      await forgetBillingCustomer(workspaceId, deps.mode === "live");
      return create();
    }
    throw error;
  }
}

// -- Portal -----------------------------------------------------------------------

export async function openBillingPortal(
  input: { workspaceId: string },
  deps: PaymentDeps,
): Promise<ActionResult<{ url: string }>> {
  const link = await prisma.billingCustomer.findUnique({
    where: {
      workspaceId_livemode: {
        workspaceId: input.workspaceId,
        livemode: deps.mode === "live",
      },
    },
  });
  if (!link) return fail("NO_CUSTOMER");
  try {
    const portal = await deps.gateway.createPortalSession({
      customerId: link.stripeCustomerId,
      returnUrl: returnUrl(deps, "tab=subscription"),
    });
    return { ok: true, url: portal.url };
  } catch (error) {
    return fail(describeProviderError(error));
  }
}

// -- İptal / devam ----------------------------------------------------------------

async function loadPayingRow(workspaceId: string) {
  const row = await prisma.subscription.findUnique({ where: { workspaceId } });
  if (
    !row?.stripeSubscriptionId ||
    (row.status !== "ACTIVE" && row.status !== "PAST_DUE")
  ) {
    return null;
  }
  return row as typeof row & { stripeSubscriptionId: string };
}

async function setCancel(
  workspaceId: string,
  cancel: boolean,
  deps: PaymentDeps,
  now?: Date,
): Promise<ActionResult> {
  const row = await loadPayingRow(workspaceId);
  if (!row) return fail("NO_SUBSCRIPTION");
  try {
    const sub = await deps.gateway.setCancelAtPeriodEnd(
      row.stripeSubscriptionId,
      cancel,
    );
    await syncSubscriptionState({ workspaceId, sub, now });
    return { ok: true };
  } catch (error) {
    return fail(describeProviderError(error));
  }
}

export const cancelAtPeriodEnd = (
  workspaceId: string,
  deps: PaymentDeps,
  now?: Date,
) => setCancel(workspaceId, true, deps, now);

export const resumeSubscription = (
  workspaceId: string,
  deps: PaymentDeps,
  now?: Date,
) => setCancel(workspaceId, false, deps, now);

// -- Plan değiştirme --------------------------------------------------------------

export type PlanChangeKind =
  "unchanged" | "upgraded" | "upgrade-processing" | "downgrade-scheduled";

// Aralık (aylık/yıllık) bu ekrandan değişmez; plan değişir. Her zaman ÖDENEN (yerel)
// plana göre karar verilir: bekleyen bir düşürme varsa Stripe kalemi önce ödenen plana
// geri alınır (para hareketi yok), sonra istenen değişiklik oradan uygulanır; böylece
// "düşür, vazgeç, yükselt" sırası aynı dönemi iki kez ücretlendirmez.
export async function changePlan(
  input: { workspaceId: string; planKey: unknown },
  deps: PaymentDeps,
  now?: Date,
): Promise<ActionResult<{ kind: PlanChangeKind }>> {
  if (!isPlanKey(input.planKey)) return fail("INVALID_INPUT");
  const target = input.planKey;
  const row = await prisma.subscription.findUnique({
    where: { workspaceId: input.workspaceId },
  });
  if (
    !row?.stripeSubscriptionId ||
    (row.status !== "ACTIVE" && row.status !== "PAST_DUE") ||
    !isPlanKey(row.planKey) ||
    !isBillingInterval(row.interval)
  ) {
    return fail("NO_SUBSCRIPTION");
  }
  if (row.status === "PAST_DUE") return fail("PAYMENT_PROBLEM");
  const entitled = { planKey: row.planKey, interval: row.interval };

  try {
    const current = await deps.gateway.getSubscription(
      row.stripeSubscriptionId,
    );
    if (!current || current.status !== "active" || !current.itemId) {
      return fail("NO_SUBSCRIPTION");
    }

    if (
      current.planKey !== entitled.planKey ||
      current.interval !== entitled.interval
    ) {
      const reverted = await deps.gateway.changeSubscriptionPlan({
        subscriptionId: current.id,
        itemId: current.itemId,
        planKey: entitled.planKey,
        interval: entitled.interval,
        proration: "none",
      });
      await syncSubscriptionState({
        workspaceId: input.workspaceId,
        sub: reverted,
        now,
      });
    }
    if (target === entitled.planKey) return { ok: true, kind: "unchanged" };

    const upgrade = isUpgrade(entitled, {
      planKey: target,
      interval: entitled.interval,
    });
    const updated = await deps.gateway.changeSubscriptionPlan({
      subscriptionId: current.id,
      itemId: current.itemId,
      planKey: target,
      interval: entitled.interval,
      proration: upgrade ? "always_invoice" : "none",
    });
    const synced = await syncSubscriptionState({
      workspaceId: input.workspaceId,
      sub: updated,
      now,
    });
    if (!upgrade) return { ok: true, kind: "downgrade-scheduled" };
    return {
      ok: true,
      kind:
        synced.applied && synced.notes.includes("upgraded")
          ? "upgraded"
          : "upgrade-processing",
    };
  } catch (error) {
    return fail(describeProviderError(error));
  }
}

// -- Checkout dönüşü ve fatura listesi --------------------------------------------

const SESSION_ID = /^cs_(?:test|live)_[A-Za-z0-9]{8,}$/;

export type ReturnState = "active" | "pending" | "unknown";

// Kullanıcı Checkout'tan dönünce webhook'u BEKLEMEDEN durumu eşitler (aynı işleyici:
// tekrar teslim zararsız). Oturum bu workspace'in müşterisine ait değilse hiçbir şey
// yapılmaz.
export async function reconcileCheckoutReturn(
  input: { workspaceId: string; sessionId: unknown },
  deps: PaymentDeps,
  now?: Date,
): Promise<ReturnState> {
  if (
    typeof input.sessionId !== "string" ||
    !SESSION_ID.test(input.sessionId)
  ) {
    return "unknown";
  }
  try {
    const session = await deps.gateway.getCheckoutSession(input.sessionId);
    if (!session) return "unknown";
    const link = await prisma.billingCustomer.findUnique({
      where: {
        workspaceId_livemode: {
          workspaceId: input.workspaceId,
          livemode: deps.mode === "live",
        },
      },
    });
    if (!link || session.customerId !== link.stripeCustomerId) return "unknown";
    const outcome = await handleCheckoutSession(session.id, {
      gateway: deps.gateway,
      mode: deps.mode,
      now,
    });
    return outcome.status === "PROCESSED" ? "active" : "pending";
  } catch (error) {
    console.error(
      "[billing] could not reconcile a checkout return:",
      error instanceof Error ? error.name : error,
    );
    return "unknown";
  }
}

export async function listWorkspaceInvoices(
  input: { workspaceId: string },
  deps: PaymentDeps,
): Promise<StripeInvoiceRow[]> {
  const link = await prisma.billingCustomer.findUnique({
    where: {
      workspaceId_livemode: {
        workspaceId: input.workspaceId,
        livemode: deps.mode === "live",
      },
    },
  });
  if (!link) return [];
  try {
    return await deps.gateway.listInvoices(link.stripeCustomerId, 12);
  } catch (error) {
    describeProviderError(error);
    return [];
  }
}
