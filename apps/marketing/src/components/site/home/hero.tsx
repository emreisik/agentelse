import Link from "next/link";
import { ArrowRight, ChevronRight } from "lucide-react";

import { START_HREF } from "@/lib/site";
import { Button } from "@/components/ui/button";
import { Reveal } from "@/components/site/reveal";
import { Spark } from "@/components/site/section";
import { HeroDemo } from "@/components/site/hero/hero-demo";

export function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div
        aria-hidden="true"
        className="hero-bg pointer-events-none absolute inset-0"
      />
      <div
        aria-hidden="true"
        className="hero-grid pointer-events-none absolute inset-0"
      />

      <div className="site-container-wide relative flex flex-col items-center pt-12 pb-20 sm:pt-20 md:pb-28">
        <Reveal className="flex flex-col items-center text-center">
          <Link
            href="/pricing"
            className="group inline-flex items-center gap-2 rounded-full border border-border bg-background/80 py-1 pr-2.5 pl-3 text-[13px] font-medium shadow-[var(--shadow-card)] backdrop-blur transition-colors hover:border-foreground/20"
          >
            <Spark />
            Free during early access
            <ChevronRight className="size-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
          </Link>

          <h1 className="text-display mt-7 max-w-[12ch] text-balance">
            Your AI social media team<span className="text-spark">.</span>
          </h1>

          <p className="text-lead mt-6 max-w-[40ch] text-pretty text-muted-foreground">
            It plans, designs and publishes your posts. You just approve.
          </p>

          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <Button
              className="h-12 px-7 text-[15px]"
              nativeButton={false}
              render={<Link href={START_HREF} />}
            >
              Start free
              <ArrowRight />
            </Button>
            <Button
              variant="secondary"
              className="h-12 px-7 text-[15px]"
              nativeButton={false}
              render={<Link href="/contact" />}
            >
              Talk to us
            </Button>
          </div>
        </Reveal>

        <Reveal delayMs={150} className="mt-16 w-full max-w-[1180px] sm:mt-20">
          <HeroDemo />
        </Reveal>
      </div>
    </section>
  );
}
