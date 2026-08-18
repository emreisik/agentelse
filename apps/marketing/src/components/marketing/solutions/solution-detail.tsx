import { ArrowRight, Check } from "lucide-react";
import Link from "next/link";

import { FinalCta } from "@/components/marketing/final-cta";
import { Reveal } from "@/components/marketing/reveal";
import { Section } from "@/components/marketing/section";
import type { SolutionData } from "@/components/marketing/solutions/solution-data";

export function SolutionDetail({ solution }: { solution: SolutionData }) {
  const { audience, headline, problem, fit, highlightCapability } = solution;

  return (
    <>
      <header className="agentelse-section-y pb-0">
        <div className="agentelse-container">
          <Reveal className="flex max-w-[64ch] flex-col gap-4">
            <p className="agentelse-text-label font-medium text-muted-foreground uppercase">
              For {audience.toUpperCase()}
            </p>
            <h1 className="agentelse-text-h1 max-w-[22ch] text-balance">
              {headline}
            </h1>
            <p className="agentelse-text-lead max-w-[56ch] text-muted-foreground">
              {problem}
            </p>
          </Reveal>
        </div>
      </header>

      <Section>
        <Reveal>
          <h2 className="agentelse-text-h2 max-w-[24ch] text-balance">
            How Agentelse fits
          </h2>
        </Reveal>

        <Reveal delayMs={80} className="mt-10">
          <div className="border-t border-border">
            {fit.map((point) => (
              <div
                key={point}
                className="flex items-start gap-3 border-b border-border py-6"
              >
                <Check className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <p className="max-w-[60ch] text-base text-foreground/90">
                  {point}
                </p>
              </div>
            ))}
          </div>
        </Reveal>
      </Section>

      <Section tone="raised">
        <Reveal className="rounded-xl border border-border bg-background p-6 md:p-8">
          <p className="agentelse-text-label font-medium text-muted-foreground uppercase">
            The capability that matters most
          </p>
          <h3 className="agentelse-text-h3 mt-3 max-w-[28ch] text-balance">
            {highlightCapability.label}
          </h3>
          <p className="mt-3 max-w-[60ch] text-base text-foreground/80">
            {highlightCapability.description}
          </p>
        </Reveal>
      </Section>

      <Section>
        <Reveal className="flex flex-col gap-3">
          <p className="agentelse-text-lead max-w-[52ch] text-muted-foreground">
            Every plan runs the full department stack. Pick the one sized for
            how many brands you're running.
          </p>
          <Link
            href="/pricing"
            className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-foreground underline-offset-4 hover:underline"
          >
            See which plan fits
            <ArrowRight className="size-3.5" />
          </Link>
        </Reveal>
      </Section>

      <FinalCta />
    </>
  );
}
