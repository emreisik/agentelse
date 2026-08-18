import { PRICING_TIERS } from "@/components/marketing/pricing-data";
import { PricingCard } from "@/components/marketing/pricing-card";
import { Reveal } from "@/components/marketing/reveal";
import { Section } from "@/components/marketing/section";

export function PricingSection({
  variant = "full",
}: {
  variant?: "full" | "compact";
}) {
  return (
    <Section
      tone={variant === "full" ? "paper" : "raised"}
      id={variant === "full" ? undefined : "pricing"}
    >
      <Reveal className="flex flex-col gap-4">
        <h2 className="agentelse-text-h2 max-w-[20ch] text-balance">
          Pay for business output, not model tokens.
        </h2>
        <p className="agentelse-text-lead max-w-[52ch] text-muted-foreground">
          An AI Operation is meaningful work completed by Agentelse — research,
          analysis, content preparation or campaign planning.
        </p>
      </Reveal>
      <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {PRICING_TIERS.map((tier, i) => (
          <Reveal key={tier.id} delayMs={i * 60}>
            <PricingCard tier={tier} />
          </Reveal>
        ))}
      </div>
    </Section>
  );
}
