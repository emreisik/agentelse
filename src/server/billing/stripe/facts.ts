import { z } from "zod";

import type { PlanKey } from "@/lib/billing/plans";

import {
  intervalFromStripe,
  planKeyFromProductId,
  type BillingInterval,
} from "./catalog";

// Stripe nesnelerinin YALNIZ işimize yarayan alanları, normalleştirilmiş hâlde.
// Ayrıştırma toleranslıdır (bilinmeyen alanlar atılır, kimlik alanları dize ya da
// genişletilmiş nesne olabilir) ama GEREKLİ alan yoksa StripeShapeError fırlatır:
// olay FAILED olur ve Stripe yeniden dener; sessizce yanlış yazmaktan iyidir.

export class StripeShapeError extends Error {
  constructor(object: string, detail: string) {
    super(`unexpected Stripe ${object} shape: ${detail}`);
    this.name = "StripeShapeError";
  }
}

const idOrObject = z
  .union([z.string(), z.object({ id: z.string() })])
  .transform((value) => (typeof value === "string" ? value : value.id));

const seconds = z.number().nullable().optional();

function toDate(value: number | null | undefined): Date | null {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value * 1000)
    : null;
}

function parse<T>(object: string, schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new StripeShapeError(
      object,
      `${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "invalid"}`,
    );
  }
  return result.data;
}

const metadataSchema = z.record(z.string(), z.string()).default({});

// ---------------------------------------------------------------------------
// Subscription

export type StripeSubscriptionFacts = {
  id: string;
  customerId: string;
  // incomplete | incomplete_expired | trialing | active | past_due | canceled | unpaid | paused
  status: string;
  cancelAtPeriodEnd: boolean;
  cancelAt: Date | null;
  // Aboneliğin başladığı an: kota pencerelerinin çapası (Stripe dönem sınırlarıyla
  // aynı aylık takvim).
  startDate: Date | null;
  currentPeriodEnd: Date | null;
  endedAt: Date | null;
  // cancellation_requested | payment_failed | payment_disputed
  cancellationReason: string | null;
  livemode: boolean;
  metadata: Record<string, string>;
  itemId: string | null;
  productId: string | null;
  planKey: PlanKey | null;
  interval: BillingInterval | null;
  latestInvoice: {
    id: string;
    status: string | null;
    billingReason: string | null;
  } | null;
  // Bu görüntünün Stripe'tan okunmaya BAŞLANDIĞI an. Kilitten önce okunmuş eski bir
  // görüntü, sonradan uygulanmış yenisini ezmesin diye durum makinesi bununla karşılaştırır.
  fetchedAt: Date;
};

const subscriptionSchema = z.object({
  id: z.string(),
  customer: idOrObject,
  status: z.string(),
  cancel_at_period_end: z.boolean().default(false),
  cancel_at: seconds,
  start_date: seconds,
  current_period_end: seconds,
  ended_at: seconds,
  livemode: z.boolean().default(false),
  metadata: metadataSchema,
  items: z
    .object({
      data: z.array(
        z.object({
          id: z.string(),
          price: z
            .object({
              product: idOrObject.nullable().optional(),
              recurring: z
                .object({ interval: z.string().nullable().optional() })
                .nullable()
                .optional(),
            })
            .nullable()
            .optional(),
        }),
      ),
    })
    .optional(),
  latest_invoice: z
    .union([
      z.string(),
      z.object({
        id: z.string(),
        status: z.string().nullable().optional(),
        billing_reason: z.string().nullable().optional(),
      }),
    ])
    .nullable()
    .optional(),
  cancellation_details: z
    .object({ reason: z.string().nullable().optional() })
    .nullable()
    .optional(),
});

export function parseSubscription(
  raw: unknown,
  fetchedAt: Date = new Date(),
): StripeSubscriptionFacts {
  const sub = parse("subscription", subscriptionSchema, raw);
  const item = sub.items?.data[0] ?? null;
  const productId = item?.price?.product ?? null;
  const latest = sub.latest_invoice;
  return {
    id: sub.id,
    customerId: sub.customer,
    status: sub.status,
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    cancelAt: toDate(sub.cancel_at),
    startDate: toDate(sub.start_date),
    currentPeriodEnd: toDate(sub.current_period_end),
    endedAt: toDate(sub.ended_at),
    cancellationReason: sub.cancellation_details?.reason ?? null,
    livemode: sub.livemode,
    metadata: sub.metadata,
    itemId: item?.id ?? null,
    productId,
    planKey: planKeyFromProductId(productId),
    interval: intervalFromStripe(item?.price?.recurring?.interval),
    latestInvoice:
      typeof latest === "string"
        ? { id: latest, status: null, billingReason: null }
        : latest
          ? {
              id: latest.id,
              status: latest.status ?? null,
              billingReason: latest.billing_reason ?? null,
            }
          : null,
    fetchedAt,
  };
}

// Bir müşterinin abonelik listesi (Stripe list yanıtı: { data: [...] }).
export function parseSubscriptionList(
  raw: unknown,
  fetchedAt: Date = new Date(),
): StripeSubscriptionFacts[] {
  const list = parse(
    "subscription list",
    z.object({ data: z.array(z.unknown()) }),
    raw,
  );
  return list.data.map((item) => parseSubscription(item, fetchedAt));
}

// ---------------------------------------------------------------------------
// Invoice

export type StripeInvoiceFacts = {
  id: string;
  customerId: string | null;
  subscriptionId: string | null;
  // draft | open | paid | uncollectible | void
  status: string | null;
  // subscription_create | subscription_cycle | subscription_update | manual | …
  billingReason: string | null;
  amountPaid: number;
  currency: string | null;
  livemode: boolean;
  // Orantı DIŞI abonelik satırlarının dönemi (ödenmiş süreyi bu belirler). Yalnız
  // orantı satırı olan faturada (plan değişikliği) null.
  periodStart: Date | null;
  periodEnd: Date | null;
  hasProration: boolean;
  chargeId: string | null;
  paymentIntentId: string | null;
  paidAt: Date | null;
};

const invoiceSchema = z.object({
  id: z.string(),
  customer: idOrObject.nullable().optional(),
  subscription: idOrObject.nullable().optional(),
  parent: z
    .object({
      subscription_details: z
        .object({ subscription: idOrObject.nullable().optional() })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
  status: z.string().nullable().optional(),
  billing_reason: z.string().nullable().optional(),
  amount_paid: z.number().default(0),
  currency: z.string().nullable().optional(),
  livemode: z.boolean().default(false),
  charge: idOrObject.nullable().optional(),
  payment_intent: idOrObject.nullable().optional(),
  status_transitions: z.object({ paid_at: seconds }).nullable().optional(),
  lines: z
    .object({
      data: z.array(
        z.object({
          type: z.string().nullable().optional(),
          proration: z.boolean().nullable().optional(),
          period: z
            .object({ start: z.number(), end: z.number() })
            .nullable()
            .optional(),
        }),
      ),
    })
    .optional(),
});

export function parseInvoice(raw: unknown): StripeInvoiceFacts {
  const invoice = parse("invoice", invoiceSchema, raw);
  const lines = invoice.lines?.data ?? [];
  const regular = lines.filter(
    (line) =>
      line.proration !== true &&
      line.period &&
      (line.type == null || line.type === "subscription"),
  );
  const starts = regular.map((line) => line.period!.start);
  const ends = regular.map((line) => line.period!.end);
  return {
    id: invoice.id,
    customerId: invoice.customer ?? null,
    subscriptionId:
      invoice.subscription ??
      invoice.parent?.subscription_details?.subscription ??
      null,
    status: invoice.status ?? null,
    billingReason: invoice.billing_reason ?? null,
    amountPaid: invoice.amount_paid,
    currency: invoice.currency ?? null,
    livemode: invoice.livemode,
    periodStart: starts.length ? toDate(Math.min(...starts)) : null,
    periodEnd: ends.length ? toDate(Math.max(...ends)) : null,
    hasProration: lines.some((line) => line.proration === true),
    chargeId: invoice.charge ?? null,
    paymentIntentId: invoice.payment_intent ?? null,
    paidAt: toDate(invoice.status_transitions?.paid_at),
  };
}

// ---------------------------------------------------------------------------
// Checkout Session

export type StripeSessionFacts = {
  id: string;
  // subscription | payment | setup
  mode: string;
  // paid | unpaid | no_payment_required
  paymentStatus: string;
  // open | complete | expired
  status: string | null;
  customerId: string | null;
  subscriptionId: string | null;
  paymentIntentId: string | null;
  clientReferenceId: string | null;
  metadata: Record<string, string>;
  amountTotal: number | null;
  currency: string | null;
  livemode: boolean;
};

const sessionSchema = z.object({
  id: z.string(),
  mode: z.string(),
  payment_status: z.string().default("unpaid"),
  status: z.string().nullable().optional(),
  customer: idOrObject.nullable().optional(),
  subscription: idOrObject.nullable().optional(),
  payment_intent: idOrObject.nullable().optional(),
  client_reference_id: z.string().nullable().optional(),
  metadata: metadataSchema,
  amount_total: z.number().nullable().optional(),
  currency: z.string().nullable().optional(),
  livemode: z.boolean().default(false),
});

export function parseCheckoutSession(raw: unknown): StripeSessionFacts {
  const session = parse("checkout session", sessionSchema, raw);
  return {
    id: session.id,
    mode: session.mode,
    paymentStatus: session.payment_status,
    status: session.status ?? null,
    customerId: session.customer ?? null,
    subscriptionId: session.subscription ?? null,
    paymentIntentId: session.payment_intent ?? null,
    clientReferenceId: session.client_reference_id ?? null,
    metadata: session.metadata,
    amountTotal: session.amount_total ?? null,
    currency: session.currency ?? null,
    livemode: session.livemode,
  };
}

// ---------------------------------------------------------------------------
// Charge / PaymentIntent / Dispute

export type StripeChargeFacts = {
  id: string;
  amount: number;
  amountRefunded: number;
  refunded: boolean;
  customerId: string | null;
  invoiceId: string | null;
  paymentIntentId: string | null;
  livemode: boolean;
};

const chargeSchema = z.object({
  id: z.string(),
  amount: z.number(),
  amount_refunded: z.number().default(0),
  refunded: z.boolean().default(false),
  customer: idOrObject.nullable().optional(),
  invoice: idOrObject.nullable().optional(),
  payment_intent: idOrObject.nullable().optional(),
  livemode: z.boolean().default(false),
});

export function parseCharge(raw: unknown): StripeChargeFacts {
  const charge = parse("charge", chargeSchema, raw);
  return {
    id: charge.id,
    amount: charge.amount,
    amountRefunded: charge.amount_refunded,
    refunded: charge.refunded,
    customerId: charge.customer ?? null,
    invoiceId: charge.invoice ?? null,
    paymentIntentId: charge.payment_intent ?? null,
    livemode: charge.livemode,
  };
}

export type StripePaymentIntentFacts = {
  id: string;
  customerId: string | null;
  metadata: Record<string, string>;
  latestChargeId: string | null;
  livemode: boolean;
};

const paymentIntentSchema = z.object({
  id: z.string(),
  customer: idOrObject.nullable().optional(),
  metadata: metadataSchema,
  latest_charge: idOrObject.nullable().optional(),
  livemode: z.boolean().default(false),
});

export function parsePaymentIntent(raw: unknown): StripePaymentIntentFacts {
  const intent = parse("payment intent", paymentIntentSchema, raw);
  return {
    id: intent.id,
    customerId: intent.customer ?? null,
    metadata: intent.metadata,
    latestChargeId: intent.latest_charge ?? null,
    livemode: intent.livemode,
  };
}

export type StripeDisputeFacts = {
  id: string;
  chargeId: string | null;
  // needs_response | under_review | won | lost | …
  status: string | null;
  livemode: boolean;
};

const disputeSchema = z.object({
  id: z.string(),
  charge: idOrObject.nullable().optional(),
  status: z.string().nullable().optional(),
  livemode: z.boolean().default(false),
});

export function parseDispute(raw: unknown): StripeDisputeFacts {
  const dispute = parse("dispute", disputeSchema, raw);
  return {
    id: dispute.id,
    chargeId: dispute.charge ?? null,
    status: dispute.status ?? null,
    livemode: dispute.livemode,
  };
}

// ---------------------------------------------------------------------------
// Olay zarfı

export type StripeEventEnvelope = {
  id: string;
  type: string;
  livemode: boolean;
  // data.object.id (olayın baktığı nesne); bazı olaylarda yok.
  objectId: string | null;
  // data.object.object ("subscription", "invoice", …)
  objectType: string | null;
};

const eventSchema = z.object({
  id: z.string().regex(/^evt_[A-Za-z0-9_]{4,}$/),
  type: z.string().min(1).max(120),
  livemode: z.boolean().default(false),
  data: z.object({
    object: z
      .object({
        id: z.string().nullable().optional(),
        object: z.string().nullable().optional(),
      })
      .nullable()
      .optional(),
  }),
});

export function parseEventEnvelope(raw: unknown): StripeEventEnvelope {
  const event = parse("event", eventSchema, raw);
  const object = event.data.object;
  return {
    id: event.id,
    type: event.type,
    livemode: event.livemode,
    objectId: object?.id ?? null,
    objectType: object?.object ?? null,
  };
}

// ---------------------------------------------------------------------------
// Promosyon kodu (Stripe Promotion Code) ve kuponu

export type StripeCouponFacts = {
  id: string;
  valid: boolean;
  percentOff: number | null;
  amountOff: number | null;
  currency: string | null;
  // once | repeating | forever
  duration: string;
  durationInMonths: number | null;
  redeemBy: Date | null;
};

const couponSchema = z.object({
  id: z.string(),
  valid: z.boolean().default(true),
  percent_off: z.number().nullable().optional(),
  amount_off: z.number().nullable().optional(),
  currency: z.string().nullable().optional(),
  duration: z.string().default("once"),
  duration_in_months: z.number().nullable().optional(),
  redeem_by: seconds,
});

function couponFacts(coupon: z.infer<typeof couponSchema>): StripeCouponFacts {
  return {
    id: coupon.id,
    valid: coupon.valid,
    percentOff: coupon.percent_off ?? null,
    amountOff: coupon.amount_off ?? null,
    currency: coupon.currency ?? null,
    duration: coupon.duration,
    durationInMonths: coupon.duration_in_months ?? null,
    redeemBy: toDate(coupon.redeem_by),
  };
}

export function parseCoupon(raw: unknown): StripeCouponFacts {
  return couponFacts(parse("coupon", couponSchema, raw));
}

export type StripePromotionFacts = {
  id: string;
  code: string;
  active: boolean;
  expiresAt: Date | null;
  maxRedemptions: number | null;
  timesRedeemed: number;
  firstTimeOnly: boolean;
  minimumAmount: number | null;
  // Yalnız bu müşteri kullanabilir (null: herkes).
  customerId: string | null;
  couponId: string | null;
  // 2024-06-20 şeklinde kupon nesnesi koduyla gelir; daha yeni sürümlerde yalnız kimliği
  // gelir (null): çağıran kuponu ayrıca okur.
  coupon: StripeCouponFacts | null;
};

const promotionCodeSchema = z.object({
  id: z.string(),
  code: z.string(),
  active: z.boolean().default(false),
  expires_at: seconds,
  max_redemptions: z.number().nullable().optional(),
  times_redeemed: z.number().default(0),
  customer: idOrObject.nullable().optional(),
  restrictions: z
    .object({
      first_time_transaction: z.boolean().default(false),
      minimum_amount: z.number().nullable().optional(),
    })
    .nullable()
    .optional(),
  coupon: couponSchema.nullable().optional(),
  promotion: z
    .object({ coupon: idOrObject.nullable().optional() })
    .nullable()
    .optional(),
});

export function parsePromotionCodeList(raw: unknown): StripePromotionFacts[] {
  const list = parse(
    "promotion code list",
    z.object({ data: z.array(promotionCodeSchema) }),
    raw,
  );
  return list.data.map((row) => ({
    id: row.id,
    code: row.code,
    active: row.active,
    expiresAt: toDate(row.expires_at),
    maxRedemptions: row.max_redemptions ?? null,
    timesRedeemed: row.times_redeemed,
    firstTimeOnly: row.restrictions?.first_time_transaction ?? false,
    minimumAmount: row.restrictions?.minimum_amount ?? null,
    customerId: row.customer ?? null,
    couponId: row.coupon?.id ?? row.promotion?.coupon ?? null,
    coupon: row.coupon ? couponFacts(row.coupon) : null,
  }));
}

// ---------------------------------------------------------------------------
// Fatura listesi (ekran): yalnız gösterilecek alanlar.

export type StripeInvoiceRow = {
  id: string;
  number: string | null;
  createdAt: Date | null;
  amountPaid: number;
  // Ödenecek tutar (ödenmemiş faturada gösterilen: amountPaid 0 iken 0 $ yazılmasın).
  amountDue: number;
  currency: string | null;
  status: string | null;
  hostedInvoiceUrl: string | null;
  invoicePdf: string | null;
};

const invoiceRowSchema = z.object({
  id: z.string(),
  number: z.string().nullable().optional(),
  created: seconds,
  amount_paid: z.number().default(0),
  amount_due: z.number().default(0),
  currency: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  hosted_invoice_url: z.string().nullable().optional(),
  invoice_pdf: z.string().nullable().optional(),
});

export function parseInvoiceList(raw: unknown): StripeInvoiceRow[] {
  const list = parse(
    "invoice list",
    z.object({ data: z.array(invoiceRowSchema) }),
    raw,
  );
  return list.data.map((row) => ({
    id: row.id,
    number: row.number ?? null,
    createdAt: toDate(row.created),
    amountPaid: row.amount_paid,
    amountDue: row.amount_due,
    currency: row.currency ?? null,
    status: row.status ?? null,
    hostedInvoiceUrl: row.hosted_invoice_url ?? null,
    invoicePdf: row.invoice_pdf ?? null,
  }));
}

// Checkout / portal yanıtında yalnız yönlendirme adresi gerekir.
export function parseRedirect(
  object: string,
  raw: unknown,
): { id: string; url: string } {
  const parsed = parse(
    object,
    z.object({ id: z.string(), url: z.string().url() }),
    raw,
  );
  return { id: parsed.id, url: parsed.url };
}

export function parseId(object: string, raw: unknown): string {
  return parse(object, z.object({ id: z.string() }), raw).id;
}
