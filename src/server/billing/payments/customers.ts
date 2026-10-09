import "server-only";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import type { StripeGateway } from "../stripe/gateway";

// Workspace ↔ Stripe müşterisi eşlemesi (BillingCustomer). TEK güvenilir kaynak:
// webhook olayları workspace'i yalnız bu tablodan çözer; Stripe tarafındaki metadata
// yalnız ÇAPRAZ DOĞRULAMA içindir (ikisi çelişirse olay işlenmez).

export async function ensureBillingCustomer(input: {
  workspaceId: string;
  livemode: boolean;
  gateway: StripeGateway;
  email?: string | null;
  name?: string | null;
}): Promise<string> {
  const { workspaceId, livemode } = input;
  const existing = await prisma.billingCustomer.findUnique({
    where: { workspaceId_livemode: { workspaceId, livemode } },
  });
  if (existing) return existing.stripeCustomerId;

  const stripeCustomerId = await input.gateway.createCustomer({
    workspaceId,
    email: input.email,
    name: input.name,
  });
  try {
    const created = await prisma.billingCustomer.create({
      data: { workspaceId, livemode, stripeCustomerId },
    });
    return created.stripeCustomerId;
  } catch (error) {
    // Eşzamanlı ikinci istek önce yazdı: onunkini kullan (yetim Stripe müşterisi zararsız).
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const winner = await prisma.billingCustomer.findUnique({
        where: { workspaceId_livemode: { workspaceId, livemode } },
      });
      if (winner) return winner.stripeCustomerId;
    }
    throw error;
  }
}

// Stripe tarafında silinmiş müşteri: eşlemeyi bırak, bir sonraki ensure yenisini açar.
export async function forgetBillingCustomer(
  workspaceId: string,
  livemode: boolean,
): Promise<void> {
  await prisma.billingCustomer.deleteMany({ where: { workspaceId, livemode } });
}

export type WorkspaceResolution =
  | { ok: true; workspaceId: string; livemode: boolean }
  | { ok: false; note: "unknown-customer" | "tenant-mismatch" | "no-customer" };

// Müşteri kimliğinden workspace. `hint` Stripe nesnesinin metadata/client_reference_id
// alanındaki workspace kimliğidir: varsa eşleme ile AYNI olmalıdır, değilse hiçbir şey
// işlenmez (bir kiracının ödemesi başka bir kiracıya yazılamaz).
export async function resolveWorkspaceForCustomer(
  customerId: string | null | undefined,
  hint?: string | null,
): Promise<WorkspaceResolution> {
  if (!customerId) return { ok: false, note: "no-customer" };
  const link = await prisma.billingCustomer.findUnique({
    where: { stripeCustomerId: customerId },
  });
  if (!link) return { ok: false, note: "unknown-customer" };
  if (hint && hint !== link.workspaceId) {
    return { ok: false, note: "tenant-mismatch" };
  }
  return { ok: true, workspaceId: link.workspaceId, livemode: link.livemode };
}
