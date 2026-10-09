import "server-only";

import { prisma } from "@/lib/prisma";

import { isExtraPackKey } from "../stripe/catalog";
import type { StripeMode } from "../stripe/config";
import type { StripeEventEnvelope, StripeChargeFacts } from "../stripe/facts";
import type { StripeGateway } from "../stripe/gateway";
import { resolveWorkspaceForCustomer } from "./customers";
import { grantExtraPack, reconcilePackRefund } from "./purchases";
import { endSubscriptionAfterRefund } from "./refunds";
import { syncSubscriptionState } from "./subscription-state";

// Webhook olaylarının işlenmesi: gelen kutusu (BillingEvent) + yönlendirme.
//
// Olay yalnız bir TETİKLEYİCİDİR: işleyici nesneyi Stripe'tan sabit API sürümünde GÜNCEL
// okur (sıra bozuk teslim, eski anlık görüntü ya da uç noktanın farklı API sürümü sonucu
// değiştirmez) ve sonucu monoton/idempotent biçimde uygular. Aynı olay kimliği ikinci
// kez işlenmez; işlenirken hata olursa FAILED yazılır ve hata yukarı fırlatılır (route
// 500 döner, Stripe yeniden dener; işleyiciler tekrara dayanıklıdır).

export type EventDeps = {
  gateway: StripeGateway;
  // Çalışan anahtarın modu: ters moddaki olay işlenmez.
  mode: StripeMode;
  now?: Date;
};

type Outcome = {
  status: "PROCESSED" | "IGNORED";
  workspaceId?: string;
  note?: string;
};

export type ProcessedEvent = {
  result: "processed" | "ignored" | "duplicate";
  note?: string;
};

const LOUD_NOTES = new Set([
  "tenant-mismatch",
  "duplicate-subscription",
  "unknown-plan",
  "no-paid-period",
]);

export async function processStripeEvent(
  event: StripeEventEnvelope,
  deps: EventDeps,
): Promise<ProcessedEvent> {
  const row = await prisma.billingEvent.upsert({
    where: { provider_eventId: { provider: "stripe", eventId: event.id } },
    create: {
      provider: "stripe",
      eventId: event.id,
      type: event.type,
      objectId: event.objectId,
      livemode: event.livemode,
    },
    update: {},
  });
  if (row.status === "PROCESSED" || row.status === "IGNORED") {
    return { result: "duplicate" };
  }

  const finish = async (outcome: Outcome): Promise<ProcessedEvent> => {
    await prisma.billingEvent.update({
      where: { id: row.id },
      data: {
        status: outcome.status,
        workspaceId: outcome.workspaceId ?? null,
        note: outcome.note ?? null,
        processedAt: new Date(),
      },
    });
    if (outcome.note && LOUD_NOTES.has(outcome.note)) {
      console.error(
        `[billing] event ${event.id} (${event.type}) needs a look: ${outcome.note}`,
      );
    }
    return {
      result: outcome.status === "PROCESSED" ? "processed" : "ignored",
      note: outcome.note,
    };
  };

  if (event.livemode !== (deps.mode === "live")) {
    return finish({ status: "IGNORED", note: "livemode-mismatch" });
  }

  await prisma.billingEvent.update({
    where: { id: row.id },
    data: { attempts: { increment: 1 } },
  });
  try {
    return await finish(await dispatch(event, deps));
  } catch (error) {
    const note = `${error instanceof Error ? error.name : "Error"}: ${
      error instanceof Error ? error.message : "unknown"
    }`.slice(0, 300);
    await prisma.billingEvent
      .update({ where: { id: row.id }, data: { status: "FAILED", note } })
      .catch(() => undefined);
    throw error;
  }
}

async function dispatch(
  event: StripeEventEnvelope,
  deps: EventDeps,
): Promise<Outcome> {
  const id = event.objectId;
  if (!id) return { status: "IGNORED", note: "no-object" };
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      return handleCheckoutSession(id, deps);
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      return handleSubscription(id, deps);
    case "invoice.paid":
    case "invoice.payment_succeeded":
      return handleInvoice(id, deps, { paid: true });
    case "invoice.payment_failed":
      return handleInvoice(id, deps, { paid: false });
    case "charge.refunded":
      return handleChargeRefunded(id, deps);
    case "charge.dispute.created":
      return handleDispute(id, deps);
    default:
      return { status: "IGNORED", note: "unhandled-type" };
  }
}

// -- abonelik olayları ----------------------------------------------------------

export async function handleSubscription(
  subscriptionId: string,
  deps: EventDeps,
): Promise<Outcome> {
  const sub = await deps.gateway.getSubscription(subscriptionId);
  if (!sub) return { status: "IGNORED", note: "subscription-missing" };
  const resolved = await resolveWorkspaceForCustomer(
    sub.customerId,
    sub.metadata.workspaceId,
  );
  if (!resolved.ok) return { status: "IGNORED", note: resolved.note };
  const result = await syncSubscriptionState({
    workspaceId: resolved.workspaceId,
    sub,
    now: deps.now,
  });
  return result.applied
    ? { status: "PROCESSED", workspaceId: resolved.workspaceId }
    : {
        status: "IGNORED",
        workspaceId: resolved.workspaceId,
        note: result.note,
      };
}

async function handleInvoice(
  invoiceId: string,
  deps: EventDeps,
  options: { paid: boolean },
): Promise<Outcome> {
  const invoice = await deps.gateway.getInvoice(invoiceId);
  if (!invoice) return { status: "IGNORED", note: "invoice-missing" };
  // Abonelik dışı fatura (ek paket makbuzu): hak Checkout olayıyla verilir.
  if (!invoice.subscriptionId) {
    return { status: "IGNORED", note: "not-a-subscription-invoice" };
  }
  const sub = await deps.gateway.getSubscription(invoice.subscriptionId);
  if (!sub) return { status: "IGNORED", note: "subscription-missing" };
  if (invoice.customerId && invoice.customerId !== sub.customerId) {
    return { status: "IGNORED", note: "tenant-mismatch" };
  }
  const resolved = await resolveWorkspaceForCustomer(
    sub.customerId,
    sub.metadata.workspaceId,
  );
  if (!resolved.ok) return { status: "IGNORED", note: resolved.note };

  // Olay "ödendi" dese de GÜNCEL fatura durumuna bakılır (iptal/void edilmiş olabilir).
  const paid = options.paid && invoice.status === "paid";
  const result = await syncSubscriptionState({
    workspaceId: resolved.workspaceId,
    sub,
    paid: paid ? invoice : null,
    now: deps.now,
  });
  return result.applied
    ? { status: "PROCESSED", workspaceId: resolved.workspaceId }
    : {
        status: "IGNORED",
        workspaceId: resolved.workspaceId,
        note: result.note,
      };
}

// -- Checkout -------------------------------------------------------------------

export async function handleCheckoutSession(
  sessionId: string,
  deps: EventDeps,
): Promise<Outcome> {
  const session = await deps.gateway.getCheckoutSession(sessionId);
  if (!session) return { status: "IGNORED", note: "session-missing" };
  const resolved = await resolveWorkspaceForCustomer(
    session.customerId,
    session.clientReferenceId ?? session.metadata.workspaceId,
  );
  if (!resolved.ok) return { status: "IGNORED", note: resolved.note };
  const { workspaceId } = resolved;
  const settled =
    session.paymentStatus === "paid" ||
    session.paymentStatus === "no_payment_required";

  if (session.mode === "subscription") {
    if (!session.subscriptionId) {
      return { status: "IGNORED", workspaceId, note: "no-subscription" };
    }
    if (!settled) {
      // Gecikmeli ödeme yöntemi: async_payment_succeeded gelince yeniden işlenir.
      return { status: "IGNORED", workspaceId, note: "awaiting-payment" };
    }
    const sub = await deps.gateway.getSubscription(session.subscriptionId);
    if (!sub)
      return { status: "IGNORED", workspaceId, note: "subscription-missing" };
    const latest = sub.latestInvoice;
    if (!latest || latest.status !== "paid") {
      return { status: "IGNORED", workspaceId, note: "invoice-not-paid" };
    }
    const invoice = await deps.gateway.getInvoice(latest.id);
    if (!invoice || invoice.status !== "paid") {
      return { status: "IGNORED", workspaceId, note: "invoice-not-paid" };
    }
    const result = await syncSubscriptionState({
      workspaceId,
      sub,
      paid: invoice,
      now: deps.now,
    });
    return result.applied
      ? { status: "PROCESSED", workspaceId }
      : { status: "IGNORED", workspaceId, note: result.note };
  }

  if (session.mode === "payment") {
    if (!settled) {
      return { status: "IGNORED", workspaceId, note: "awaiting-payment" };
    }
    const packKey = session.metadata.pack;
    if (session.metadata.kind !== "pack" || !isExtraPackKey(packKey)) {
      return { status: "IGNORED", workspaceId, note: "unknown-purchase" };
    }
    const reference = session.paymentIntentId ?? session.id;
    const granted = await grantExtraPack({
      workspaceId,
      packKey,
      reference,
      now: deps.now,
    });
    // Olaylar sırasız gelebilir: ödemeden önce iade işlendiyse hibe iade durumuna göre
    // hemen düzeltilir.
    if (session.paymentIntentId) {
      const intent = await deps.gateway.getPaymentIntent(
        session.paymentIntentId,
      );
      if (intent?.latestChargeId) {
        const charge = await deps.gateway.getCharge(intent.latestChargeId);
        if (charge && charge.amountRefunded > 0) {
          await reconcilePackRefund({
            workspaceId,
            packKey,
            reference,
            charge,
            now: deps.now,
          });
        }
      }
    }
    return granted.granted
      ? { status: "PROCESSED", workspaceId }
      : { status: "PROCESSED", workspaceId, note: granted.note };
  }

  return { status: "IGNORED", workspaceId, note: "unhandled-mode" };
}

// -- iade ve itiraz -------------------------------------------------------------

async function handleChargeRefunded(
  chargeId: string,
  deps: EventDeps,
): Promise<Outcome> {
  const charge = await deps.gateway.getCharge(chargeId);
  if (!charge) return { status: "IGNORED", note: "charge-missing" };
  return applyChargeReversal(charge, deps, "REFUNDED");
}

async function handleDispute(
  disputeId: string,
  deps: EventDeps,
): Promise<Outcome> {
  const dispute = await deps.gateway.getDispute(disputeId);
  if (!dispute?.chargeId)
    return { status: "IGNORED", note: "dispute-without-charge" };
  const charge = await deps.gateway.getCharge(dispute.chargeId);
  if (!charge) return { status: "IGNORED", note: "charge-missing" };
  // İtiraz tutarın tamamını riske atar: ek paket tamamen, abonelik hemen sona erer.
  return applyChargeReversal(
    { ...charge, amountRefunded: charge.amount, refunded: true },
    deps,
    "CHARGEBACK",
  );
}

async function applyChargeReversal(
  charge: StripeChargeFacts,
  deps: EventDeps,
  reason: "REFUNDED" | "CHARGEBACK",
): Promise<Outcome> {
  if (charge.invoiceId) {
    const invoice = await deps.gateway.getInvoice(charge.invoiceId);
    if (invoice?.subscriptionId) {
      return reverseSubscriptionCharge(charge, invoice, deps, reason);
    }
  }
  return reversePackCharge(charge, deps);
}

async function reverseSubscriptionCharge(
  charge: StripeChargeFacts,
  invoice: NonNullable<Awaited<ReturnType<StripeGateway["getInvoice"]>>>,
  deps: EventDeps,
  reason: "REFUNDED" | "CHARGEBACK",
): Promise<Outcome> {
  if (reason === "REFUNDED" && charge.amountRefunded < charge.amount) {
    return { status: "IGNORED", note: "partial-refund" };
  }
  const sub = await deps.gateway.getSubscription(invoice.subscriptionId!);
  if (!sub) return { status: "IGNORED", note: "subscription-missing" };
  const resolved = await resolveWorkspaceForCustomer(
    sub.customerId,
    sub.metadata.workspaceId,
  );
  if (!resolved.ok) return { status: "IGNORED", note: resolved.note };

  const ended = await endSubscriptionAfterRefund({
    workspaceId: resolved.workspaceId,
    sub,
    invoice,
    reason,
    now: deps.now,
  });
  if (!ended.applied) {
    return {
      status: "IGNORED",
      workspaceId: resolved.workspaceId,
      note: ended.note,
    };
  }
  // Para iade edilen abonelik yenilenmesin: Stripe tarafını da kapat. Başarısızsa olay
  // yeniden denenir (yukarıdaki adım tekrara dayanıklı).
  if (sub.status !== "canceled") {
    await deps.gateway.cancelSubscriptionNow(sub.id);
  }
  return { status: "PROCESSED", workspaceId: resolved.workspaceId };
}

async function reversePackCharge(
  charge: StripeChargeFacts,
  deps: EventDeps,
): Promise<Outcome> {
  if (!charge.paymentIntentId) {
    return { status: "IGNORED", note: "unrelated-charge" };
  }
  const intent = await deps.gateway.getPaymentIntent(charge.paymentIntentId);
  const packKey = intent?.metadata.pack;
  if (!intent || intent.metadata.kind !== "pack" || !isExtraPackKey(packKey)) {
    return { status: "IGNORED", note: "unrelated-charge" };
  }
  const resolved = await resolveWorkspaceForCustomer(
    intent.customerId ?? charge.customerId,
    intent.metadata.workspaceId,
  );
  if (!resolved.ok) return { status: "IGNORED", note: resolved.note };
  const result = await reconcilePackRefund({
    workspaceId: resolved.workspaceId,
    packKey,
    reference: intent.id,
    charge,
    now: deps.now,
  });
  return {
    status: "PROCESSED",
    workspaceId: resolved.workspaceId,
    note: "note" in result ? result.note : undefined,
  };
}
