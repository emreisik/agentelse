// The one-line banner after Stripe sends the customer back, or after an action that
// has no page of its own (plan switch, cancel). Plain text from fixed strings only:
// nothing from the address is echoed.

type Params = Record<string, string | string[] | undefined>;

export type CheckoutReturn =
  "active" | "pending" | "reversed" | "unknown" | null;

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

// Not a payment we can match to this workspace (another workspace's session, an old
// link, a payment outage): neutral, and it does not promise an update.
const UNMATCHED =
  "We could not match this payment to your workspace. If you were charged, it will appear in My subscription shortly; reload this page in a minute.";

export function bannerFor(
  params: Params,
  returned: CheckoutReturn,
): string | null {
  const checkout = first(params.checkout);
  const purchase = first(params.purchase);
  if (checkout === "cancelled") {
    return "Checkout was canceled. Nothing was charged.";
  }
  if (purchase === "cancelled") {
    return "The purchase was canceled. Nothing was charged.";
  }
  if (checkout === "success") {
    switch (returned) {
      case "active":
        return "Payment received. Your plan is active.";
      case "pending":
        return "Payment received. It is still being confirmed; reload this page in a minute.";
      case "reversed":
        return "This payment was refunded, so the plan was not activated.";
      default:
        return UNMATCHED;
    }
  }
  if (purchase === "success") {
    switch (returned) {
      case "active":
        return "Payment received. The extra usage was added to your balance.";
      case "pending":
        return "Payment received. The extra usage is added as soon as it clears; reload this page in a minute.";
      case "reversed":
        return "This payment was refunded, so no extra usage was added.";
      default:
        return UNMATCHED;
    }
  }
  switch (first(params.notice)) {
    case "upgraded":
      return "Plan upgraded. The new plan is active now, and the extra usage was added to this month.";
    case "upgrade-processing":
      return "Your upgrade payment is processing. The new plan applies as soon as it clears.";
    case "downgrade-scheduled":
      return "Switch scheduled. You keep your current plan until your next renewal.";
    case "switch-cancelled":
    case "kept":
      return "The scheduled switch was canceled. You stay on your plan.";
    case "unchanged":
      return "You are already on this plan. Nothing was changed.";
    case "canceled":
      return "Subscription canceled. You keep access until the end of the paid period.";
    case "resumed":
      return "Subscription resumed. It renews as usual.";
    default:
      return null;
  }
}
