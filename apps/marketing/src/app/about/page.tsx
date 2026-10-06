import type { Metadata } from "next";

import { CtaBand } from "@/components/site/cta-band";
import { PageHero } from "@/components/site/page-hero";
import { Reveal } from "@/components/site/reveal";
import { Section, SectionHeader } from "@/components/site/section";

export const metadata: Metadata = {
  title: "About",
  description:
    "Why we build Agentelse: a social media team for every brand, with you in charge.",
};

const PRINCIPLES = [
  {
    title: "You approve. Always.",
    body: "AI does the work. You make the calls.",
  },
  {
    title: "Your brand, not a template.",
    body: "Everything starts from what makes you, you.",
  },
  {
    title: "Honest about automation.",
    body: "We say what posts itself and what doesn't.",
  },
  {
    title: "Useful on day one.",
    body: "A website and a sentence. That's the setup.",
  },
];

export default function AboutPage() {
  return (
    <>
      <PageHero
        eyebrow="About"
        title="A content team for every brand."
        lead="Most brands should post more. Few have the time or the team. We fix that."
      />

      <Section className="pt-0 sm:pt-0">
        <Reveal className="mx-auto flex max-w-[56ch] flex-col gap-5 text-[18px] leading-relaxed text-foreground/85">
          <p>
            Social media is a dozen jobs: ideas, plans, captions, designs,
            posting on time and checking what worked. Small teams and busy
            agencies do it all in between everything else.
          </p>
          <p>
            Agentelse takes those jobs. It knows your brand, works where you can
            see it, and asks before anything reaches your audience.
          </p>
        </Reveal>
      </Section>

      <Section tone="muted" wide>
        <SectionHeader
          eyebrow="What we believe"
          title="How we build it."
          align="center"
          className="mx-auto mb-14"
        />
        <ul className="grid gap-px overflow-hidden rounded-[1.75rem] border border-border bg-border sm:grid-cols-2">
          {PRINCIPLES.map((principle, index) => (
            <li key={principle.title} className="bg-card">
              <Reveal
                delayMs={(index % 2) * 70}
                className="flex h-full flex-col gap-2.5 p-8 sm:p-10"
              >
                <span className="text-sm font-medium text-muted-foreground tabular-nums">
                  0{index + 1}
                </span>
                <p className="text-h3">{principle.title}</p>
                <p className="text-[15px] text-muted-foreground">
                  {principle.body}
                </p>
              </Reveal>
            </li>
          ))}
        </ul>
      </Section>

      <CtaBand />
    </>
  );
}
