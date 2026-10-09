import Link from "next/link";

import { formatDay, formatUsd, trialSummary } from "@/lib/billing/catalog";
import { PLANS, yearlyCents } from "@/lib/billing/plans";
import type { BillingOverview } from "@/server/billing/overview";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";

const muted = { color: "var(--ws-text-2)" } as const;
const faint = { color: "var(--ws-text-3)" } as const;

const STATUS_LABEL: Record<string, string> = {
  LEGACY: "Early access",
  TRIALING: "Trial",
  ACTIVE: "Active",
  PAST_DUE: "Payment overdue",
  CANCELED: "Canceled",
};

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div
      className="flex items-center justify-between gap-4 border-t px-4 py-2.5 text-[13px] first:border-t-0"
      style={{ borderColor: "var(--ws-border)" }}
    >
      <span style={muted}>{label}</span>
      <span style={{ color: "var(--ws-text)" }}>{value}</span>
    </div>
  );
}

export function SubscriptionPanel({
  overview,
  canManage,
}: {
  overview: BillingOverview;
  canManage: boolean;
}) {
  const subscription = overview.subscription;
  const plan = subscription?.planKey ? PLANS[subscription.planKey] : null;
  const yearly = subscription?.interval === "YEAR";

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-2.5">
        <h3
          className="font-heading text-sm font-semibold"
          style={{ color: "var(--ws-text)" }}
        >
          Your plan
        </h3>
        <div
          className="overflow-hidden rounded-[13px] border"
          style={{
            borderColor: "var(--ws-border)",
            background: "var(--ws-surface)",
            boxShadow: "var(--ws-card-shadow)",
          }}
        >
          {subscription ? (
            <>
              <div className="flex items-center justify-between gap-3 px-4 py-3.5">
                <div>
                  <div
                    className="font-heading text-base font-semibold"
                    style={{ color: "var(--ws-text)" }}
                  >
                    {plan ? plan.label : "No plan chosen"}
                  </div>
                  {plan ? (
                    <div className="text-xs" style={muted}>
                      {yearly
                        ? `${formatUsd(yearlyCents(plan.key))} billed yearly`
                        : `${formatUsd(plan.monthlyCents)}/month`}
                    </div>
                  ) : null}
                </div>
                <Badge variant="secondary">
                  {subscription.exempt
                    ? "Full access"
                    : (STATUS_LABEL[subscription.status] ?? subscription.status)}
                </Badge>
              </div>
              {subscription.paidThrough ? (
                <Row
                  label={
                    subscription.cancelAtPeriodEnd ? "Ends on" : "Renews on"
                  }
                  value={formatDay(subscription.paidThrough)}
                />
              ) : null}
              {subscription.trialEndsAt ? (
                <Row
                  label="Trial ends"
                  value={formatDay(subscription.trialEndsAt)}
                />
              ) : null}
              {subscription.pending ? (
                <Row
                  label="Scheduled change"
                  value={`${
                    subscription.pending.planKey
                      ? PLANS[subscription.pending.planKey].label
                      : "New plan"
                  }${
                    subscription.pending.effectiveAt
                      ? ` on ${formatDay(subscription.pending.effectiveAt)}`
                      : ""
                  }`}
                />
              ) : null}
            </>
          ) : (
            <div className="px-4 py-4">
              <div
                className="font-heading text-base font-semibold"
                style={{ color: "var(--ws-text)" }}
              >
                No plan yet
              </div>
              <p className="mt-1 text-[13px]" style={muted}>
                Plans are not on sale yet, so nothing is charged and nothing is
                limited. When they open, new accounts start with a{" "}
                {trialSummary()}.
              </p>
            </div>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/billing?tab=plans"
            className={buttonVariants({ size: "lg", variant: "default" })}
          >
            {plan ? "Change plan" : "See plans"}
          </Link>
          <Button type="button" size="lg" variant="outline" disabled>
            Cancel subscription
          </Button>
          <Button type="button" size="lg" variant="outline" disabled>
            Payment method
          </Button>
        </div>
        {!canManage ? (
          <p className="text-xs" style={faint}>
            Only a workspace owner or admin can change the plan.
          </p>
        ) : null}
      </section>

      <section className="flex flex-col gap-2.5">
        <h3
          className="font-heading text-sm font-semibold"
          style={{ color: "var(--ws-text)" }}
        >
          Invoices and payments
        </h3>
        <div
          className="rounded-[13px] border px-4 py-6 text-center text-[13px]"
          style={{ borderColor: "var(--ws-border)", ...muted }}
        >
          Nothing to show yet. Invoices and payments appear here once you
          subscribe.
        </div>
      </section>
    </div>
  );
}
