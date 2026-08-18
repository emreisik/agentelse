import type { Metadata } from "next";

import { PricingSection } from "@/components/marketing/pricing-section";
import { FinalCta } from "@/components/marketing/final-cta";
import { Section } from "@/components/marketing/section";
import { Reveal } from "@/components/marketing/reveal";

export const metadata: Metadata = {
  title: "Pricing",
  description: "Simple, usage-based pricing for your AI Growth Department.",
};

export default function PricingPage() {
  return (
    <>
      <Section className="pb-0">
        <Reveal className="flex flex-col gap-4">
          <p className="agentelse-text-caption font-medium text-muted-foreground uppercase">
            Pricing
          </p>
          <h1 className="agentelse-text-h1 max-w-[18ch] text-balance">
            One AI department. Priced like one hire, not five.
          </h1>
        </Reveal>
      </Section>
      <PricingSection variant="full" />
      <FinalCta />
    </>
  );
}
