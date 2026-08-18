import Link from "next/link";
import { Check } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { PricingTier } from "@/components/marketing/pricing-data";

export function PricingCard({ tier }: { tier: PricingTier }) {
  return (
    <div
      className={cn(
        "flex h-full flex-col gap-6 rounded-xl border p-6",
        tier.highlighted
          ? "border-[var(--agentelse-accent)] bg-background shadow-[0_1px_0_rgba(0,0,0,0.02)] ring-1 ring-[var(--agentelse-accent)]/25"
          : "border-border bg-background",
      )}
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-foreground">{tier.name}</p>
          {tier.badge ? (
            <span className="agentelse-text-caption rounded-full bg-[var(--agentelse-accent)] px-2 py-0.5 font-medium text-[var(--agentelse-accent-foreground)] uppercase">
              {tier.badge}
            </span>
          ) : null}
        </div>
        <div className="flex items-baseline gap-1">
          <span className="agentelse-text-h2">{tier.price}</span>
          {tier.priceSuffix ? (
            <span className="text-sm text-muted-foreground">
              {tier.priceSuffix}
            </span>
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground">{tier.description}</p>
      </div>

      <ul className="flex flex-1 flex-col gap-2.5">
        {tier.features.map((feature) => (
          <li
            key={feature}
            className="flex items-start gap-2 text-sm text-foreground"
          >
            <Check className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            {feature}
          </li>
        ))}
      </ul>

      <Button
        variant={tier.highlighted ? "default" : "outline"}
        className="h-10 w-full"
        render={<Link href={tier.cta.href} />}
        nativeButton={false}
      >
        {tier.cta.label}
      </Button>
    </div>
  );
}
