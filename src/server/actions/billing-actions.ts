"use server";

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/prisma";
import { isRateLimited } from "@/lib/rate-limit";
import { getPaymentDeps } from "@/server/billing/payments/deps";
import {
  cancelAtPeriodEnd,
  changePlan,
  checkPromoCode,
  fail,
  openBillingPortal,
  resumeSubscription,
  startPackCheckout,
  startSubscriptionCheckout,
  type ActionResult,
  type PaymentDeps,
  type PlanChangeKind,
} from "@/server/billing/payments/service";
import { isBillingUiEnabled } from "@/server/billing/ui-flag";
import {
  isWorkspaceManager,
  requireUser,
  requireWorkspaceMembership,
} from "@/server/security/tenant-context";

// Plan & usage ekranlarının ödeme eylemleri. Yetki TEK yerde: oturumlu kullanıcı,
// kendi workspace'inin sahibi/yöneticisi, ödeme açık, hız sınırı içinde. Workspace
// ASLA istemciden alınmaz; istemciden yalnız plan/aralık/paket seçimi gelir ve
// serviste doğrulanır (fiyat zaten plans.ts'ten gelir).

const RATE = { max: 20, windowMs: 10 * 60_000 };
// Promosyon kodu tahmini kullanıcı başına 10 / 10 dk: HEM "Uygula" HEM de kodlu Checkout
// aynı sayacı kullanır (ikisi de "kod geçerli mi" sorusunu yanıtlar; ayrı sayaçlar tahmin
// hakkını katlardı).
const PROMO_ATTEMPTS = 10;

type Context = {
  userId: string;
  email: string | null;
  workspaceId: string;
  deps: PaymentDeps;
};

async function guard(
  scope: string,
  max: number = RATE.max,
): Promise<
  { ok: true; ctx: Context } | { ok: false; result: ReturnType<typeof fail> }
> {
  if (!isBillingUiEnabled())
    return { ok: false, result: fail("PAYMENTS_CLOSED") };
  const { userId, email } = await requireUser();
  const { workspaceId } = await requireWorkspaceMembership(userId);
  if (!(await isWorkspaceManager(userId, workspaceId))) {
    return { ok: false, result: fail("FORBIDDEN") };
  }
  const deps = getPaymentDeps();
  if (!deps) return { ok: false, result: fail("PAYMENTS_CLOSED") };
  if (isRateLimited(`billing:${scope}:${userId}`, max, RATE.windowMs)) {
    return { ok: false, result: fail("RATE_LIMITED") };
  }
  return { ok: true, ctx: { userId, email, workspaceId, deps } };
}

async function workspaceName(workspaceId: string): Promise<string | null> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { name: true },
  });
  return workspace?.name ?? null;
}

// Promosyon kodunu sorgular (kod tahmin etmeye karşı daha sıkı sınır: 10 / 10 dakika).
export async function checkPromoCodeAction(input: {
  code: string;
}): Promise<ActionResult<{ code: string; description: string }>> {
  const gate = await guard("promo", PROMO_ATTEMPTS);
  if (!gate.ok) return gate.result;
  return checkPromoCode(
    { workspaceId: gate.ctx.workspaceId, code: input.code },
    gate.ctx.deps,
  );
}

export async function startCheckoutAction(input: {
  planKey: string;
  interval: string;
  applyFirstMonth: boolean;
  promoCode?: string;
}): Promise<ActionResult<{ url: string }>> {
  const gate = await guard("checkout");
  if (!gate.ok) return gate.result;
  const { ctx } = gate;
  // Kodlu Checkout da bir kod sorgusudur (geçersizse PROMO_INVALID, geçerliyse Checkout
  // adresi döner): "Uygula"daki sınırın dışında bir tahmin yolu olmasın.
  const hasPromo =
    typeof input.promoCode === "string" && input.promoCode.trim() !== "";
  if (
    hasPromo &&
    isRateLimited(`billing:promo:${ctx.userId}`, PROMO_ATTEMPTS, RATE.windowMs)
  ) {
    return fail("RATE_LIMITED");
  }
  const result = await startSubscriptionCheckout(
    {
      workspaceId: ctx.workspaceId,
      email: ctx.email,
      name: await workspaceName(ctx.workspaceId),
      planKey: input.planKey,
      interval: input.interval,
      applyFirstMonth: input.applyFirstMonth === true,
      promoCode: input.promoCode,
    },
    ctx.deps,
  );
  // Servis reddetmeden önce satırı Stripe'a göre eşitlemiş olabilir (kaçmış ödeme bağlandı,
  // bitmiş abonelik kapandı): ekran eski kalıp aynı hatayı tekrarlatmasın. Başarıda sayfa
  // zaten Stripe'a gider.
  if (!result.ok) revalidatePath("/billing");
  return result;
}

export async function startPackCheckoutAction(input: {
  packKey: string;
}): Promise<ActionResult<{ url: string }>> {
  const gate = await guard("pack");
  if (!gate.ok) return gate.result;
  const { ctx } = gate;
  const result = await startPackCheckout(
    {
      workspaceId: ctx.workspaceId,
      email: ctx.email,
      name: await workspaceName(ctx.workspaceId),
      packKey: input.packKey,
    },
    ctx.deps,
  );
  if (!result.ok) revalidatePath("/billing");
  return result;
}

export async function openPortalAction(): Promise<
  ActionResult<{ url: string }>
> {
  const gate = await guard("portal");
  if (!gate.ok) return gate.result;
  const result = await openBillingPortal(
    { workspaceId: gate.ctx.workspaceId },
    gate.ctx.deps,
  );
  if (!result.ok) revalidatePath("/billing");
  return result;
}

export async function cancelSubscriptionAction(): Promise<ActionResult> {
  const gate = await guard("cancel");
  if (!gate.ok) return gate.result;
  const result = await cancelAtPeriodEnd(gate.ctx.workspaceId, gate.ctx.deps);
  revalidatePath("/billing");
  return result;
}

export async function resumeSubscriptionAction(): Promise<ActionResult> {
  const gate = await guard("resume");
  if (!gate.ok) return gate.result;
  const result = await resumeSubscription(gate.ctx.workspaceId, gate.ctx.deps);
  revalidatePath("/billing");
  return result;
}

export async function changePlanAction(input: {
  planKey: string;
}): Promise<ActionResult<{ kind: PlanChangeKind }>> {
  const gate = await guard("plan");
  if (!gate.ok) return gate.result;
  const result = await changePlan(
    { workspaceId: gate.ctx.workspaceId, planKey: input.planKey },
    gate.ctx.deps,
  );
  // Başarısız denemede de yenilenir: durum Stripe'tan yeniden eşitlenmiş (ör. belirsiz
  // sonuç, geri konan zamanlanmış düşürme) olabilir; ekran eski hâli göstermesin.
  revalidatePath("/billing");
  return result;
}
