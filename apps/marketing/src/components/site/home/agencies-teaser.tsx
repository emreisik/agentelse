import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Section, SectionHeader } from "@/components/site/section";
import { Reveal } from "@/components/site/reveal";
import { BrandsMock } from "@/components/site/mock/brands-mock";

export function AgenciesTeaser() {
  return (
    <Section wide>
      <div className="grid items-center gap-12 overflow-hidden rounded-[2rem] border border-border bg-muted p-8 sm:p-12 lg:grid-cols-2 lg:gap-16 lg:p-16">
        <div className="flex flex-col gap-8">
          <SectionHeader
            eyebrow="For agencies"
            title="Many brands? One workspace."
            lead="Every client gets its own brain, style and calendar."
          />
          <Reveal>
            <Button
              className="h-11 px-6"
              nativeButton={false}
              render={<Link href="/agencies" />}
            >
              Agentelse for agencies
              <ArrowRight />
            </Button>
          </Reveal>
        </div>
        <Reveal delayMs={120}>
          <BrandsMock className="site-float mx-auto max-w-[420px] shadow-[var(--shadow-float)]" />
        </Reveal>
      </div>
    </Section>
  );
}
