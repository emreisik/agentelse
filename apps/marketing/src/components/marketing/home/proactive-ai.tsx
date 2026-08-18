import { Button } from "@/components/ui/button";
import { Reveal } from "@/components/marketing/reveal";
import { Section } from "@/components/marketing/section";
import { StatusPill } from "@/components/marketing/status-pill";
import { Timeline } from "@/components/marketing/timeline";

const EVENTS = [
  { id: "1", time: "08:12", title: "Competitor launches a new landing page." },
  { id: "2", time: "08:18", title: "Research detects the positioning change." },
  {
    id: "3",
    time: "08:24",
    title: "Search data shows related demand increasing.",
  },
  {
    id: "4",
    time: "08:31",
    title: "Opportunity Engine creates an opportunity.",
  },
  { id: "5", time: "08:39", title: "Creative and SEO prepare a response." },
  {
    id: "6",
    time: "08:46",
    title: "Agency Director requests approval.",
    emphasis: true,
  },
];

export function ProactiveAi() {
  return (
    <Section tone="raised">
      <Reveal className="grid gap-12 md:grid-cols-2 md:items-start">
        <div className="flex flex-col gap-4">
          <h2 className="agentelse-text-h2 max-w-[16ch] text-balance">
            It doesn&apos;t wait for a prompt.
          </h2>
          <p className="agentelse-text-lead max-w-[46ch] text-muted-foreground">
            Here&apos;s what happened one Tuesday morning.
          </p>
        </div>
        <div className="flex flex-col gap-8">
          <Timeline events={EVENTS} />
          <div className="rounded-xl border border-border bg-background p-5">
            <StatusPill tone="accent">Opportunity detected</StatusPill>
            <p className="mt-3 text-sm text-foreground">
              Competitor demand around &ldquo;AI customer onboarding&rdquo;
              increased 28% this month. We prepared a content and search
              strategy.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button type="button" variant="outline">
                Review
              </Button>
              <Button type="button" variant="default">
                Approve
              </Button>
              <Button type="button" variant="ghost">
                Dismiss
              </Button>
            </div>
          </div>
        </div>
      </Reveal>
    </Section>
  );
}
