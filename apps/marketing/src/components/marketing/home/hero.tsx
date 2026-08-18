import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { appHref } from "@/lib/app-url";
import { Reveal } from "@/components/marketing/reveal";
import { IntegrationIcons } from "@/components/marketing/integration-icons";

export function Hero() {
  return (
    <header className="pt-16 pb-14 md:pt-20 md:pb-16">
      <div className="agentelse-container-wide flex flex-col items-center">
        <Reveal className="flex w-full flex-col items-center text-center">
          <h1 className="agentelse-text-display mx-auto max-w-[20ch] text-balance">
            <span className="block">Your growth department.</span>
            <span className="block">Now autonomous.</span>
          </h1>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Button
              className="h-11 px-6"
              render={<Link href={appHref("/login?callbackUrl=/dashboard")} />}
              nativeButton={false}
            >
              Start with your first brand
              <ArrowUpRight />
            </Button>
            <Button
              variant="secondary"
              className="h-11 px-6"
              render={<Link href="/contact" />}
              nativeButton={false}
            >
              Contact sales
            </Button>
          </div>
        </Reveal>
        <Reveal delayMs={120} className="mt-16 w-full md:mt-20">
          <IntegrationIcons />
        </Reveal>
      </div>
    </header>
  );
}
