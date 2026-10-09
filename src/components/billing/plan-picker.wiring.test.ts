import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// What the plan buttons SEND, not what they show: the server action each one calls,
// the input it passes, the confirmation it asks for and where it goes afterwards.
// billing-screens.test.ts renders the markup only; the button's props never reach
// the markup, so a swapped interval, plan or action would pass it. The real
// BillingActionButton is replaced by a recorder; PlanPicker's own two useState
// calls (interval, discount toggle) can be seeded to reach the states a click leads to.

type Captured = {
  action: unknown;
  input: unknown;
  confirm?: { title: string; description: string; confirmLabel: string };
  doneHref?: unknown;
  children: unknown;
};

const seen = vi.hoisted(() => ({
  buttons: [] as Array<Record<string, unknown>>,
  initial: [] as unknown[],
}));

vi.mock("./billing-action-button", () => ({
  BillingActionButton: (props: Record<string, unknown>) => {
    seen.buttons.push(props);
    return null;
  },
}));
vi.mock("@/server/actions/billing-actions", () => ({
  startCheckoutAction: vi.fn(),
  startPackCheckoutAction: vi.fn(),
  openPortalAction: vi.fn(),
  cancelSubscriptionAction: vi.fn(),
  resumeSubscriptionAction: vi.fn(),
  changePlanAction: vi.fn(),
}));
vi.mock("react", async (importActual) => {
  const actual = await importActual<typeof import("react")>();
  return {
    ...actual,
    // Seeds the next useState (in call order) with a queued initial value.
    useState: (initial: unknown) =>
      actual.useState(seen.initial.length > 0 ? seen.initial.shift() : initial),
  };
});

import { comparisonRows, planCards } from "@/lib/billing/catalog";
import { YEARLY_DISCOUNT_PCT } from "@/lib/billing/plans";
import type { PlanPickerMode } from "@/lib/billing/picker-mode";
import {
  changePlanAction,
  startCheckoutAction,
} from "@/server/actions/billing-actions";

import { PlanPicker } from "./plan-picker";

function render(
  mode: PlanPickerMode,
  options: {
    currentPlanKey?: "starter" | "growth" | "business" | "agency" | null;
    // [interval, firstMonthDiscount] as the visitor left them
    state?: ["month" | "year", boolean];
  } = {},
) {
  seen.buttons.length = 0;
  seen.initial = options.state ? [...options.state] : [];
  renderToStaticMarkup(
    createElement(PlanPicker, {
      cards: planCards(),
      comparison: comparisonRows(),
      currentPlanKey: options.currentPlanKey ?? null,
      yearlyDiscountPct: YEARLY_DISCOUNT_PCT,
      mode,
    }),
  );
  return seen.buttons as unknown as Captured[];
}

const labelOf = (button: Captured) => String(button.children);

beforeEach(() => {
  seen.buttons.length = 0;
  seen.initial = [];
});

describe("Subscribe buttons", () => {
  const subscribe = (firstMonthAvailable: boolean): PlanPickerMode => ({
    kind: "subscribe",
    firstMonthAvailable,
  });

  it("send the card's own plan, monthly, without the discount, to the checkout action", () => {
    const buttons = render(subscribe(true));

    expect(buttons).toHaveLength(4);
    expect(buttons.map((button) => button.action)).toEqual(
      Array(4).fill(startCheckoutAction),
    );
    expect(buttons.map((button) => button.input)).toEqual(
      planCards().map((card) => ({
        planKey: card.key,
        interval: "MONTH",
        applyFirstMonth: false,
      })),
    );
    // Nothing asks for a confirmation or navigates: the action returns Stripe's address.
    for (const button of buttons) {
      expect(button.confirm).toBeUndefined();
      expect(button.doneHref).toBeUndefined();
    }
  });

  it("yearly sends YEAR, and a discount toggled on before switching to yearly is NOT sent", () => {
    const yearly = render(subscribe(true), { state: ["year", false] });
    expect(
      yearly.map((button) => (button.input as { interval: string }).interval),
    ).toEqual(Array(4).fill("YEAR"));

    const yearlyWithDiscountOn = render(subscribe(true), {
      state: ["year", true],
    });
    expect(
      yearlyWithDiscountOn.map(
        (button) =>
          (button.input as { applyFirstMonth: boolean }).applyFirstMonth,
      ),
    ).toEqual(Array(4).fill(false));
  });

  it("the discount is sent only monthly, only when toggled on, and only when it is offered", () => {
    const on = render(subscribe(true), { state: ["month", true] });
    expect(
      on.map(
        (button) =>
          (button.input as { applyFirstMonth: boolean }).applyFirstMonth,
      ),
    ).toEqual(Array(4).fill(true));

    const notOffered = render(subscribe(false), { state: ["month", true] });
    expect(
      notOffered.map(
        (button) =>
          (button.input as { applyFirstMonth: boolean }).applyFirstMonth,
      ),
    ).toEqual(Array(4).fill(false));
  });
});

describe("plan change buttons", () => {
  const change = (pendingPlanKey: "growth" | null = null): PlanPickerMode => ({
    kind: "change",
    planKey: "business",
    interval: "month",
    pendingPlanKey,
    renewsOn: "2026-12-01T00:00:00.000Z",
  });

  it("send the card's plan to the change action; an upgrade asks first, and says it charges", () => {
    const buttons = render(change(), { currentPlanKey: "business" });

    // starter, growth (below) and agency (above); the current plan has no live button.
    expect(
      buttons.map((button) => (button.input as { planKey: string }).planKey),
    ).toEqual(["starter", "growth", "agency"]);
    expect(buttons.map((button) => button.action)).toEqual(
      Array(3).fill(changePlanAction),
    );
    const [starter, growth, agency] = buttons;
    expect(labelOf(starter!)).toBe("Switch to Starter");
    expect(labelOf(growth!)).toBe("Switch to Growth");
    expect(labelOf(agency!)).toBe("Upgrade to Agency");
    // Every one of them asks before it acts, and the upgrade says the card is charged.
    for (const button of buttons) expect(button.confirm).toBeDefined();
    expect(agency!.confirm).toMatchObject({
      title: "Upgrade to Agency?",
      confirmLabel: "Upgrade to Agency",
    });
    expect(agency!.confirm!.description).toMatch(/charged the difference/);
    expect(starter!.confirm).toMatchObject({
      title: "Switch to Starter?",
      confirmLabel: "Switch at renewal",
    });
    expect(starter!.confirm!.description).toMatch(
      /Nothing is charged or refunded now/,
    );
  });

  it("sends the visitor to the page that explains what happened", () => {
    const buttons = render(change(), { currentPlanKey: "business" });
    const done = (button: Captured, kind: string) =>
      (button.doneHref as (response: { ok: true; kind: string }) => string)({
        ok: true,
        kind,
      });
    const [starter, , agency] = buttons;

    expect(done(agency!, "upgraded")).toBe(
      "/billing?tab=subscription&notice=upgraded",
    );
    expect(done(agency!, "upgrade-processing")).toBe(
      "/billing?tab=subscription&notice=upgrade-processing",
    );
    expect(done(starter!, "downgrade-scheduled")).toBe(
      "/billing?tab=subscription&notice=downgrade-scheduled",
    );
  });

  it("keeping the paid plan after a scheduled downgrade sends THAT plan back, with a confirmation", () => {
    const buttons = render(change("growth"), { currentPlanKey: "business" });

    const keep = buttons.find(
      (button) => labelOf(button) === "Keep this plan",
    )!;
    expect(keep.action).toBe(changePlanAction);
    expect(keep.input).toEqual({ planKey: "business" });
    expect(keep.confirm).toMatchObject({
      title: "Keep Business?",
      confirmLabel: "Keep Business",
    });
    expect(keep.confirm!.description).toMatch(/nothing is charged/);
    const done = keep.doneHref as (response: {
      ok: true;
      kind: string;
    }) => string;
    // The button reports what actually happened: a scheduled switch that was canceled,
    // or (stale tab) nothing to do because the workspace is already on that plan.
    expect(done({ ok: true, kind: "switch-cancelled" })).toBe(
      "/billing?tab=subscription&notice=switch-cancelled",
    );
    expect(done({ ok: true, kind: "unchanged" })).toBe(
      "/billing?tab=subscription&notice=unchanged",
    );
    // The scheduled plan has no live button of its own.
    expect(
      buttons.some(
        (button) => (button.input as { planKey?: string }).planKey === "growth",
      ),
    ).toBe(false);
  });

  it("a yearly subscription keeps its interval: the toggle starts on yearly", () => {
    const markup = renderToStaticMarkup(
      createElement(PlanPicker, {
        cards: planCards(),
        comparison: comparisonRows(),
        currentPlanKey: "business",
        yearlyDiscountPct: YEARLY_DISCOUNT_PCT,
        mode: {
          kind: "change",
          planKey: "business",
          interval: "year",
          pendingPlanKey: null,
          renewsOn: "2026-12-01T00:00:00.000Z",
        },
      }),
    );

    expect(markup).toMatch(/aria-pressed="true"[^>]*>Yearly/);
    expect(markup).toMatch(/aria-pressed="false"[^>]*disabled=""[^>]*>Monthly/);
  });
});
