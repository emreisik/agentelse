// The one-line banner after Stripe sends the customer back, or after an action that
// has no page of its own (plan switch, cancel). Plain text from fixed strings only:
// nothing from the address is echoed.

type Params = Record<string, string | string[] | undefined>;

export type CheckoutReturn =
  | "active"
  | "pending"
  | "reversed"
  | "duplicate"
  | "problem"
  | "unknown"
  | null;

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

// A second subscription was paid while the first one is running: it was not applied (and
// is canceled so it cannot renew); the money is refunded by hand.
const DUPLICATE =
  "This workspace already has an active subscription, so this second payment was not applied and the extra subscription was canceled. Please contact hello@agentelse.ai to be refunded.";

// The payment arrived but cannot be applied by itself (a plan we do not recognise, records
// that disagree). Waiting does not help; a person has to look, so it says who.
const PROBLEM =
  "We received your payment but could not apply it to your plan automatically. Please contact hello@agentelse.ai and we will fix it.";

// Not a payment we can match to this workspace (another workspace's session, an old
// link, a payment outage): neutral, and it does not promise an update.
const UNMATCHED =
  "We could not match this payment to your workspace. If you were charged, it will appear in My subscription shortly.";

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
        return "Payment received. It is still being confirmed and will show in My subscription shortly.";
      case "reversed":
        return "This payment was refunded, so the plan was not activated.";
      case "duplicate":
        return DUPLICATE;
      case "problem":
        return PROBLEM;
      default:
        return UNMATCHED;
    }
  }
  if (purchase === "success") {
    switch (returned) {
      case "active":
        return "Payment received. The extra usage was added to your balance.";
      case "pending":
        return "Payment received. The extra usage is added as soon as it clears.";
      case "reversed":
        return "This payment was refunded, so no extra usage was added.";
      case "problem":
        return PROBLEM;
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
