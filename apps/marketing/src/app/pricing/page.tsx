import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Check } from "lucide-react";

import { START_HREF } from "@/lib/site";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Faq, type FaqItem } from "@/components/site/faq";
import { PageHero } from "@/components/site/page-hero";
import { Reveal } from "@/components/site/reveal";
import { Spark } from "@/components/site/section";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "Agentelse is free during early access. Every feature, no credit card.",
};

const PLANS = [
  {
    name: "Early access",
    price: "$0",
    suffix: "during early access",
    description: "For brands that want a content team.",
    features: [
      "Chat, plans and posts",
      "Brand Brain and style kit",
      "Instagram and Facebook publishing",
      "Calendar, Outputs and results",
      "Meta Ads, Analytics, Search Console",
      "Telegram approvals",
      "14 languages",
    ],
    cta: { label: "Start free", href: START_HREF },
    featured: true,
  },
  {
    name: "Agencies",
    price: "Let's talk",
    suffix: "",
    description: "For many client brands.",
    features: [
      "Everything in early access",
      "A separate brand per client",
      "Help setting up your clients",
      "A direct line to our team",
    ],
    cta: { label: "Talk to us", href: "/contact" },
    featured: false,
  },
];

const FAQ: FaqItem[] = [
  {
    question: "Is it really free?",
    answer: "Yes. Every feature is free during early access.",
  },
  {
    question: "Any limits?",
    answer:
      "Fair daily AI limits per brand. You can see and change them in settings.",
  },
  {
    question: "Do I need a card?",
    answer: "No. Nothing to enter, nothing to cancel.",
  },
  {
    question: "What happens after early access?",
    answer:
      "Paid plans will come, and you'll hear well in advance. We never charge automatically: we don't hold your card.",
  },
];

export default function PricingPage() {
  return (
    <>
      <PageHero
        eyebrow="Pricing"
        title="Free during early access."
        lead="Every feature. No credit card."
      />

      <section className="pb-8">
        <div className="site-container grid gap-5 md:grid-cols-2">
          {PLANS.map((plan, index) => (
            <Reveal key={plan.name} delayMs={index * 90}>
              <div
                className={cn(
                  "flex h-full flex-col gap-7 rounded-[1.75rem] border p-8 sm:p-10",
                  plan.featured
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-card",
                )}
              >
                <div className="flex flex-col gap-3">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    {plan.featured ? (
                      <Spark className="text-[oklch(0.78_0.14_293)]" />
                    ) : null}
                    {plan.name}
                  </p>
                  <p className="flex items-baseline gap-2">
                    <span className="text-h1">{plan.price}</span>
                    {plan.suffix ? (
                      <span
                        className={cn(
                          "text-sm",
                          plan.featured
                            ? "text-primary-foreground/60"
                            : "text-muted-foreground",
                        )}
                      >
                        {plan.suffix}
                      </span>
                    ) : null}
                  </p>
                  <p
                    className={cn(
                      "text-[15px]",
                      plan.featured
                        ? "text-primary-foreground/70"
                        : "text-muted-foreground",
                    )}
                  >
                    {plan.description}
                  </p>
                </div>
                <ul className="flex flex-1 flex-col gap-3">
                  {plan.features.map((feature) => (
                    <li
                      key={feature}
                      className="flex items-start gap-3 text-[15px]"
                    >
                      <Check
                        className={cn(
                          "mt-0.5 size-4 shrink-0",
                          plan.featured
                            ? "text-[oklch(0.78_0.14_293)]"
                            : "text-foreground",
                        )}
                      />
                      {feature}
                    </li>
                  ))}
                </ul>
                <Button
                  className={cn(
                    "h-12 w-full",
                    plan.featured &&
                      "bg-primary-foreground text-primary hover:bg-primary-foreground/90",
                  )}
                  variant={plan.featured ? "default" : "secondary"}
                  nativeButton={false}
                  render={<Link href={plan.cta.href} />}
                >
                  {plan.cta.label}
                  <ArrowRight />
                </Button>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      <Faq items={FAQ} title="Pricing questions." />
    </>
  );
}
