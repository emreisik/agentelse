import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { START_HREF } from "@/lib/site";
import { Button } from "@/components/ui/button";
import { Reveal } from "@/components/site/reveal";
import { Spark } from "@/components/site/section";

export function CtaBand({
  title = "Your next post is one sentence away.",
  lead = "Free during early access. No credit card.",
}: {
  title?: string;
  lead?: string;
}) {
  return (
    <section className="site-section">
      <div className="site-container">
        <Reveal className="relative overflow-hidden rounded-[2rem] bg-primary px-6 py-16 text-center text-primary-foreground sm:px-12 sm:py-20">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 opacity-70"
            style={{
              background:
                "radial-gradient(50% 70% at 50% 0%, oklch(0.6 0.22 293 / 0.35), transparent 70%)",
            }}
          />
          <div className="relative flex flex-col items-center gap-6">
            <Spark className="size-6 text-[oklch(0.78_0.14_293)]" />
            <h2 className="text-h2 max-w-[18ch] text-balance">{title}</h2>
            <p className="max-w-[48ch] text-pretty text-primary-foreground/70">
              {lead}
            </p>
            <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
              <Button
                className="h-11 bg-primary-foreground px-6 text-primary hover:bg-primary-foreground/90"
                nativeButton={false}
                render={<Link href={START_HREF} />}
              >
                Start free
                <ArrowRight />
              </Button>
              <Button
                variant="ghost"
                className="h-11 px-6 text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground"
                nativeButton={false}
                render={<Link href="/contact" />}
              >
                Talk to us
              </Button>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
