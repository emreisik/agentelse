"use client";

import { Check, Tag } from "lucide-react";
import { useState } from "react";

import {
  changePlanAction,
  startCheckoutAction,
} from "@/server/actions/billing-actions";

import {
  displayedPrice,
  discountPercent,
  formatDay,
  formatUsd,
  type ComparisonRow,
  type Interval,
  type PlanCard,
} from "@/lib/billing/catalog";
import type { PlanPickerMode } from "@/lib/billing/picker-mode";
import type { PlanKey } from "@/lib/billing/plans";
import { cn } from "@/lib/utils";
import {
  BrandIcon,
  type BrandKey,
} from "@/components/integrations/brand-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { BillingActionButton } from "./billing-action-button";

// The platforms and data sources the product works with today (the same set the
// Integrations screen offers).
const WORKS_WITH: { brand: BrandKey; label: string }[] = [
  { brand: "instagram", label: "Instagram" },
  { brand: "facebook", label: "Facebook" },
  { brand: "meta-ads", label: "Meta Ads" },
  { brand: "ga4", label: "Google Analytics" },
  { brand: "search-console", label: "Search Console" },
];

const muted = { color: "var(--ws-text-2)" } as const;
const faint = { color: "var(--ws-text-3)" } as const;

const BLOCKED_NOTE = {
  "not-manager": "Only a workspace owner or admin can change the plan.",
  "past-due":
    "The last payment did not go through. Update the payment method in My subscription first.",
  ending:
    "Your subscription is set to end. Resume it in My subscription to change plans.",
} as const;

export function PlanPicker({
  cards,
  comparison,
  currentPlanKey,
  yearlyDiscountPct,
  mode,
}: {
  cards: PlanCard[];
  comparison: ComparisonRow[];
  currentPlanKey: PlanKey | null;
  yearlyDiscountPct: number;
  mode: PlanPickerMode;
}) {
  const lockedInterval: Interval | null =
    mode.kind === "change"
      ? mode.interval
      : mode.kind === "blocked"
        ? (mode.interval ?? null)
        : null;
  const [interval, setBilling] = useState<Interval>(lockedInterval ?? "month");
  const [firstMonthDiscount, setFirstMonthDiscount] = useState(false);
  const firstMonthAvailable =
    mode.kind === "subscribe"
      ? mode.firstMonthAvailable
      : mode.kind === "browse";
  const discountApplies = interval === "month";
  const showDiscountButton =
    mode.kind === "subscribe" || mode.kind === "browse";
  const paymentsOpen = mode.kind !== "browse";

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div
          role="group"
          aria-label="Billing interval"
          className="inline-flex w-fit rounded-lg p-[3px]"
          style={{ background: "var(--ws-surface-2)" }}
        >
          {(
            [
              ["month", "Monthly"],
              ["year", `Yearly · save ${yearlyDiscountPct}%`],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={interval === value}
              disabled={lockedInterval !== null && lockedInterval !== value}
              onClick={() => setBilling(value)}
              className={cn(
                "h-8 rounded-md px-3 text-[13px] font-medium disabled:opacity-40",
                interval === value ? "shadow-sm" : "",
              )}
              style={
                interval === value
                  ? { background: "var(--ws-surface)", color: "var(--ws-text)" }
                  : muted
              }
            >
              {label}
            </button>
          ))}
        </div>

        {showDiscountButton ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="lg"
              variant={
                firstMonthDiscount && discountApplies ? "secondary" : "default"
              }
              disabled={!discountApplies || !firstMonthAvailable}
              aria-pressed={firstMonthDiscount && discountApplies}
              onClick={() => setFirstMonthDiscount((value) => !value)}
            >
              <Tag />
              {firstMonthDiscount && discountApplies
                ? "First-month discount applied"
                : "Apply first-month discount"}
            </Button>
            <div className="flex items-center gap-1.5">
              <Input
                disabled
                aria-label="Promo code"
                placeholder="Promo code"
                className="h-9 w-32 text-[13px]"
              />
              <Button type="button" size="lg" variant="outline" disabled>
                Apply
              </Button>
            </div>
          </div>
        ) : null}
      </div>
      {showDiscountButton && !discountApplies ? (
        <p className="-mt-6 text-xs" style={faint}>
          The yearly price already includes {yearlyDiscountPct}% off; the
          first-month discount is for monthly billing.
        </p>
      ) : null}
      {showDiscountButton && !firstMonthAvailable ? (
        <p className="-mt-6 text-xs" style={faint}>
          The first-month discount is for a first subscription.
        </p>
      ) : null}
      {mode.kind === "change" ? (
        <p className="-mt-6 text-xs" style={faint}>
          Plan changes keep your billing interval (
          {mode.interval === "year" ? "yearly" : "monthly"}). An upgrade starts
          right away and charges the difference for the rest of this period; a
          downgrade starts at your next renewal
          {mode.renewsOn ? ` on ${formatDay(mode.renewsOn)}` : ""}.
        </p>
      ) : null}
      {mode.kind === "blocked" ? (
        <p className="-mt-6 text-xs" style={faint}>
          {BLOCKED_NOTE[mode.reason]}
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map((card) => {
          const shown = displayedPrice(card, { interval, firstMonthDiscount });
          const current = currentPlanKey === card.key;
          const off = shown.struckCents
            ? discountPercent(shown.struckCents, shown.perMonthCents)
            : 0;
          return (
            <div
              key={card.key}
              className="flex flex-col gap-4 rounded-[13px] border p-4"
              style={{
                borderColor: current ? "var(--ws-accent)" : "var(--ws-border)",
                background: "var(--ws-surface)",
                boxShadow: "var(--ws-card-shadow)",
              }}
            >
              <div className="flex items-center justify-between gap-2">
                <h3
                  className="font-heading text-sm font-semibold"
                  style={{ color: "var(--ws-text)" }}
                >
                  {card.label}
                </h3>
                {current ? (
                  <Badge variant="secondary">Current plan</Badge>
                ) : null}
              </div>

              <div>
                <div className="flex items-baseline gap-2">
                  <span
                    className="font-heading text-[28px] leading-none font-semibold tracking-tight"
                    style={{ color: "var(--ws-text)" }}
                  >
                    {formatUsd(shown.perMonthCents)}
                  </span>
                  <span className="text-xs" style={muted}>
                    /month
                  </span>
                  {shown.struckCents ? (
                    <span className="text-xs line-through" style={faint}>
                      {formatUsd(shown.struckCents)}
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 text-xs" style={faint}>
                  {shown.note}
                  {off > 0 ? ` · ${off}% off` : ""}
                </p>
              </div>

              <ul className="flex flex-col gap-1.5 text-[13px]">
                {[
                  `${card.imagesPerMonth} post images a month`,
                  `${formatUsd(card.aiUsageUsd * 100)} of AI assistant usage`,
                  `${card.brandLimit} ${card.brandLimit === 1 ? "brand" : "brands"}`,
                  card.fullAutomation
                    ? "Full background automation"
                    : "Limited background automation",
                ].map((line) => (
                  <li key={line} className="flex items-start gap-2">
                    <Check
                      className="mt-0.5 size-3.5 shrink-0"
                      style={{ color: "var(--ws-approved)" }}
                    />
                    <span style={{ color: "var(--ws-text-body)" }}>{line}</span>
                  </li>
                ))}
              </ul>

              <PlanButton
                card={card}
                cards={cards}
                mode={mode}
                interval={interval}
                useFirstMonthDiscount={
                  firstMonthDiscount && discountApplies && firstMonthAvailable
                }
                current={current}
              />
            </div>
          );
        })}
      </div>
      {!paymentsOpen ? (
        <p className="-mt-5 text-xs" style={faint}>
          Plans are not on sale yet. Your usage is being measured so the limits
          are fair when they start.
        </p>
      ) : null}
      {mode.kind === "subscribe" ? (
        <p className="-mt-5 text-xs" style={faint}>
          Payment is handled by Stripe. You can cancel any time; access
          continues to the end of the period you paid for.
        </p>
      ) : null}

      <div className="flex flex-col gap-2">
        <h3
          className="font-heading text-sm font-semibold"
          style={{ color: "var(--ws-text)" }}
        >
          Compare plans
        </h3>
        <div
          className="overflow-x-auto rounded-[13px] border"
          style={{ borderColor: "var(--ws-border)" }}
        >
          <table className="w-full min-w-[620px] text-[13px]">
            <thead>
              <tr style={{ background: "var(--ws-surface-2)" }}>
                <th
                  className="px-4 py-2.5 text-left font-medium"
                  style={muted}
                />
                {cards.map((card) => (
                  <th
                    key={card.key}
                    className="px-4 py-2.5 text-left font-medium"
                    style={{ color: "var(--ws-text)" }}
                  >
                    {card.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {comparison.map((row) => (
                <tr
                  key={row.id}
                  className="border-t"
                  style={{ borderColor: "var(--ws-border)" }}
                >
                  <td className="px-4 py-2.5" style={muted}>
                    {row.label}
                  </td>
                  {row.cells.map((cell, index) => (
                    <td
                      key={cards[index]!.key}
                      className="px-4 py-2.5"
                      style={{ color: "var(--ws-text-body)" }}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <h3
          className="font-heading text-sm font-semibold"
          style={{ color: "var(--ws-text)" }}
        >
          Works with
        </h3>
        <ul className="flex flex-wrap gap-2">
          {WORKS_WITH.map((item) => (
            <li
              key={item.brand}
              className="flex items-center gap-2 rounded-full border py-1 pr-3 pl-1.5 text-xs"
              style={{
                borderColor: "var(--ws-border)",
                color: "var(--ws-text-body)",
              }}
            >
              <BrandIcon brand={item.brand} className="size-5" />
              {item.label}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function PlanButton({
  card,
  cards,
  mode,
  interval,
  useFirstMonthDiscount,
  current,
}: {
  card: PlanCard;
  cards: PlanCard[];
  mode: PlanPickerMode;
  interval: Interval;
  useFirstMonthDiscount: boolean;
  current: boolean;
}) {
  const className = "mt-auto w-full";

  if (mode.kind === "browse" || mode.kind === "blocked") {
    return (
      <Button
        type="button"
        size="lg"
        variant={current ? "outline" : "default"}
        disabled
        className={className}
      >
        {current ? "Your plan" : `Choose ${card.label}`}
      </Button>
    );
  }

  if (mode.kind === "subscribe") {
    return (
      <BillingActionButton
        className={className}
        busyLabel="Opening checkout…"
        action={startCheckoutAction}
        input={{
          planKey: card.key,
          interval: interval === "year" ? "YEAR" : "MONTH",
          applyFirstMonth: useFirstMonthDiscount,
        }}
      >
        {`Subscribe to ${card.label}`}
      </BillingActionButton>
    );
  }

  // change
  const index = (key: PlanKey) => cards.findIndex((item) => item.key === key);
  const currentCard = cards[index(mode.planKey)];
  const renews = mode.renewsOn ? formatDay(mode.renewsOn) : "your next renewal";
  const doneHref = (kind?: string) =>
    `/billing?tab=subscription&notice=${encodeURIComponent(kind ?? "done")}`;

  if (card.key === mode.planKey) {
    if (!mode.pendingPlanKey) {
      return (
        <Button
          type="button"
          size="lg"
          variant="outline"
          disabled
          className={className}
        >
          Your plan
        </Button>
      );
    }
    const scheduled = cards[index(mode.pendingPlanKey)];
    return (
      <BillingActionButton
        className={className}
        variant="outline"
        busyLabel="Keeping…"
        confirm={{
          title: `Keep ${card.label}?`,
          description: `The scheduled switch to ${scheduled?.label ?? "the other plan"} is cancelled. You stay on ${card.label} and nothing is charged.`,
          confirmLabel: `Keep ${card.label}`,
        }}
        action={changePlanAction}
        input={{ planKey: card.key }}
        doneHref={(response) =>
          doneHref(response.kind === "unchanged" ? "kept" : response.kind)
        }
      >
        Keep this plan
      </BillingActionButton>
    );
  }

  if (card.key === mode.pendingPlanKey) {
    return (
      <Button
        type="button"
        size="lg"
        variant="outline"
        disabled
        className={className}
      >
        Starts {renews}
      </Button>
    );
  }

  const upgrade = index(card.key) > index(mode.planKey);
  return (
    <BillingActionButton
      className={className}
      variant={upgrade ? "default" : "outline"}
      busyLabel={upgrade ? "Upgrading…" : "Scheduling…"}
      confirm={
        upgrade
          ? {
              title: `Upgrade to ${card.label}?`,
              description: `${card.label} starts now. You are charged the difference for the rest of this billing period, and the extra usage is added to this month's allowance.`,
              confirmLabel: `Upgrade to ${card.label}`,
            }
          : {
              title: `Switch to ${card.label}?`,
              description: `You keep ${currentCard?.label ?? "your plan"} until ${renews}. After that ${card.label} applies at its price. Nothing is charged or refunded now.`,
              confirmLabel: `Switch at renewal`,
            }
      }
      action={changePlanAction}
      input={{ planKey: card.key }}
      doneHref={(response) => doneHref(response.kind)}
    >
      {upgrade ? `Upgrade to ${card.label}` : `Switch to ${card.label}`}
    </BillingActionButton>
  );
}
