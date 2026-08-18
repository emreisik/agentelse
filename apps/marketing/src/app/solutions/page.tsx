import type { Metadata } from "next";
import { ArrowRight } from "lucide-react";
import Link from "next/link";

import { FinalCta } from "@/components/marketing/final-cta";
import { Reveal } from "@/components/marketing/reveal";
import { Section } from "@/components/marketing/section";
import { SOLUTIONS } from "@/components/marketing/solutions/solution-data";

export const metadata: Metadata = {
  title: "Solutions",
  description:
    "How Agentelse fits startups, SaaS companies, ecommerce, agencies and multi-brand companies.",
};

export default function SolutionsPage() {
  return (
    <>
      <Section className="pb-0">
        <Reveal className="flex flex-col gap-4">
          <p className="agentelse-text-caption font-medium text-muted-foreground uppercase">
            Solutions
          </p>
          <h1 className="agentelse-text-h1 max-w-[20ch] text-balance">
            Built for how you actually grow.
          </h1>
          <p className="agentelse-text-lead max-w-[56ch] text-muted-foreground">
            The department stack is the same underneath. How it's set up, what
            it prioritizes, and which plan fits, depends on the kind of company
            running it.
          </p>
        </Reveal>
      </Section>

      <Section>
        <Reveal>
          <div className="border-t border-border">
            {SOLUTIONS.map((solution) => (
              <Link
                key={solution.slug}
                href={`/solutions/${solution.slug}`}
                className="group flex items-center justify-between gap-6 border-b border-border py-8 transition-colors hover:bg-secondary/40 md:py-10"
              >
                <div className="flex flex-col gap-2">
                  <p className="agentelse-text-label font-medium text-muted-foreground uppercase">
                    {solution.audience}
                  </p>
                  <h2 className="agentelse-text-h3 max-w-[36ch] text-balance text-foreground">
                    {solution.headline}
                  </h2>
                </div>
                <ArrowRight className="size-5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-1 group-hover:text-foreground" />
              </Link>
            ))}
          </div>
        </Reveal>
      </Section>

      <FinalCta />
    </>
  );
}
