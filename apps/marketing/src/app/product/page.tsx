import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, ArrowUpRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { appHref } from "@/lib/app-url";
import { AppKanbanShowcase } from "@/components/marketing/home/app-kanban-showcase";
import { FinalCta } from "@/components/marketing/final-cta";
import {
  FlowDiagram,
  radialPositions,
  type FlowEdge,
  type FlowNode,
} from "@/components/marketing/flow-diagram";
import { IntegrationIcons } from "@/components/marketing/integration-icons";
import { Reveal } from "@/components/marketing/reveal";
import { Section } from "@/components/marketing/section";
import {
  StatusPill,
  type StatusPillTone,
} from "@/components/marketing/status-pill";

export const metadata: Metadata = {
  title: "Product",
  description:
    "How Agentelse moves from signal to verified, measured execution — the full loop, the shared Brand Brain, permissions, and integrations.",
};

type LoopStage = {
  id: string;
  number: string;
  title: string;
  copy: string;
};

const LOOP_STAGES: LoopStage[] = [
  {
    id: "signal",
    number: "01",
    title: "Signal",
    copy: "Raw input: a keyword starts trending, a competitor changes their pricing page, rankings shift, traffic dips. Signals are cheap and constant — most turn out to be noise, which is exactly why nothing acts on one directly.",
  },
  {
    id: "insight",
    number: "02",
    title: "Insight",
    copy: "Every signal is read against the Brand Brain: is this relevant to this brand, in this market, right now. An insight is a signal with meaning attached.",
  },
  {
    id: "opportunity",
    number: "03",
    title: "Opportunity",
    copy: "Insights that clear a relevance bar get framed as something specific and sized enough to act on — the step where “something changed” becomes “here’s what we could do about it.”",
  },
  {
    id: "idea",
    number: "04",
    title: "Idea (multi-lens)",
    copy: "The Opportunity Engine and the relevant specialists — SEO, Creative, Social, Analytics — each look at the same opportunity through their own lens, so one opportunity can produce several distinct ideas instead of one generic response.",
  },
  {
    id: "council",
    number: "05",
    title: "Council evaluation",
    copy: "Before an idea becomes work, it’s checked against feasibility, brand fit, and risk. That’s a structured evaluation, not one agent deciding on its own.",
  },
  {
    id: "decision",
    number: "06",
    title: "Decision",
    copy: "The idea is approved, rejected, or sent back for revision, based on the council’s evaluation and the permission level you’ve set for that kind of work.",
  },
  {
    id: "work-plan",
    number: "07",
    title: "Work plan / Task",
    copy: "An approved idea becomes concrete tasks, each assigned to a department, with dependencies and a clear definition of done.",
  },
  {
    id: "execution",
    number: "08",
    title: "Execution",
    copy: "Departments carry the plan out — drafting, configuring, scheduling, publishing. Depending on your permissions, this runs automatically or waits for a person to approve it first.",
  },
  {
    id: "verification",
    number: "09",
    title: "Verification",
    copy: "Finished work is checked against what it was supposed to do before it counts as done — a published post is confirmed live, a fix is confirmed shipped.",
  },
  {
    id: "measurement",
    number: "10",
    title: "Measurement",
    copy: "Results are measured against the outcome that mattered, not just whether the task was completed — traffic, rankings, engagement, conversions.",
  },
  {
    id: "learning",
    number: "11",
    title: "Learning",
    copy: "What worked and what didn’t feeds back into the Brand Brain and shapes which signals get attention next time. The loop doesn’t stop at measurement — it closes back to Signal.",
  },
];

const LOOP_NODES: FlowNode[] = [
  { id: "signal", label: "Signal", kind: "signal", x: 7, y: 50 },
  { id: "insight", label: "Insight", kind: "node", x: 21, y: 50 },
  { id: "opportunity", label: "Opportunity", kind: "node", x: 36, y: 50 },
  { id: "idea", label: "Idea", kind: "coordination", x: 50, y: 50 },
  { id: "decision", label: "Decision", kind: "decision", x: 64, y: 50 },
  { id: "execution", label: "Execution", kind: "execution", x: 79, y: 50 },
  { id: "learning", label: "Learning", kind: "node", x: 93, y: 50 },
];

const LOOP_EDGES: FlowEdge[] = [
  { id: "signal-insight", from: "signal", to: "insight", animated: true },
  {
    id: "insight-opportunity",
    from: "insight",
    to: "opportunity",
    animated: true,
  },
  { id: "opportunity-idea", from: "opportunity", to: "idea", animated: true },
  { id: "idea-decision", from: "idea", to: "decision", animated: true },
  {
    id: "decision-execution",
    from: "decision",
    to: "execution",
    animated: true,
  },
  {
    id: "execution-learning",
    from: "execution",
    to: "learning",
    animated: true,
  },
];

type BrainInput = {
  id: string;
  label: string;
  sublabel: string;
  description: string;
};

const BRAIN_INPUTS: BrainInput[] = [
  {
    id: "brand",
    label: "Brand",
    sublabel: "Tone · Positioning",
    description:
      "Voice, tone, positioning, and the language a company actually uses to talk about itself.",
  },
  {
    id: "business",
    label: "Business",
    sublabel: "Products · Goals",
    description:
      "Products, pricing, audiences, and the goals growth work is measured against.",
  },
  {
    id: "knowledge",
    label: "Knowledge",
    sublabel: "History · Outcomes",
    description:
      "Past campaigns, decisions, and outcomes, so Agentelse doesn’t repeat what already failed or forget what worked.",
  },
  {
    id: "rules",
    label: "Rules",
    sublabel: "Approvals · Limits",
    description:
      "Approval thresholds, brand-safety boundaries, and anything that’s off-limits for every specialist.",
  },
  {
    id: "data",
    label: "Data",
    sublabel: "Analytics · CRM",
    description:
      "Live analytics, search performance, and CRM signals pulled in through your connected integrations.",
  },
];

const BRAIN_SATELLITE_POSITIONS = radialPositions(
  50,
  50,
  34,
  BRAIN_INPUTS.length,
);

const BRAIN_NODES: FlowNode[] = [
  { id: "brand-brain", label: "Brand Brain", kind: "hub", x: 50, y: 50 },
  ...BRAIN_INPUTS.map((input, i) => {
    const pos = BRAIN_SATELLITE_POSITIONS[i] ?? { x: 50, y: 50 };
    return {
      id: input.id,
      label: input.label,
      sublabel: input.sublabel,
      kind: "signal" as const,
      x: pos.x,
      y: pos.y,
    };
  }),
];

const BRAIN_EDGES: FlowEdge[] = BRAIN_INPUTS.map((input) => ({
  id: `${input.id}-brand-brain`,
  from: input.id,
  to: "brand-brain",
  animated: true,
}));

type PermissionLevel = {
  id: string;
  label: string;
  description: string;
};

const PERMISSION_LEVELS: PermissionLevel[] = [
  {
    id: "view",
    label: "View",
    description:
      "Agentelse surfaces findings, reports, and recommendations for a person to read. Nothing changes without you.",
  },
  {
    id: "create",
    label: "Create",
    description:
      "Drafts get built — briefs, content, campaign plans — and stored. Nothing goes live.",
  },
  {
    id: "recommend",
    label: "Recommend",
    description:
      "Agentelse proposes a specific next action and waits for a person to decide whether to act on it.",
  },
  {
    id: "approval",
    label: "Request approval",
    description:
      "The work is finished and ready to ship, but held until someone approves it.",
  },
  {
    id: "execute",
    label: "Execute",
    description:
      "Agentelse carries the action through on its own, inside the boundaries your rules set.",
  },
];

type PermissionExample = {
  id: string;
  action: string;
  requirement: string;
  tone: StatusPillTone;
};

const PERMISSION_EXAMPLES: PermissionExample[] = [
  {
    id: "seo-briefs",
    action: "SEO content briefs",
    requirement: "Automatic",
    tone: "neutral",
  },
  {
    id: "ad-budget",
    action: "Ad budget changes",
    requirement: "Approval required",
    tone: "accent",
  },
  {
    id: "instagram-publish",
    action: "Publishing to Instagram",
    requirement: "Approval required · verified after",
    tone: "accent",
  },
  {
    id: "competitor-research",
    action: "Competitor research",
    requirement: "Automatic",
    tone: "neutral",
  },
  {
    id: "new-integration",
    action: "Connecting a new integration",
    requirement: "Approval required",
    tone: "accent",
  },
];

export default function ProductPage() {
  return (
    <>
      <header className="pt-16 pb-14 md:pt-20 md:pb-16">
        <div className="agentelse-container-wide">
          <Reveal className="flex max-w-3xl flex-col gap-5">
            <h1 className="agentelse-text-h1 text-balance">
              How Agentelse works
            </h1>
            <p className="agentelse-text-lead max-w-[56ch] text-muted-foreground">
              One system takes a company from a raw signal to finished, verified
              work — automatically where it&rsquo;s safe, with your approval
              where it isn&rsquo;t.
            </p>
            <div className="mt-2 flex flex-wrap gap-3">
              <Button
                className="h-11 px-6"
                render={
                  <Link href={appHref("/login?callbackUrl=/dashboard")} />
                }
                nativeButton={false}
              >
                Start with your first brand
                <ArrowUpRight />
              </Button>
            </div>
          </Reveal>
        </div>
      </header>

      <Section id="loop">
        <Reveal>
          <h2 className="agentelse-text-h2 max-w-2xl text-foreground">
            The loop, in full.
          </h2>
          <p className="agentelse-text-lead mt-4 max-w-[60ch] text-muted-foreground">
            Everything Agentelse does moves through the same cycle — eleven
            stages between a raw signal and a measured, learned result.
          </p>
        </Reveal>

        <Reveal delayMs={100} className="mt-14 md:mt-16">
          <FlowDiagram
            nodes={LOOP_NODES}
            edges={LOOP_EDGES}
            viewBox={{ width: 1200, height: 200 }}
            ariaLabel="The Agentelse loop: Signal leads to Insight, Opportunity, Idea, Decision, and Execution, which is measured and produces Learning that feeds back into Signal."
          />
          <p className="agentelse-text-caption mt-6 text-muted-foreground">
            Learning feeds back into Signal — the loop doesn&rsquo;t stop once
            work ships.
          </p>
        </Reveal>

        <Reveal delayMs={160} className="mt-16 border-t border-border md:mt-20">
          {LOOP_STAGES.map((stage) => (
            <div
              key={stage.id}
              className="grid gap-2 border-b border-border py-6 sm:grid-cols-[2.5rem_minmax(0,11rem)_minmax(0,1fr)] sm:items-baseline sm:gap-6 md:py-7"
            >
              <span className="font-mono text-sm text-muted-foreground/50">
                {stage.number}
              </span>
              <h3 className="agentelse-text-label font-semibold text-foreground">
                {stage.title}
              </h3>
              <p className="max-w-[65ch] text-sm text-foreground/80">
                {stage.copy}
              </p>
            </div>
          ))}
        </Reveal>
      </Section>

      <Section id="brand-brain" tone="raised">
        <Reveal>
          <h2 className="agentelse-text-h2 max-w-2xl text-foreground">
            One brain for every specialist.
          </h2>
          <p className="agentelse-text-lead mt-4 max-w-[55ch] text-muted-foreground">
            Research, SEO, Creative, Social, and every other department read
            from the same understanding of your company before they act.
          </p>
        </Reveal>

        <Reveal
          delayMs={100}
          className="mt-14 grid gap-12 md:mt-16 md:grid-cols-2 md:items-center md:gap-16"
        >
          <FlowDiagram
            nodes={BRAIN_NODES}
            edges={BRAIN_EDGES}
            viewBox={{ width: 600, height: 600 }}
            ariaLabel="Five inputs — Brand, Business, Knowledge, Rules, and Data — flow into a shared Brand Brain at the center."
          />
          <dl className="flex flex-col gap-6">
            {BRAIN_INPUTS.map((input) => (
              <div key={input.id}>
                <dt className="agentelse-text-label font-semibold text-foreground">
                  {input.label}
                </dt>
                <dd className="mt-1 max-w-[52ch] text-sm text-foreground/80">
                  {input.description}
                </dd>
              </div>
            ))}
          </dl>
        </Reveal>

        <Reveal delayMs={180} className="mt-12 md:mt-16">
          <p className="max-w-[70ch] text-sm text-foreground/80">
            Because every specialist reads from the same Brand Brain, they
            don&rsquo;t contradict each other. A rule set once — a spend
            ceiling, a competitor you never name, a phrase that&rsquo;s
            off-brand — applies everywhere automatically, instead of being
            re-explained to every department separately.
          </p>
        </Reveal>
      </Section>

      <Section id="product-tour" className="pb-0">
        <Reveal className="flex max-w-2xl flex-col gap-4">
          <h2 className="agentelse-text-h2 text-foreground">
            See the real product.
          </h2>
          <p className="agentelse-text-lead text-muted-foreground">
            This is the actual Ideas board — the same view your team opens to
            see what Agentelse is working on.
          </p>
        </Reveal>
        <div className="mt-10 md:mt-14">
          <AppKanbanShowcase />
        </div>
      </Section>

      <Section id="human-control" tone="raised">
        <Reveal>
          <h2 className="agentelse-text-h2 max-w-2xl text-foreground">
            Autonomous doesn&rsquo;t mean uncontrolled.
          </h2>
          <p className="agentelse-text-lead mt-4 max-w-[55ch] text-muted-foreground">
            Every capability Agentelse has is set to one of five permission
            levels, and you choose the level for each kind of work.
          </p>
        </Reveal>

        <Reveal delayMs={100} className="mt-14 border-t border-border md:mt-16">
          {PERMISSION_LEVELS.map((level) => (
            <div
              key={level.id}
              className="grid gap-2 border-b border-border py-6 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)] sm:gap-8 md:py-7"
            >
              <h3 className="agentelse-text-label font-semibold text-foreground">
                {level.label}
              </h3>
              <p className="max-w-[60ch] text-sm text-foreground/80">
                {level.description}
              </p>
            </div>
          ))}
        </Reveal>

        <Reveal delayMs={160} className="mt-12 md:mt-16">
          <div className="border-t border-border">
            {PERMISSION_EXAMPLES.map((example) => (
              <div
                key={example.id}
                className="flex items-center justify-between gap-4 border-b border-border py-4"
              >
                <span className="text-sm text-foreground">
                  {example.action}
                </span>
                <StatusPill tone={example.tone}>
                  {example.requirement}
                </StatusPill>
              </div>
            ))}
          </div>
        </Reveal>

        <Reveal delayMs={200} className="mt-8">
          <p className="text-sm text-muted-foreground">
            See the full trust and security model on the{" "}
            <Link
              href="/security"
              className="text-foreground underline underline-offset-4 hover:text-muted-foreground"
            >
              Security page
            </Link>
            .
          </p>
        </Reveal>
      </Section>

      <Section id="departments">
        <Reveal className="flex max-w-2xl flex-col gap-6">
          <h2 className="agentelse-text-h2 text-foreground">
            Eight specialists, one coordinator.
          </h2>
          <p className="agentelse-text-lead max-w-[58ch] text-muted-foreground">
            Research, Idea Foundry, Creative, SEO, Social, Analytics, and the
            Opportunity Engine each run their own workflow. The Agency Director
            assigns work between them and keeps every department working from
            the same plan.
          </p>
          <div>
            <Button
              variant="outline"
              className="h-11 px-6"
              render={<Link href="/departments" />}
              nativeButton={false}
            >
              See every department
              <ArrowRight />
            </Button>
          </div>
        </Reveal>
      </Section>

      <Section id="integrations" tone="raised">
        <Reveal>
          <h2 className="agentelse-text-h2 max-w-2xl text-foreground">
            Connected to where the work already happens.
          </h2>
          <p className="agentelse-text-lead mt-4 max-w-[58ch] text-muted-foreground">
            Google Search Console and Analytics feed signal in, read-only. Meta
            publishes directly to Instagram and Facebook. Shopify, WordPress,
            HubSpot, Gmail, Telegram, and CRM systems are on the roadmap.
          </p>
        </Reveal>
        <Reveal delayMs={100} className="mt-14 md:mt-16">
          <IntegrationIcons />
        </Reveal>
      </Section>

      <FinalCta />
    </>
  );
}
