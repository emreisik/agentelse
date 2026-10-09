import "server-only";

import { prisma } from "@/lib/prisma";
import { sellableUnits } from "@/lib/billing/plans";
import { quotaWindowAt } from "@/lib/billing/windows";

import { revokeUsage } from "../ledger";
import type {
  StripeInvoiceFacts,
  StripeSubscriptionFacts,
} from "../stripe/facts";
import { lockWorkspace } from "./subscription-state";

// Abonelik faturasının TAMAMI iade edildiğinde ya da itiraz (chargeback) açıldığında:
// erişim hemen biter ve açık penceredeki KULLANILMAMIŞ hak geri alınır (taban: kullanılmış
// + rezerve). Kısmi iade erişimi değiştirmez. İade/itiraz politikası sahip kararı bekliyor
// (docs/billing-payments.md): bunlar güvenli varsayılandır.

// Faturanın dönemi, ödenmiş sürenin bu kadar gerisindeyse "geçmiş dönem" sayılır.
const CURRENT_PERIOD_SLACK_MS = 24 * 60 * 60 * 1000;

export type SubscriptionRefundResult =
  { applied: true; alreadyEnded: boolean } | { applied: false; note: string };

export async function endSubscriptionAfterRefund(input: {
  workspaceId: string;
  sub: StripeSubscriptionFacts;
  invoice: StripeInvoiceFacts;
  reason: "REFUNDED" | "CHARGEBACK";
  now?: Date;
}): Promise<SubscriptionRefundResult> {
  const now = input.now ?? new Date();
  const { workspaceId, sub, invoice } = input;

  return prisma.$transaction(
    async (tx): Promise<SubscriptionRefundResult> => {
      await lockWorkspace(tx, workspaceId);
      const row = await tx.subscription.findUnique({ where: { workspaceId } });
      if (!row || row.stripeSubscriptionId !== sub.id) {
        return { applied: false, note: "stale-subscription" };
      }
      // Yalnız GEÇERLİ dönemin faturası erişimi bitirir; geçmiş dönem ya da orantı
      // faturası (plan değişikliği) iadesi sahibin elle ele alacağı bir durumdur.
      if (!invoice.periodEnd)
        return { applied: false, note: "not-a-period-invoice" };
      if (
        row.paidThrough &&
        invoice.periodEnd.getTime() <
          row.paidThrough.getTime() - CURRENT_PERIOD_SLACK_MS
      ) {
        return { applied: false, note: "older-period" };
      }

      const alreadyEnded =
        row.status === "CANCELED" &&
        row.endedReason === input.reason &&
        (!row.paidThrough || row.paidThrough.getTime() <= now.getTime());
      if (!alreadyEnded) {
        await tx.subscription.update({
          where: { workspaceId },
          data: {
            status: "CANCELED",
            paidThrough:
              row.paidThrough && row.paidThrough.getTime() > now.getTime()
                ? now
                : row.paidThrough,
            endedAt: now,
            endedReason: input.reason,
            graceUntil: null,
            pendingPlanKey: null,
            pendingInterval: null,
            pendingEffectiveAt: null,
          },
        });
      }

      const window = row.quotaAnchor
        ? quotaWindowAt(row.quotaAnchor, now)
        : null;
      if (window) {
        for (const unit of sellableUnits()) {
          await revokeUsage(
            {
              workspaceId,
              unit,
              pool: "PERIOD",
              amount: "ALL_UNUSED",
              idempotencyKey: `refund:${invoice.id}`,
              periodStart: window.start,
              now,
            },
            tx,
          );
        }
      }
      return { applied: true, alreadyEnded };
    },
    { maxWait: 10_000, timeout: 20_000 },
  );
}
