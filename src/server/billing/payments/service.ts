import "server-only";

import { prisma } from "@/lib/prisma";
import { paidPlanRunning } from "@/lib/billing/entitlements-core";
import { linkedForMode } from "@/lib/billing/linkage";
import {
  EXTRA_PACKS,
  PLANS,
  isPlanKey,
  type ExtraPackKey,
  type PlanKey,
} from "@/lib/billing/plans";

import { formatUsd } from "@/lib/billing/catalog";

import {
  isBillingInterval,
  isUpgrade,
  planUnitAmountCents,
  type BillingInterval,
} from "../stripe/catalog";
import { StripeApiError, StripeNetworkError } from "../stripe/client";
import type { StripeMode } from "../stripe/config";
import {
  StripeShapeError,
  type StripeInvoiceRow,
  type StripePromotionFacts,
} from "../stripe/facts";
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
  | "PROMO_INVALID"
  | "PAYMENT_PROBLEM"
  | "CARD_DECLINED"
  | "INVALID_INPUT"
  | "PROVIDER_ERROR"
  // Muaf (kalıcı tam erişimli) workspace: satın alınacak bir şey yok.
  | "FULL_ACCESS"
  // Ödeme sağlayıcısı tarafında SAHİBİN düzeltmesi gereken bir sorun (anahtar, hesap
  // etkinleştirme, portal ayarı): müşteri "tekrar dene" denilerek oyalanmaz.
  | "BILLING_UNAVAILABLE"
  // Dönem sonunda iptal zamanlanmış abonelikte plan değişmez.
  | "SUBSCRIPTION_ENDING"
  // Faturalama aralığı Stripe'ta uygulama dışından değiştirilmiş.
  | "BILLING_CHANGED_OUTSIDE"
  // Ödenmemiş / henüz uygulanmamış bir yükseltme sürüyor.
  | "CHANGE_IN_PROGRESS"
  // Stripe'a gönderilen değişikliğin sonucu doğrulanamadı.
  | "OUTCOME_UNKNOWN";

export type ActionResult<T extends object = object> =
  | ({ ok: true } & T)
  | { ok: false; error: BillingActionError; message: string };

const MESSAGES: Record<BillingActionError, string> = {
  FORBIDDEN: "Only a workspace owner or admin can change billing.",
  PAYMENTS_CLOSED: "Payments are not open yet.",
  RATE_LIMITED: "Too many attempts. Wait a few minutes and try again.",
  ALREADY_SUBSCRIBED:
    "This workspace already has an active subscription. Change the plan or resume it in My subscription.",
  NO_SUBSCRIPTION: "There is no active subscription to change.",
  NO_CUSTOMER: "No billing profile exists yet. Subscribe to a plan first.",
  PLAN_REQUIRED: "Extra packs are available while you have a plan.",
  DISCOUNT_NOT_AVAILABLE:
    "The first-month discount is only available on a first monthly subscription.",
  PROMO_INVALID: "That code is not valid or has expired.",
  PAYMENT_PROBLEM:
    "The last payment did not go through. Update the payment method in My subscription first.",
  CARD_DECLINED:
    "The card was declined or needs extra verification, so nothing was charged and your plan stays as it was. Try another card with Payment method in My subscription.",
  INVALID_INPUT: "That choice is not valid.",
  PROVIDER_ERROR:
    "The payment provider could not complete this just now. Nothing was charged. Try again in a moment.",
  FULL_ACCESS: "This workspace has full access, so there is nothing to buy.",
  BILLING_UNAVAILABLE:
    "Billing is temporarily unavailable. We have been notified. Please try again later.",
  SUBSCRIPTION_ENDING:
    "This subscription is set to end. Resume it in My subscription, then change the plan.",
  BILLING_CHANGED_OUTSIDE:
    "The billing period of this subscription was changed outside the app, so the plan cannot be changed here. Please contact support.",
  CHANGE_IN_PROGRESS:
    "A plan change is still being processed. Check My subscription in a minute.",
  OUTCOME_UNKNOWN:
    "We could not confirm this change with the payment provider. Check My subscription in a minute before trying again.",
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
// Müşterinin kendi başına çözebileceği ödeme sorunları (kart reddi, banka doğrulaması):
// Stripe hata türü card_error olmasa da (ör. error_if_incomplete → 402) bu sınıftadır.
const CUSTOMER_ACTION_CODES = new Set([
  "card_declined",
  "authentication_required",
  "invoice_payment_intent_requires_action",
  "subscription_payment_intent_requires_action",
  "payment_intent_action_required",
  "payment_intent_authentication_failure",
  "payment_method_unactivated",
]);

// Müşterinin çözemeyeceği, SAHİBİN düzeltmesi gereken sorunlar: geçersiz/süresi dolmuş anahtar,
// canlı hesabın etkinleştirilmemesi, kaydedilmemiş portal ayarı.
function needsOperator(error: StripeApiError): boolean {
  return (
    error.status === 401 ||
    error.status === 403 ||
    error.code === "api_key_expired" ||
    error.code === "platform_api_key_expired" ||
    error.code === "testmode_charges_only" ||
    /billing portal|default configuration|configuration provided/i.test(
      error.message,
    )
  );
}

export function describeProviderError(error: unknown): BillingActionError {
  if (error instanceof StripeApiError) {
    // Stripe's own message (never shown to the customer) tells the operator what to fix,
    // e.g. "no billing portal configuration"; it carries no card or key data.
    console.error(
      `[billing] Stripe error status=${error.status} code=${error.code ?? "-"} type=${error.type ?? "-"} request=${error.requestId ?? "-"}: ${error.message.slice(0, 240)}`,
    );
    if (needsOperator(error)) {
      console.error(
        `[billing][operator-action] Stripe refuses our requests until the owner fixes the Stripe setup (key, account activation or Customer portal settings): ${error.message.slice(0, 160)}`,
      );
      return "BILLING_UNAVAILABLE";
    }
    if (
      error.type === "card_error" ||
      error.status === 402 ||
      (error.code !== null && CUSTOMER_ACTION_CODES.has(error.code))
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

// Stripe'a gönderilen bir DEĞİŞİKLİĞİN sonucu bilinmiyor mu? Ağ hatası, bozuk yanıt ve 5xx
// değişikliğin uygulanmış olabileceği anlamına gelir (4xx kesin reddir). Bu durumda
// "hiçbir şey değişmedi / tahsil edilmedi" denemez: durum yeniden okunur ve dürüst mesaj verilir.
export function isAmbiguousProviderError(error: unknown): boolean {
  return (
    error instanceof StripeNetworkError ||
    error instanceof StripeShapeError ||
    (error instanceof StripeApiError && error.status >= 500)
  );
}

class OutcomeUnknownError extends Error {
  constructor() {
    super("billing change outcome unknown");
    this.name = "OutcomeUnknownError";
  }
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

// -- Promosyon kodu -----------------------------------------------------------------
// Kodlar Stripe'ta (Dashboard > Product catalog > Coupons > Promotion codes) sahip
// tarafından yaratılır; Stripe kullanım sınırını Checkout'ta kendisi uygular. Burada yalnız
// "bu kod geçerli mi, ne veriyor" ön denetimi ve Checkout'a kod kimliğinin verilmesi vardır.
// Kod YALNIZ fiyatı etkiler: kota ve ilk ay kota çarpanı değişmez (kod = tam kota).

export const PROMO_CODE_PATTERN = /^[A-Za-z0-9-]{3,40}$/;

export function describePromotion(promotion: StripePromotionFacts): string {
  const coupon = promotion.coupon;
  const percent = coupon?.percentOff;
  const what =
    percent !== null && percent !== undefined
      ? `${Number.isInteger(percent) ? percent : percent.toFixed(1)}% off`
      : coupon?.amountOff && coupon.currency === "usd"
        ? `${formatUsd(coupon.amountOff)} off`
        : "A discount";
  if (coupon?.duration === "forever") return `${what} every payment`;
  if (coupon?.duration === "repeating" && coupon.durationInMonths) {
    const months = coupon.durationInMonths;
    return `${what} for ${months} ${months === 1 ? "month" : "months"}`;
  }
  return `${what} your first payment`;
}

function promotionUsable(
  promotion: StripePromotionFacts,
  context: { now: Date; customerId: string | null; amountCents?: number },
): boolean {
  const { coupon } = promotion;
  if (!promotion.active || !coupon || !coupon.valid) return false;
  if (
    promotion.expiresAt &&
    promotion.expiresAt.getTime() <= context.now.getTime()
  ) {
    return false;
  }
  if (coupon.redeemBy && coupon.redeemBy.getTime() <= context.now.getTime()) {
    return false;
  }
  if (
    promotion.maxRedemptions !== null &&
    promotion.timesRedeemed >= promotion.maxRedemptions
  ) {
    return false;
  }
  // Belirli bir müşteriye bağlı kod başkasında çalışmaz (nedeni söylenmez).
  if (promotion.customerId && promotion.customerId !== context.customerId) {
    return false;
  }
  if (
    promotion.minimumAmount !== null &&
    context.amountCents !== undefined &&
    context.amountCents < promotion.minimumAmount
  ) {
    return false;
  }
  return true;
}

async function resolvePromotion(
  input: { workspaceId: string; code: unknown; amountCents?: number },
  deps: PaymentDeps,
  now: Date,
): Promise<
  | { ok: true; promotion: StripePromotionFacts }
  | { ok: false; error: BillingActionError; message: string }
> {
  if (
    typeof input.code !== "string" ||
    !PROMO_CODE_PATTERN.test(input.code.trim())
  ) {
    return fail("PROMO_INVALID");
  }
  const link = await prisma.billingCustomer.findUnique({
    where: {
      workspaceId_livemode: {
        workspaceId: input.workspaceId,
        livemode: deps.mode === "live",
      },
    },
    select: { stripeCustomerId: true },
  });
  try {
    const promotion = await deps.gateway.lookupPromotionCode(input.code.trim());
    if (
      !promotion ||
      !promotionUsable(promotion, {
        now,
        customerId: link?.stripeCustomerId ?? null,
        amountCents: input.amountCents,
      })
    ) {
      return fail("PROMO_INVALID");
    }
    return { ok: true, promotion };
  } catch (error) {
    return fail(describeProviderError(error));
  }
}

export async function checkPromoCode(
  input: { workspaceId: string; code: unknown },
  deps: PaymentDeps,
  now: Date = new Date(),
): Promise<ActionResult<{ code: string; description: string }>> {
  const resolved = await resolvePromotion(input, deps, now);
  if (!resolved.ok) return resolved;
  return {
    ok: true,
    code: resolved.promotion.code,
    description: describePromotion(resolved.promotion),
  };
}

// -- Checkout ---------------------------------------------------------------------

export async function startSubscriptionCheckout(
  input: {
    workspaceId: string;
    email?: string | null;
    name?: string | null;
    planKey: unknown;
    interval: unknown;
    applyFirstMonth: boolean;
    // Müşterinin girdiği promosyon kodu (isteğe bağlı). İlk ay indirimiyle birlikte
    // kullanılamaz: kod ilk ay indiriminin YERİNE geçer.
    promoCode?: unknown;
  },
  deps: PaymentDeps,
  now: Date = new Date(),
): Promise<ActionResult<{ url: string }>> {
  if (!isPlanKey(input.planKey) || !isBillingInterval(input.interval)) {
    return fail("INVALID_INPUT");
  }
  const { planKey, interval } = input;
  const row = await prisma.subscription.findUnique({
    where: { workspaceId: input.workspaceId },
  });
  // Kalıcı tam erişimli (muaf) workspace'e satılacak bir şey yok.
  if (row?.exempt) return fail("FULL_ACCESS");
  // Canlı bir abonelik hâlâ sürerken TEST anahtarıyla yeni abonelik açılmaz (canlı satırı
  // bozardı); tersi serbest: canlı ödeme eski test bağını değiştirir.
  if (
    deps.mode === "test" &&
    row?.stripeLivemode === true &&
    row.stripeSubscriptionId &&
    paidPlanRunning(row, now)
  ) {
    return fail("ALREADY_SUBSCRIBED");
  }
  // Ödeme süren abonelik varken ikinci abonelik açılmaz (çift tahsilat). Yerel kayıt "ödüyor"
  // dese de Stripe'a sorulur: kaçırılmış bir iptal olayı yeniden abone olmayı kilitlemesin.
  if (
    row &&
    linkedForMode(row, deps.mode) &&
    (row.status === "ACTIVE" || row.status === "PAST_DUE") &&
    (await stillPaying(row, deps, now))
  ) {
    return fail(
      row.status === "PAST_DUE" ? "PAYMENT_PROBLEM" : "ALREADY_SUBSCRIBED",
    );
  }
  // Webhook kaçmış / alıcı geri dönmemiş olabilir: Stripe bu müşterinin ZATEN süren bir
  // aboneliğini tutuyorsa ikinci bir Checkout çift tahsilat olurdu. Ödenmişse ayrıca bağlanır.
  try {
    const running = await runningStripeSubscription(
      input.workspaceId,
      deps,
      now,
    );
    if (running) {
      return fail(
        running === "failing" ? "PAYMENT_PROBLEM" : "ALREADY_SUBSCRIBED",
      );
    }
  } catch (error) {
    return fail(describeProviderError(error));
  }
  const hasPromo =
    input.promoCode !== undefined &&
    input.promoCode !== null &&
    input.promoCode !== "";
  if (hasPromo && input.applyFirstMonth) return fail("INVALID_INPUT");
  const eligible = firstMonthEligible(row, planKey, interval);
  if (input.applyFirstMonth && !eligible) return fail("DISCOUNT_NOT_AVAILABLE");

  // Kod geçersizse Stripe'a müşteri bile açılmaz (yazım hatası kayıt bırakmasın).
  let promotionCodeId: string | undefined;
  if (hasPromo) {
    const resolved = await resolvePromotion(
      {
        workspaceId: input.workspaceId,
        code: input.promoCode,
        amountCents: planUnitAmountCents(planKey, interval),
      },
      deps,
      now,
    );
    if (!resolved.ok) return resolved;
    promotionCodeId = resolved.promotion.id;
  }

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
        promotionCodeId,
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
  if (row?.exempt) return fail("FULL_ACCESS");
  // Ek paket yalnız ÇALIŞAN anahtarın modunda ödenmiş ve hâlâ SÜREN bir planla alınır:
  // erişimi bitmiş (ek süresi dolmuş) bir planın paketi harcanamazdı.
  if (!row || !linkedForMode(row, deps.mode) || !paidPlanRunning(row, now)) {
    return fail("PLAN_REQUIRED");
  }

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

// Çalışan anahtarın modundaki, ödeme süren (ACTIVE / PAST_DUE) abonelik satırı.
async function loadPayingRow(workspaceId: string, mode: StripeMode) {
  const row = await prisma.subscription.findUnique({ where: { workspaceId } });
  if (
    !row ||
    !linkedForMode(row, mode) ||
    (row.status !== "ACTIVE" && row.status !== "PAST_DUE")
  ) {
    return null;
  }
  return row as typeof row & { stripeSubscriptionId: string };
}

// Yerel kayıt "ödüyor" diyor; abonelik Stripe'ta gerçekten sürüyor mu? Bitmişse satır
// eşitlenir (CANCELED) ve yeniden abone olunabilir. Doğrulanamazsa çift tahsilat riskine
// karşı "sürüyor" sayılır.
async function stillPaying(
  row: {
    workspaceId: string;
    stripeSubscriptionId: string | null;
    planKey: string | null;
    status: string;
    paidThrough: Date | null;
    graceUntil: Date | null;
    cancelAtPeriodEnd: boolean;
  },
  deps: PaymentDeps,
  now: Date,
): Promise<boolean> {
  try {
    const sub = await deps.gateway.getSubscription(row.stripeSubscriptionId!);
    // Stripe nesneyi tanımıyor (ör. test verisi silinmiş): ödenmiş süre bittiyse engelleme.
    if (!sub) return paidPlanRunning(row, now);
    await syncSubscriptionState({ workspaceId: row.workspaceId, sub, now });
    return sub.status !== "canceled" && sub.status !== "incomplete_expired";
  } catch (error) {
    console.error(
      "[billing] could not verify the subscription before checkout:",
      error instanceof Error ? error.name : error,
    );
    return true;
  }
}

// Bu workspace'in Stripe müşterisi zaten süren (ya da ödemesi başarısız) bir aboneliğe sahip
// mi? "running": evet (ödenmişse yerel satıra da bağlanır: kaçmış olay kendiliğinden
// onarılır); "failing": ödeme sorunlu; null: hayır ya da henüz müşteri yok. Stripe okunamazsa
// hata fırlatır (çift tahsilat riskine karşı satın alma ilerlemez).
async function runningStripeSubscription(
  workspaceId: string,
  deps: PaymentDeps,
  now: Date,
): Promise<"running" | "failing" | null> {
  const link = await prisma.billingCustomer.findUnique({
    where: {
      workspaceId_livemode: { workspaceId, livemode: deps.mode === "live" },
    },
  });
  if (!link) return null;
  const subs = await deps.gateway.listSubscriptions(link.stripeCustomerId);
  const alive = subs.find(
    (sub) => sub.status === "active" || sub.status === "trialing",
  );
  if (alive) {
    if (alive.latestInvoice?.status === "paid") {
      const invoice = await deps.gateway.getInvoice(alive.latestInvoice.id);
      if (invoice?.status === "paid") {
        await syncSubscriptionState({
          workspaceId,
          sub: alive,
          paid: invoice,
          now,
        });
      }
    }
    return "running";
  }
  return subs.some(
    (sub) => sub.status === "past_due" || sub.status === "unpaid",
  )
    ? "failing"
    : null;
}

// Değişiklikten sonra yerel eşitleme: veritabanı hatası değişikliği GERİ ALMAZ (Stripe'ta
// uygulandı); sonuç belirsiz sayılır, kullanıcıya "hiçbir şey değişmedi" denmez.
async function syncAfterMutation(
  workspaceId: string,
  sub: Parameters<typeof syncSubscriptionState>[0]["sub"],
  now?: Date,
) {
  try {
    return await syncSubscriptionState({ workspaceId, sub, now });
  } catch (error) {
    console.error(
      "[billing] could not record a change that Stripe accepted:",
      error instanceof Error ? error.name : error,
    );
    throw new OutcomeUnknownError();
  }
}

// Değişiklik isteği (Stripe'ta uygulanmış OLABİLİR): belirsiz hata → OutcomeUnknownError.
async function mutate<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isAmbiguousProviderError(error)) {
      console.error(
        "[billing] Stripe change with an unknown outcome:",
        error instanceof Error ? error.message.slice(0, 200) : error,
      );
      throw new OutcomeUnknownError();
    }
    throw error;
  }
}

// Bir değişiklik denemesi hatayla bitti. Sonuç belirsizse durum Stripe'tan yeniden okunup
// eşitlenir (uygulandıysa ekran doğruyu gösterir) ve dürüst mesaj verilir.
async function failedChange(
  error: unknown,
  workspaceId: string,
  subscriptionId: string,
  deps: PaymentDeps,
  now?: Date,
) {
  if (error instanceof OutcomeUnknownError) {
    try {
      const fresh = await deps.gateway.getSubscription(subscriptionId);
      if (fresh) await syncSubscriptionState({ workspaceId, sub: fresh, now });
    } catch {
      // Yeniden okuma da olmadı: tick/süpürme sonra eşitler.
    }
    return fail("OUTCOME_UNKNOWN");
  }
  return fail(describeProviderError(error));
}

async function setCancel(
  workspaceId: string,
  cancel: boolean,
  deps: PaymentDeps,
  now?: Date,
): Promise<ActionResult> {
  const row = await loadPayingRow(workspaceId, deps.mode);
  if (!row) return fail("NO_SUBSCRIPTION");
  try {
    const sub = await mutate(() =>
      deps.gateway.setCancelAtPeriodEnd(row.stripeSubscriptionId, cancel),
    );
    await syncAfterMutation(workspaceId, sub, now);
    return { ok: true };
  } catch (error) {
    return failedChange(
      error,
      workspaceId,
      row.stripeSubscriptionId,
      deps,
      now,
    );
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
  | "unchanged"
  | "switch-cancelled"
  | "upgraded"
  | "upgrade-processing"
  | "downgrade-scheduled";

// Aralık (aylık/yıllık) bu ekrandan değişmez; plan değişir. Karar her zaman ÖDENEN (yerel)
// plana göre verilir ve Stripe'ın GÜNCEL hâliyle önce eşitlenir:
//  - Stripe satırdan ÖNDEYSE ve yükseltme ödenmişse (işlenmemiş ödeme) o benimsenir;
//    ödenmemişse hiçbir şey yapılmaz (CHANGE_IN_PROGRESS). Kalemi geri itip yeniden
//    yükseltmek aynı farkı iki kez tahsil ederdi.
//  - Aralık Stripe'ta uygulama dışından değişmişse dokunulmaz: aralık değişimini "bedava"
//    geri itmek Stripe'ta dönemi sıfırlar ve hemen faturalar.
//  - Bekleyen (zamanlanmış) düşürme varken yükseltme, orantının ödenen plandan hesaplanması
//    için kalemi önce ödenen plana çeker (aynı aralık: para hareketi yok); yükseltme
//    reddedilirse zamanlanmış düşürme GERİ konur, kullanıcının seçimi kaybolmaz.
//  - Değişikliğin sonucu belirsizse (ağ/5xx/bozuk yanıt/yerel kayıt hatası) "değişmedi"
//    denmez: durum yeniden okunur ve OUTCOME_UNKNOWN döner.
// Çifte tıklama: ikinci istek Stripe'ta aynı fiyata yükseltme olur (fark yok).
export async function changePlan(
  input: { workspaceId: string; planKey: unknown },
  deps: PaymentDeps,
  now?: Date,
): Promise<ActionResult<{ kind: PlanChangeKind }>> {
  if (!isPlanKey(input.planKey)) return fail("INVALID_INPUT");
  const target = input.planKey;
  const { workspaceId } = input;

  const first = await loadPayingRow(workspaceId, deps.mode);
  if (!first) return fail("NO_SUBSCRIPTION");
  if (first.status === "PAST_DUE") return fail("PAYMENT_PROBLEM");
  if (first.cancelAtPeriodEnd) return fail("SUBSCRIPTION_ENDING");

  try {
    const current = await deps.gateway.getSubscription(
      first.stripeSubscriptionId,
    );
    if (!current || current.status !== "active" || !current.itemId) {
      return fail("NO_SUBSCRIPTION");
    }
    await syncSubscriptionState({ workspaceId, sub: current, now });
    const row = await loadPayingRow(workspaceId, deps.mode);
    if (
      !row ||
      row.stripeSubscriptionId !== current.id ||
      !isPlanKey(row.planKey) ||
      !isBillingInterval(row.interval)
    ) {
      return fail("NO_SUBSCRIPTION");
    }
    if (row.status === "PAST_DUE") return fail("PAYMENT_PROBLEM");
    if (row.cancelAtPeriodEnd) return fail("SUBSCRIPTION_ENDING");
    const entitled = { planKey: row.planKey, interval: row.interval };

    const stripePlan = current.planKey;
    if (!stripePlan || current.interval !== entitled.interval) {
      return fail("BILLING_CHANGED_OUTSIDE");
    }
    if (
      stripePlan !== entitled.planKey &&
      isUpgrade(entitled, { planKey: stripePlan, interval: entitled.interval })
    ) {
      return fail("CHANGE_IN_PROGRESS");
    }
    // Stripe kalemi ödenen plandan düşükse: zamanlanmış düşürme var.
    const scheduled = stripePlan !== entitled.planKey;

    const itemId = current.itemId;
    const setItem = (planKey: PlanKey, proration: "none" | "always_invoice") =>
      mutate(() =>
        deps.gateway.changeSubscriptionPlan({
          subscriptionId: current.id,
          itemId,
          planKey,
          interval: entitled.interval,
          proration,
        }),
      );
    const record = (sub: typeof current) =>
      syncAfterMutation(workspaceId, sub, now);

    if (target === entitled.planKey) {
      if (!scheduled) return { ok: true, kind: "unchanged" };
      await record(await setItem(entitled.planKey, "none"));
      return { ok: true, kind: "switch-cancelled" };
    }

    const upgrade = isUpgrade(entitled, {
      planKey: target,
      interval: entitled.interval,
    });
    if (!upgrade) {
      if (stripePlan !== target) await record(await setItem(target, "none"));
      return { ok: true, kind: "downgrade-scheduled" };
    }

    if (scheduled) await record(await setItem(entitled.planKey, "none"));
    let updated: typeof current;
    try {
      updated = await setItem(target, "always_invoice");
    } catch (error) {
      // Kesin ret (kart vb.): zamanlanmış düşürmeyi geri koy ki "plan değişmedi" doğru
      // kalsın. Sonuç belirsizse dokunulmaz (yükseltme uygulanmış olabilir).
      if (scheduled && !(error instanceof OutcomeUnknownError)) {
        try {
          await record(await setItem(stripePlan, "none"));
        } catch {
          throw new OutcomeUnknownError();
        }
      }
      throw error;
    }
    const synced = await record(updated);
    return {
      ok: true,
      kind:
        synced.applied && synced.notes.includes("upgraded")
          ? "upgraded"
          : "upgrade-processing",
    };
  } catch (error) {
    return failedChange(
      error,
      workspaceId,
      first.stripeSubscriptionId,
      deps,
      now,
    );
  }
}

// -- Checkout dönüşü ve fatura listesi --------------------------------------------

const SESSION_ID = /^cs_(?:test|live)_[A-Za-z0-9]{8,}$/;

// active   : ödeme uygulandı.
// pending  : ödeme henüz işlenmedi (gecikmeli yöntem, olay yolda).
// reversed : bu ödemenin parası iade/itiraz edildi; plan açılmadı.
// unknown  : oturum bu workspace'e ait değil / tanınmadı / okunamadı.
export type ReturnState = "active" | "pending" | "reversed" | "unknown";

// Kullanıcı Checkout'tan dönünce webhook'u BEKLEMEDEN durumu eşitler (aynı işleyici:
// tekrar teslim zararsız). Oturum bu workspace'in müşterisine ait değilse hiçbir şey
// yapılmaz. Workspace'in bu moddaki Stripe müşterisi YOKSA Stripe'a hiç gidilmez: rastgele
// oturum kimlikleriyle Stripe'a okuma yağdırılamaz.
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
    const link = await prisma.billingCustomer.findUnique({
      where: {
        workspaceId_livemode: {
          workspaceId: input.workspaceId,
          livemode: deps.mode === "live",
        },
      },
    });
    if (!link) return "unknown";
    const session = await deps.gateway.getCheckoutSession(input.sessionId);
    if (!session || session.customerId !== link.stripeCustomerId) {
      return "unknown";
    }
    const outcome = await handleCheckoutSession(session.id, {
      gateway: deps.gateway,
      mode: deps.mode,
      now,
    });
    if (outcome.status === "PROCESSED") return "active";
    return outcome.note === "invoice-reversed" ? "reversed" : "pending";
  } catch (error) {
    console.error(
      "[billing] could not reconcile a checkout return:",
      error instanceof Error ? error.name : error,
    );
    return "unknown";
  }
}

// Fatura listesi: taslak ve iptal edilmiş (void) faturalar müşteriye gösterilmez.
// `failed`: Stripe okunamadı (boş liste "fatura yok" ile karışmasın).
export type InvoiceListing = { rows: StripeInvoiceRow[]; failed: boolean };

export async function listWorkspaceInvoices(
  input: { workspaceId: string },
  deps: PaymentDeps,
): Promise<InvoiceListing> {
  const link = await prisma.billingCustomer.findUnique({
    where: {
      workspaceId_livemode: {
        workspaceId: input.workspaceId,
        livemode: deps.mode === "live",
      },
    },
  });
  if (!link) return { rows: [], failed: false };
  try {
    const rows = await deps.gateway.listInvoices(link.stripeCustomerId, 12);
    return {
      rows: rows.filter(
        (row) => row.status !== "draft" && row.status !== "void",
      ),
      failed: false,
    };
  } catch (error) {
    describeProviderError(error);
    return { rows: [], failed: true };
  }
}
