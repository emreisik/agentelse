import "server-only";

import { prisma } from "@/lib/prisma";
import { EXTRA_PACKS, type ExtraPackKey } from "@/lib/billing/plans";

import { grantUsage, revokeUsage, GrantKeyConflictError } from "../ledger";
import { FIND_GRANT_SQL, REVOKED_SO_FAR_SQL } from "../ledger-sql";
import { resumeParkedWork } from "../park";
import type { StripeChargeFacts } from "../stripe/facts";
import { lockWorkspace } from "./subscription-state";

// Ek paket satın alma (Checkout, tek seferlik ödeme): ödeme gelince EXTRA havuzuna
// süresiz hak, iadede orantılı geri alma. Hibe anahtarı ÖDEME NİYETİNDEN türer
// (checkout olayı da iade olayı da aynı kimliği bilir); niyet yoksa (tamamı
// indirimli) oturum kimliği kullanılır.

export function packGrantKey(reference: string): string {
  return `pack:${reference}`;
}

export type PackGrantResult =
  { granted: true } | { granted: false; note: "duplicate" };

export async function grantExtraPack(input: {
  workspaceId: string;
  packKey: ExtraPackKey;
  // payment_intent kimliği; yoksa oturum kimliği.
  reference: string;
  now?: Date;
}): Promise<PackGrantResult> {
  const pack = EXTRA_PACKS[input.packKey];
  let result;
  try {
    result = await grantUsage({
      workspaceId: input.workspaceId,
      unit: pack.unit,
      pool: "EXTRA",
      amount: pack.amount,
      reason: "PURCHASE",
      idempotencyKey: packGrantKey(input.reference),
      now: input.now,
    });
  } catch (error) {
    // Aynı ödeme için çelişen bir hibe var (katalog değişmiş olabilir): tekrar verme.
    if (error instanceof GrantKeyConflictError) {
      console.error(
        "[billing] pack grant key conflict; not granting twice:",
        input.reference,
      );
      return { granted: false, note: "duplicate" };
    }
    throw error;
  }
  if (!("applied" in result) || !result.applied) {
    return { granted: false, note: "duplicate" };
  }
  await resumeAfterGrant(input.workspaceId, input.now);
  return { granted: true };
}

async function resumeAfterGrant(
  workspaceId: string,
  now?: Date,
): Promise<void> {
  try {
    await resumeParkedWork({ workspaceId, now });
  } catch (error) {
    console.error(
      "[billing] could not resume parked work after a purchase:",
      error instanceof Error ? error.name : error,
    );
  }
}

export type PackRefundResult =
  | { revoked: bigint }
  | { revoked: bigint; note: "no-grant" | "nothing-refunded" | "duplicate" };

// İade durumuna göre ek paketin geri alınması: hedef = hibe x iade edilen oran;
// zaten geri alınanın üstü düşülür (idempotent, birden çok kısmi iade doğru toplanır).
// Taban: kullanılmış + rezerve edilmiş kısım geri alınmaz (ledger.revokeUsage).
// Okuma-hesap-yazma tek işlemde ve workspace kilidi altındadır: aynı paketin eşzamanlı iki
// iade olayı (kısmi + tam) aynı "şimdiye dek geri alınan"dan hesaplayıp iki kez düşemez.
export async function reconcilePackRefund(input: {
  workspaceId: string;
  packKey: ExtraPackKey;
  reference: string;
  charge: StripeChargeFacts;
  now?: Date;
}): Promise<PackRefundResult> {
  const pack = EXTRA_PACKS[input.packKey];
  const { charge } = input;
  if (charge.amount <= 0 || charge.amountRefunded <= 0) {
    return { revoked: BigInt(0), note: "nothing-refunded" };
  }
  return prisma.$transaction(
    async (tx): Promise<PackRefundResult> => {
      await lockWorkspace(tx, input.workspaceId);
      const grants = await tx.$queryRawUnsafe<
        Array<{ id: string; pool: string; amount: bigint }>
      >(
        FIND_GRANT_SQL,
        input.workspaceId,
        pack.unit,
        packGrantKey(input.reference),
        "PURCHASE",
      );
      const grant = grants[0];
      if (!grant) return { revoked: BigInt(0), note: "no-grant" };

      const refunded = BigInt(Math.min(charge.amountRefunded, charge.amount));
      const target = (grant.amount * refunded) / BigInt(charge.amount);
      const soFar =
        (
          await tx.$queryRawUnsafe<Array<{ revoked: bigint }>>(
            REVOKED_SO_FAR_SQL,
            grant.id,
          )
        )[0]?.revoked ?? BigInt(0);
      const delta = target - soFar;
      if (delta <= BigInt(0)) return { revoked: BigInt(0) };

      const result = await revokeUsage(
        {
          workspaceId: input.workspaceId,
          unit: pack.unit,
          pool: "EXTRA",
          amount: delta,
          // Anahtar hedefe bağlı: aynı iade durumu bir kez düşer, daha büyük iade yeni anahtar.
          idempotencyKey: `refund:${input.reference}:${target}`,
          reverses: grant.id,
          now: input.now,
        },
        tx,
      );
      return "duplicate" in result
        ? { revoked: result.revoked, note: "duplicate" }
        : { revoked: result.revoked };
    },
    { maxWait: 10_000, timeout: 20_000 },
  );
}
