import { Section, SectionHeader } from "@/components/site/section";
import { Reveal } from "@/components/site/reveal";
import {
  ApproveVisual,
  PlanVisual,
  WebsiteVisual,
} from "@/components/site/home/step-visuals";

const STEPS = [
  {
    title: "Add your website.",
    body: "Logo, colors and voice in seconds.",
    Visual: WebsiteVisual,
  },
  {
    title: "Ask for a plan.",
    body: "One sentence. Every channel.",
    Visual: PlanVisual,
  },
  { title: "Approve.", body: "It posts on time.", Visual: ApproveVisual },
];

export function Steps() {
  return (
    <Section id="how-it-works" wide>
      <SectionHeader
        eyebrow="How it works"
        title="Up and running in minutes."
        align="center"
        className="mx-auto mb-14 md:mb-16"
      />
      <ol className="grid gap-4 md:grid-cols-3">
        {STEPS.map(({ title, body, Visual }, index) => (
          <li key={title}>
            <Reveal
              delayMs={index * 90}
              className="flex h-full flex-col overflow-hidden rounded-[1.75rem] border border-border bg-card"
            >
              <div className="site-grid flex h-[220px] items-center justify-center border-b border-border bg-muted px-6">
                <Visual />
              </div>
              <div className="flex flex-col gap-1.5 p-7">
                <span className="text-sm font-medium text-muted-foreground tabular-nums">
                  0{index + 1}
                </span>
                <p className="text-h3">{title}</p>
                <p className="text-[15px] text-muted-foreground">{body}</p>
              </div>
            </Reveal>
          </li>
        ))}
      </ol>
    </Section>
  );
}
