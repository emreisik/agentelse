"use client";

import { Check, Tag } from "lucide-react";
import { useState } from "react";

import {
  displayedPrice,
  discountPercent,
  formatUsd,
  type ComparisonRow,
  type Interval,
  type PlanCard,
} from "@/lib/billing/catalog";
import type { PlanKey } from "@/lib/billing/plans";
import { cn } from "@/lib/utils";
import {
  BrandIcon,
  type BrandKey,
} from "@/components/integrations/brand-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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

export function PlanPicker({
  cards,
  comparison,
  currentPlanKey,
  yearlyDiscountPct,
  paymentsOpen,
}: {
  cards: PlanCard[];
  comparison: ComparisonRow[];
  currentPlanKey: PlanKey | null;
  yearlyDiscountPct: number;
  // False until payments are connected: choosing a plan is not possible yet, and
  // the screen says so instead of offering a button that does nothing.
  paymentsOpen: boolean;
}) {
  const [interval, setBilling] = useState<Interval>("month");
  const [firstMonthDiscount, setFirstMonthDiscount] = useState(false);
  const discountApplies = interval === "month";

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
              onClick={() => setBilling(value)}
              className={cn(
                "h-8 rounded-md px-3 text-[13px] font-medium",
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

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="lg"
            variant={
              firstMonthDiscount && discountApplies ? "secondary" : "default"
            }
            disabled={!discountApplies}
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
      </div>
      {!discountApplies ? (
        <p className="-mt-6 text-xs" style={faint}>
          The yearly price already includes {yearlyDiscountPct}% off; the
          first-month discount is for monthly billing.
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

              <Button
                type="button"
                size="lg"
                variant={current ? "outline" : "default"}
                disabled={!paymentsOpen || current}
                className="mt-auto w-full"
              >
                {current ? "Your plan" : `Choose ${card.label}`}
              </Button>
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
