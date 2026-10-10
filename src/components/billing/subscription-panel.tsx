import Link from "next/link";

import { formatDay, formatUsd, trialSummary } from "@/lib/billing/catalog";
import { PLANS, yearlyCents } from "@/lib/billing/plans";
import type {
  BillingOverview,
  SubscriptionOverview,
} from "@/server/billing/overview";
import {
  cancelSubscriptionAction,
  openPortalAction,
  resumeSubscriptionAction,
} from "@/server/actions/billing-actions";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";

import { BillingActionButton } from "./billing-action-button";

// One invoice row for the table (dates as ISO strings: it crosses the server boundary).
export type InvoiceRow = {
  id: string;
  number: string | null;
  createdAt: string | null;
  amountPaid: number;
  amountDue: number;
  currency: string | null;
  status: string | null;
  hostedInvoiceUrl: string | null;
  invoicePdf: string | null;
};

const muted = { color: "var(--ws-text-2)" } as const;
const faint = { color: "var(--ws-text-3)" } as const;

const STATUS_LABEL: Record<string, string> = {
  LEGACY: "Early access",
  TRIALING: "Trial",
  ACTIVE: "Active",
  PAST_DUE: "Payment overdue",
  CANCELED: "Canceled",
};

const ENDED_REASON_LABEL: Record<string, string> = {
  REFUNDED: "Refunded",
  CHARGEBACK: "Payment disputed",
  PAYMENT_FAILED: "Payment failed",
};

const INVOICE_STATUS_LABEL: Record<string, string> = {
  paid: "Paid",
  open: "Unpaid",
  uncollectible: "Uncollectible",
};

// What cancelling means, said honestly for the billing mode: only while limits are
// enforced does the workspace become read-only afterwards.
export function cancelDescription(
  paidThrough: string | null,
  mode: BillingOverview["mode"],
  status: string = "ACTIVE",
): string {
  // An overdue subscription has no paid time left: its date is the old, already passed
  // period end, and the unpaid invoice is not cancelled by cancelling the plan.
  if (status === "PAST_DUE") {
    return "Your last payment did not go through, so this subscription is past due. Canceling stops it from renewing; it does not cancel the unpaid invoice. You can resume before the plan ends.";
  }
  const until = paidThrough
    ? formatDay(paidThrough)
    : "the end of the paid period";
  const after =
    mode === "enforce"
      ? "after that the workspace becomes read-only"
      : "after that your plan ends";
  return `Nothing more is charged. You keep your plan and your remaining usage until ${until}; ${after}. You can resume before then.`;
}

// The date row says what the date means for THIS state (a canceled or refunded
// subscription does not "renew").
function dateRow(
  subscription: SubscriptionOverview,
): { label: string; value: string } | null {
  if (!subscription.paidThrough) return null;
  const value = formatDay(subscription.paidThrough);
  switch (subscription.status) {
    case "ACTIVE":
      return {
        label: subscription.cancelAtPeriodEnd ? "Ends on" : "Renews on",
        value,
      };
    case "PAST_DUE":
      return { label: "Paid through", value };
    case "CANCELED":
      return {
        label: subscription.paidAccess ? "Access until" : "Ended on",
        value,
      };
    default:
      return { label: "Paid through", value };
  }
}

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
  paymentsOpen = false,
  invoices = [],
  invoicesFailed = false,
}: {
  overview: BillingOverview;
  canManage: boolean;
  // Payments are connected: cancel / resume / payment method work.
  paymentsOpen?: boolean;
  invoices?: InvoiceRow[];
  // The invoice list could not be loaded (not the same as "no invoices yet").
  invoicesFailed?: boolean;
}) {
  const subscription = overview.subscription;
  const paying =
    paymentsOpen &&
    canManage &&
    subscription?.stripeLinked === true &&
    (subscription.status === "ACTIVE" || subscription.status === "PAST_DUE");
  const plan = subscription?.planKey ? PLANS[subscription.planKey] : null;
  const yearly = subscription?.interval === "YEAR";
  const dateInfo = subscription ? dateRow(subscription) : null;
  const endedReason = subscription?.endedReason
    ? ENDED_REASON_LABEL[subscription.endedReason]
    : undefined;

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
                    {plan
                      ? plan.label
                      : subscription.status === "TRIALING"
                        ? "Free trial"
                        : "No plan chosen"}
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
                    : subscription.status === "TRIALING" &&
                        !subscription.trialActive
                      ? "Trial ended"
                      : (STATUS_LABEL[subscription.status] ??
                        subscription.status)}
                </Badge>
              </div>
              {dateInfo ? (
                <Row label={dateInfo.label} value={dateInfo.value} />
              ) : null}
              {subscription.status === "CANCELED" && endedReason ? (
                <Row label="Reason" value={endedReason} />
              ) : null}
              {subscription.trialEndsAt ? (
                <Row
                  label={
                    subscription.trialActive ? "Trial ends" : "Trial ended"
                  }
                  value={formatDay(subscription.trialEndsAt)}
                />
              ) : null}
              {subscription.status === "TRIALING" && !subscription.exempt ? (
                <p
                  className="border-t px-4 py-3 text-[13px]"
                  style={{ borderColor: "var(--ws-border)", ...muted }}
                >
                  {subscription.trialActive
                    ? `You are on the ${trialSummary()}. Choose a plan any time to keep going after it ends.`
                    : "Your free trial has ended. Choose a plan in Plans to keep creating."}
                </p>
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
                {paymentsOpen
                  ? "Choose a plan in Plans to get a monthly allowance."
                  : "Plans are not on sale yet, so nothing is charged and nothing is limited."}
              </p>
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-start gap-2">
          <Link
            href="/billing?tab=plans"
            className={buttonVariants({ size: "lg", variant: "default" })}
          >
            {plan ? "Change plan" : "See plans"}
          </Link>
          {paying && subscription?.cancelAtPeriodEnd ? (
            <BillingActionButton
              variant="outline"
              busyLabel="Resuming…"
              action={resumeSubscriptionAction}
              doneHref="/billing?tab=subscription&notice=resumed"
            >
              Resume subscription
            </BillingActionButton>
          ) : paying ? (
            <BillingActionButton
              variant="outline"
              busyLabel="Canceling…"
              confirm={{
                title: "Cancel your subscription?",
                description: cancelDescription(
                  subscription?.paidThrough ?? null,
                  overview.mode,
                  subscription?.status,
                ),
                confirmLabel: "Cancel at period end",
              }}
              action={cancelSubscriptionAction}
              doneHref="/billing?tab=subscription&notice=canceled"
            >
              Cancel subscription
            </BillingActionButton>
          ) : (
            <Button type="button" size="lg" variant="outline" disabled>
              Cancel subscription
            </Button>
          )}
          {paying ? (
            <BillingActionButton
              variant="outline"
              busyLabel="Opening…"
              action={openPortalAction}
            >
              Payment method
            </BillingActionButton>
          ) : (
            <Button type="button" size="lg" variant="outline" disabled>
              Payment method
            </Button>
          )}
        </div>
        {!paymentsOpen && subscription?.paidAccess ? (
          <p className="text-xs" style={faint}>
            Plan changes, cancellation and invoices are temporarily unavailable.
            Your subscription is not affected.
          </p>
        ) : null}
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
        {invoices.length > 0 ? (
          <div
            className="overflow-x-auto rounded-[13px] border"
            style={{ borderColor: "var(--ws-border)" }}
          >
            <table className="w-full min-w-[480px] text-[13px]">
              <thead>
                <tr style={{ background: "var(--ws-surface-2)" }}>
                  <th className="px-4 py-2 text-left font-medium" style={muted}>
                    Date
                  </th>
                  <th className="px-4 py-2 text-left font-medium" style={muted}>
                    Invoice
                  </th>
                  <th
                    className="px-4 py-2 text-right font-medium"
                    style={muted}
                  >
                    Amount
                  </th>
                  <th className="px-4 py-2 text-left font-medium" style={muted}>
                    Status
                  </th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {invoices.map((invoice) => (
                  <tr
                    key={invoice.id}
                    className="border-t"
                    style={{ borderColor: "var(--ws-border)" }}
                  >
                    <td
                      className="px-4 py-2"
                      style={{ color: "var(--ws-text-body)" }}
                    >
                      {invoice.createdAt ? formatDay(invoice.createdAt) : "—"}
                    </td>
                    <td className="px-4 py-2" style={muted}>
                      {invoice.number ?? "—"}
                    </td>
                    <td
                      className="px-4 py-2 text-right tabular-nums"
                      style={{ color: "var(--ws-text-body)" }}
                    >
                      {formatUsd(
                        invoice.status === "paid"
                          ? invoice.amountPaid
                          : invoice.amountDue,
                      )}
                    </td>
                    <td className="px-4 py-2" style={muted}>
                      {invoice.status
                        ? (INVOICE_STATUS_LABEL[invoice.status] ??
                          invoice.status)
                        : "—"}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {invoice.hostedInvoiceUrl ? (
                        <a
                          href={invoice.hostedInvoiceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs underline underline-offset-2"
                          style={muted}
                        >
                          View
                        </a>
                      ) : null}
                      {invoice.invoicePdf ? (
                        <a
                          href={invoice.invoicePdf}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="ml-3 text-xs underline underline-offset-2"
                          style={muted}
                        >
                          PDF
                        </a>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div
            className="rounded-[13px] border px-4 py-6 text-center text-[13px]"
            style={{ borderColor: "var(--ws-border)", ...muted }}
          >
            {invoicesFailed
              ? "We could not load your invoices just now. Reload this page in a minute."
              : "Nothing to show yet. Invoices and payments appear here once you subscribe."}
          </div>
        )}
      </section>
    </div>
  );
}
