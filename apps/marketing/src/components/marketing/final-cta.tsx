import Link from "next/link";

import { Button } from "@/components/ui/button";
import { appHref } from "@/lib/app-url";
import { Reveal } from "@/components/marketing/reveal";
import { Section } from "@/components/marketing/section";

export function FinalCta() {
  return (
    <Section tone="paper" className="border-t border-border">
      <Reveal className="flex flex-col items-start gap-6">
        <h2 className="agentelse-text-h2 max-w-[16ch] text-balance">
          Build the department your company is missing.
        </h2>
        <p className="agentelse-text-lead max-w-[46ch] text-muted-foreground">
          Start with one brand. Let Agentelse learn how your company grows.
        </p>
        <div className="flex flex-wrap gap-3">
          <Button
            className="h-11 px-6"
            render={<Link href={appHref("/register")} />}
            nativeButton={false}
          >
            Start with your first brand
          </Button>
          <Button
            variant="outline"
            className="h-11 px-6"
            render={<Link href="/contact" />}
            nativeButton={false}
          >
            Book a demo
          </Button>
        </div>
      </Reveal>
    </Section>
  );
}
