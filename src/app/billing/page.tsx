import { notFound } from "next/navigation";

import { comparisonRows, planCards } from "@/lib/billing/catalog";
import { YEARLY_DISCOUNT_PCT } from "@/lib/billing/plans";
import { getBillingOverview } from "@/server/billing/overview";
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
import { PlanPicker } from "@/components/billing/plan-picker";
import { SubscriptionPanel } from "@/components/billing/subscription-panel";
import { TasksPanel } from "@/components/billing/tasks-panel";
import { UsagePanel } from "@/components/billing/usage-panel";

// Payments are not connected yet (docs/billing-quota.md, Faz 4): plans can be
// looked at and compared, not bought. Flipped by the payment provider setup.
const PAYMENTS_OPEN = false;

export const metadata = { title: "Plan & usage" };

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!isBillingUiEnabled()) notFound();

  const { userId } = await requireUser();
  const { workspaceId } = await requireWorkspaceMembership(userId);
  const params = await searchParams;
  const tab = parseBillingTab(params.tab);

  const [overview, canManage] = await Promise.all([
    getBillingOverview(workspaceId),
    isWorkspaceManager(userId, workspaceId),
  ]);

  return (
    <AppShell>
      <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-6 px-4 py-8 md:py-12">
        <div>
          <h1
            className="font-heading text-2xl font-semibold tracking-tight"
            style={{ color: "var(--ws-text)" }}
          >
            Plan &amp; usage
          </h1>
          <p className="text-sm" style={{ color: "var(--ws-text-2)" }}>
            Your plan, what is left of it, and the work that is waiting.
          </p>
        </div>

        <BillingTabs active={tab} />

        {tab === "plans" ? (
          <PlanPicker
            cards={planCards()}
            comparison={comparisonRows()}
            currentPlanKey={overview.subscription?.planKey ?? null}
            yearlyDiscountPct={YEARLY_DISCOUNT_PCT}
            paymentsOpen={PAYMENTS_OPEN}
          />
        ) : null}
        {tab === "subscription" ? (
          <SubscriptionPanel overview={overview} canManage={canManage} />
        ) : null}
        {tab === "usage" ? <UsagePanel overview={overview} /> : null}
        {tab === "tasks" ? <TasksPanel tasks={overview.tasks} /> : null}
      </div>
    </AppShell>
  );
}
