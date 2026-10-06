import { Check } from "lucide-react";

import { cn } from "@/lib/utils";
import { Section, SectionHeader } from "@/components/site/section";
import { Reveal } from "@/components/site/reveal";

// A chapter of a page: a short headline and three short points on one side,
// the product on the other, sides swapping with `reverse`.
export function FeatureSplit({
  id,
  eyebrow,
  title,
  lead,
  points,
  mock,
  reverse = false,
  tone = "plain",
}: {
  id?: string;
  eyebrow: string;
  title: string;
  lead?: string;
  points: string[];
  mock: React.ReactNode;
  reverse?: boolean;
  tone?: "plain" | "muted";
}) {
  return (
    <Section id={id} tone={tone} wide>
      <div className="grid items-center gap-12 lg:grid-cols-[0.9fr_1.1fr] lg:gap-20">
        <div className={cn("flex flex-col gap-8", reverse && "lg:order-2")}>
          <SectionHeader eyebrow={eyebrow} title={title} lead={lead} />
          <Reveal>
            <ul className="flex flex-col gap-3.5">
              {points.map((point) => (
                <li
                  key={point}
                  className="flex items-center gap-3 text-[16px] font-medium"
                >
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-spark-soft text-spark">
                    <Check className="size-3" />
                  </span>
                  {point}
                </li>
              ))}
            </ul>
          </Reveal>
        </div>
        <Reveal delayMs={120} className={cn(reverse && "lg:order-1")}>
          <div className="site-grid flex justify-center rounded-[1.75rem] border border-border bg-muted p-5 sm:p-10">
            {mock}
          </div>
        </Reveal>
      </div>
    </Section>
  );
}

// A product pane shown on its own: the demo's panel in a window-like frame.
export function PaneFrame({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "h-[520px] w-full max-w-[380px] overflow-hidden rounded-[20px] border border-border bg-muted text-left shadow-[var(--shadow-float)]",
        className,
      )}
    >
      {children}
    </div>
  );
}
