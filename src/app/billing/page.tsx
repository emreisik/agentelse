import { notFound } from "next/navigation";

import { bannerFor } from "@/lib/billing/banner";
import { comparisonRows, planCards } from "@/lib/billing/catalog";
import { pickerModeFor } from "@/lib/billing/picker-mode";
import { YEARLY_DISCOUNT_PCT } from "@/lib/billing/plans";
import { isRateLimited } from "@/lib/rate-limit";
import { getBillingOverview } from "@/server/billing/overview";
import { getPaymentDeps } from "@/server/billing/payments/deps";
import {
  listWorkspaceInvoices,
  reconcileCheckoutReturn,
  type ReturnState,
} from "@/server/billing/payments/service";
import { isBillingUiEnabled } from "@/server/billing/ui-flag";
import {
  isWorkspaceManager,
  requireUser,
  requireWorkspaceMembership,
} from "@/server/security/tenant-context";
import { AppShell } from "@/components/layout/app-shell";
import {
  BillingTabs,
  parseBillingTab,
} from "@/components/billing/billing-tabs";
import { ClearOneShotParams } from "@/components/billing/clear-one-shot-params";
import { PlanPicker } from "@/components/billing/plan-picker";
import {
  SubscriptionPanel,
  type InvoiceRow,
} from "@/components/billing/subscription-panel";
import { TasksPanel } from "@/components/billing/tasks-panel";
import { UsagePanel } from "@/components/billing/usage-panel";
import { Badge } from "@/components/ui/badge";

export const metadata = { title: "Plan & usage" };

type Params = Record<string, string | string[] | undefined>;

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  if (!isBillingUiEnabled()) notFound();

  const { userId } = await requireUser();
  const { workspaceId } = await requireWorkspaceMembership(userId);
  const params = await searchParams;
  const tab = parseBillingTab(params.tab);
  const deps = getPaymentDeps();
  const canManage = await isWorkspaceManager(userId, workspaceId);

  // Coming back from Stripe Checkout: bring the state up to date right now instead of
  // waiting for the webhook (the same handler, safe to run twice). Only for the person who
  // can manage billing, at a bounded rate (this page must not become a way to make the
  // server query Stripe at will).
  const sessionId = first(params.session_id);
  const comingBack =
    first(params.checkout) === "success" ||
    first(params.purchase) === "success";
  let returned: ReturnState | null = null;
  if (deps && canManage && comingBack && sessionId) {
    returned = isRateLimited(`billing:return:${workspaceId}`, 10, 10 * 60_000)
      ? "pending"
      : await reconcileCheckoutReturn({ workspaceId, sessionId }, deps);
  }

  const overview = await getBillingOverview(
    workspaceId,
    new Date(),
    deps?.mode ?? null,
  );
  const subscription = overview.subscription;

  const listing =
    deps && canManage && tab === "subscription" && subscription?.stripeLinked
      ? await listWorkspaceInvoices({ workspaceId }, deps)
      : { rows: [], failed: false };
  const invoices: InvoiceRow[] = listing.rows.map((row) => ({
    ...row,
    createdAt: row.createdAt?.toISOString() ?? null,
  }));

  const mode = pickerModeFor({
    paymentsOpen: deps !== null,
    canManage,
    subscription: subscription
      ? {
          planKey: subscription.planKey,
          interval: subscription.interval,
          status: subscription.status,
          paidThrough: subscription.paidThrough,
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
          pendingPlanKey: subscription.pending?.planKey ?? null,
          stripeLinked: subscription.stripeLinked,
          introOffer: subscription.introOffer,
          exempt: subscription.exempt,
        }
      : null,
  });

  const packsOpen =
    deps !== null &&
    canManage &&
    subscription?.paidAccess === true &&
    !subscription.exempt;
  const packsNote =
    deps === null
      ? undefined
      : !canManage
        ? "Only a workspace owner or admin can buy extra usage."
        : subscription?.exempt
          ? "This workspace has full access, so there is nothing to buy."
          : "Extra usage can be added while you have a plan.";

  const banner = bannerFor(params, returned);

  return (
    <AppShell>
      <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-6 px-4 py-8 md:py-12">
        <div>
          <div className="flex items-center gap-2">
            <h1
              className="font-heading text-2xl font-semibold tracking-tight"
              style={{ color: "var(--ws-text)" }}
            >
              Plan &amp; usage
            </h1>
            {deps?.mode === "test" ? (
              <Badge variant="secondary">Test mode · no real charges</Badge>
            ) : null}
          </div>
          <p className="text-sm" style={{ color: "var(--ws-text-2)" }}>
            Your plan, what is left of it, and the work that is waiting.
          </p>
        </div>

        <ClearOneShotParams />

        {banner ? (
          <div
            role="status"
            className="rounded-[13px] border px-4 py-3 text-[13px]"
            style={{
              borderColor: "var(--ws-border)",
              background: "var(--ws-surface-2)",
              color: "var(--ws-text-body)",
            }}
          >
            {banner}
          </div>
        ) : null}

        <BillingTabs active={tab} />

        {tab === "plans" ? (
          <PlanPicker
            cards={planCards()}
            comparison={comparisonRows()}
            currentPlanKey={
              subscription?.paidAccess ? subscription.planKey : null
            }
            yearlyDiscountPct={YEARLY_DISCOUNT_PCT}
            mode={mode}
          />
        ) : null}
        {tab === "subscription" ? (
          <SubscriptionPanel
            overview={overview}
            canManage={canManage}
            paymentsOpen={deps !== null}
            invoices={invoices}
            invoicesFailed={listing.failed}
          />
        ) : null}
        {tab === "usage" ? (
          <UsagePanel
            overview={overview}
            packsOpen={packsOpen}
            packsNote={packsNote}
            paymentsOpen={deps !== null}
          />
        ) : null}
        {tab === "tasks" ? <TasksPanel tasks={overview.tasks} /> : null}
      </div>
    </AppShell>
  );
}
