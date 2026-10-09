// The one-line banner after Stripe sends the customer back, or after an action that
// has no page of its own (plan switch, cancel). Plain text from fixed strings only:
// nothing from the address is echoed.

type Params = Record<string, string | string[] | undefined>;

export type CheckoutReturn = "active" | "pending" | "unknown" | null;

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

export function bannerFor(
  params: Params,
  returned: CheckoutReturn,
): string | null {
  const checkout = first(params.checkout);
  const purchase = first(params.purchase);
  if (checkout === "cancelled") {
    return "Checkout was cancelled. Nothing was charged.";
  }
  if (purchase === "cancelled") {
    return "The purchase was cancelled. Nothing was charged.";
  }
  if (checkout === "success") {
    return returned === "active"
      ? "Payment received. Your plan is active."
      : "Payment received. It is still being confirmed; this page updates when it clears.";
  }
  if (purchase === "success") {
    return returned === "active"
      ? "Payment received. The extra usage was added to your balance."
      : "Payment received. The extra usage is added as soon as it clears.";
  }
  switch (first(params.notice)) {
    case "upgraded":
      return "Plan upgraded. The new plan is active now, and the extra usage was added to this month.";
    case "upgrade-processing":
      return "Your upgrade payment is processing. The new plan applies as soon as it clears.";
    case "downgrade-scheduled":
      return "Switch scheduled. You keep your current plan until your next renewal.";
    case "kept":
    case "unchanged":
      return "The scheduled switch was cancelled. You stay on your plan.";
    case "canceled":
      return "Subscription canceled. You keep access until the end of the paid period.";
    default:
      return null;
  }
}
