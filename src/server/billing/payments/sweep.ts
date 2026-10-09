import "server-only";

import { prisma } from "@/lib/prisma";
import { metaWorkExcludedHere } from "@/lib/local-worker-policy";
import { claimPeriodic } from "@/server/observability/periodic";

import type { StripeMode } from "../stripe/key-mode";
import type { StripeGateway } from "../stripe/gateway";
import { syncSubscriptionState } from "./subscription-state";

// Webhook'a bağımlı olmayan güvenlik ağı: yenileme tarihi gelmiş ya da geçmiş
// abonelikleri Stripe'tan YENİDEN okuyup aynı durum makinesine verir. Webhook ucu saatlerce
// ya da günlerce kapalı kalırsa (Stripe ~3 gün yeniden dener, sonra bırakır), yenilemesini
// ödemiş bir müşteri erişimsiz, aboneliği Stripe'ta bitmiş bir müşteri durumu eski kalmasın.
//
// Yalnız BİZİM bağladığımız abonelikler (Subscription.stripeSubscriptionId) ve yalnız çalışan
// anahtarın modu (test/canlı karışmaz). Aday: ACTIVE/PAST_DUE ve ödenmiş süresi bitmiş ya da
// çok yakında bitecek; çok eski (SWEEP_LOOKBACK_MS) satırlar aday değildir (yıllarca ödemesiz
// kalmış ölü satırlar sırayı işgal etmesin). Bir tur en çok SWEEP_BATCH satır okur;
// yenisi önce. Her satırın hatası kendi içinde kalır.

export const SWEEP_EVERY_MS = 30 * 60 * 1000;
export const SWEEP_BATCH = 25;
// Yenileme bundan önce başlamış sayılır (saat sapması ve webhook gecikmesi payı).
export const SWEEP_LEAD_MS = 60 * 60 * 1000;
export const SWEEP_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

export type SweepSummary = { checked: number; changed: number; failed: number };

export async function sweepSubscriptions(
  deps: { gateway: StripeGateway; mode: StripeMode },
  options: { now?: Date; limit?: number } = {},
): Promise<SweepSummary> {
  const now = options.now ?? new Date();
  const rows = await prisma.subscription.findMany({
    where: {
      stripeSubscriptionId: { not: null },
      stripeLivemode: deps.mode === "live",
      status: { in: ["ACTIVE", "PAST_DUE"] },
      paidThrough: {
        gte: new Date(now.getTime() - SWEEP_LOOKBACK_MS),
        lte: new Date(now.getTime() + SWEEP_LEAD_MS),
      },
    },
    orderBy: { paidThrough: "desc" },
    take: options.limit ?? SWEEP_BATCH,
    select: {
      workspaceId: true,
      stripeSubscriptionId: true,
      paidThrough: true,
    },
  });

  const summary: SweepSummary = { checked: 0, changed: 0, failed: 0 };
  for (const row of rows) {
    summary.checked += 1;
    try {
      const sub = await deps.gateway.getSubscription(row.stripeSubscriptionId!);
      if (!sub) {
        // Stripe artık tanımıyor (silinmiş): elle bakılması gereken bir durum.
        summary.failed += 1;
        console.error(
          `[billing] sweep: Stripe has no subscription ${row.stripeSubscriptionId} (workspace ${row.workspaceId})`,
        );
        continue;
      }
      // Ödenmiş yeni dönem varsa (kaçırılmış yenileme) onu uygula.
      let paid = null;
      if (sub.latestInvoice?.status === "paid") {
        const invoice = await deps.gateway.getInvoice(sub.latestInvoice.id);
        if (
          invoice &&
          invoice.status === "paid" &&
          invoice.periodEnd &&
          (!row.paidThrough || invoice.periodEnd > row.paidThrough)
        ) {
          paid = invoice;
        }
      }
      const result = await syncSubscriptionState({
        workspaceId: row.workspaceId,
        sub,
        paid,
        now,
      });
      if (result.applied && result.changed) summary.changed += 1;
    } catch (error) {
      summary.failed += 1;
      console.error(
        "[billing] sweep failed for a subscription:",
        error instanceof Error ? error.name : error,
      );
    }
  }
  return summary;
}

// Tick adımı: yalnız ödeme açıkken ve en çok yarım saatte bir (çok işlemcili dağıtımda tek
// koşucu). BILLING_MODE'dan bağımsızdır: kapalıyken de abonelik satırı doğru kalır.
export async function runPaymentsSweepTick(
  now: Date = new Date(),
): Promise<number> {
  // Canlı veritabanını paylaşan geliştirme sürecinde koşmaz (period-tick.ts ile aynı kural).
  if (metaWorkExcludedHere(process.env)) return 0;
  const { getPaymentDeps } = await import("./deps");
  const deps = getPaymentDeps();
  if (!deps) return 0;
  if (!(await claimPeriodic("billing.payments-sweep", SWEEP_EVERY_MS, now))) {
    return 0;
  }
  const summary = await sweepSubscriptions(deps, { now });
  return summary.changed;
}
