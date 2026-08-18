import { ArrowRight } from "lucide-react";

import { Reveal } from "@/components/marketing/reveal";
import { Section } from "@/components/marketing/section";
import {
  StatusPill,
  type StatusPillTone,
} from "@/components/marketing/status-pill";

type PermissionLevel = {
  id: string;
  label: string;
};

const PERMISSION_LEVELS: PermissionLevel[] = [
  { id: "view", label: "View" },
  { id: "create", label: "Create" },
  { id: "recommend", label: "Recommend" },
  { id: "approval", label: "Request approval" },
  { id: "execute", label: "Execute" },
];

type ExampleRow = {
  id: string;
  action: string;
  requirement: string;
  tone: StatusPillTone;
};

const EXAMPLES: ExampleRow[] = [
  {
    id: "social-posts",
    action: "Social posts",
    requirement: "Approval required",
    tone: "accent",
  },
  {
    id: "seo-briefs",
    action: "SEO briefs",
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
    id: "weekly-reports",
    action: "Weekly reports",
    requirement: "Automatic",
    tone: "neutral",
  },
  {
    id: "crm-updates",
    action: "CRM updates",
    requirement: "Allowed",
    tone: "neutral",
  },
];

// Two calm, plain compositions rather than a technical permissions table:
// a horizontal spectrum of pill + arrow, and a simple divided list. Nothing
// here should read as a settings screen — it's reassurance, not a feature.
export function HumanControl() {
  return (
    <Section tone="raised">
      <Reveal>
        <h2 className="agentelse-text-h2 max-w-2xl text-foreground">
          Autonomous doesn&rsquo;t mean uncontrolled.
        </h2>
        <p className="agentelse-text-lead mt-4 max-w-[50ch] text-muted-foreground">
          You decide what Agentelse can view, create, recommend, request
          approval for, or execute.
        </p>
      </Reveal>

      <Reveal delayMs={80} className="mt-12 md:mt-16">
        <div className="flex flex-wrap items-center gap-2.5">
          {PERMISSION_LEVELS.map((level, i) => (
            <div key={level.id} className="flex items-center gap-2.5">
              <StatusPill
                tone={i === PERMISSION_LEVELS.length - 1 ? "accent" : "neutral"}
              >
                {level.label}
              </StatusPill>
              {i < PERMISSION_LEVELS.length - 1 && (
                <ArrowRight className="size-3.5 shrink-0 text-muted-foreground/50" />
              )}
            </div>
          ))}
        </div>
      </Reveal>

      <Reveal delayMs={140} className="mt-12 md:mt-16">
        <div className="border-t border-border">
          {EXAMPLES.map((example) => (
            <div
              key={example.id}
              className="flex items-center justify-between gap-4 border-b border-border py-4"
            >
              <span className="text-sm text-foreground">{example.action}</span>
              <StatusPill tone={example.tone}>{example.requirement}</StatusPill>
            </div>
          ))}
        </div>
      </Reveal>
    </Section>
  );
}
