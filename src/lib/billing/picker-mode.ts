import type { Interval } from "./catalog";
import type { PlanKey } from "./plans";

// What the plan buttons do, decided on the server (the client only shows it).
//  browse     payments are not open: look and compare only.
//  subscribe  no paying subscription: a button opens Stripe Checkout.
//  change     a paying subscription: switch plans (the interval stays).
//  blocked    the buttons are off, with the reason shown (also a workspace that
//             has full access, where there is nothing to buy).
export type PlanPickerMode =
  | { kind: "browse" }
  | { kind: "subscribe"; firstMonthAvailable: boolean }
  | {
      kind: "change";
      planKey: PlanKey;
      interval: Interval;
      pendingPlanKey: PlanKey | null;
      renewsOn: string | null;
    }
  | {
      kind: "blocked";
      reason: "not-manager" | "past-due" | "ending" | "full-access";
      interval?: Interval;
    };

export type PickerSubscription = {
  planKey: PlanKey | null;
  interval: "MONTH" | "YEAR" | null;
  status: string;
  paidThrough: string | null;
  cancelAtPeriodEnd: boolean;
  pendingPlanKey: PlanKey | null;
  stripeLinked: boolean;
  introOffer: boolean;
  // Permanent full access (internal / demo accounts): nothing to buy.
  exempt: boolean;
};

const intervalOf = (value: "MONTH" | "YEAR" | null): Interval | undefined =>
  value === "YEAR" ? "year" : value === "MONTH" ? "month" : undefined;

export function pickerModeFor(input: {
  paymentsOpen: boolean;
  canManage: boolean;
  subscription: PickerSubscription | null;
}): PlanPickerMode {
  const { subscription: sub } = input;
  if (!input.paymentsOpen) return { kind: "browse" };
  if (!input.canManage) {
    return {
      kind: "blocked",
      reason: "not-manager",
      interval: sub?.stripeLinked ? intervalOf(sub.interval) : undefined,
    };
  }

  if (sub?.exempt) {
    return { kind: "blocked", reason: "full-access" };
  }

  const paying =
    sub?.stripeLinked === true &&
    (sub.status === "ACTIVE" || sub.status === "PAST_DUE");
  if (paying && sub) {
    const interval = intervalOf(sub.interval);
    if (sub.status === "PAST_DUE") {
      return { kind: "blocked", reason: "past-due", interval };
    }
    if (sub.cancelAtPeriodEnd) {
      return { kind: "blocked", reason: "ending", interval };
    }
    if (sub.planKey && interval) {
      return {
        kind: "change",
        planKey: sub.planKey,
        interval,
        pendingPlanKey: sub.pendingPlanKey,
        renewsOn: sub.paidThrough,
      };
    }
  }

  return {
    kind: "subscribe",
    // The first-month discount is offered once, to a workspace that never paid.
    firstMonthAvailable: !sub?.stripeLinked && !sub?.introOffer,
  };
}
