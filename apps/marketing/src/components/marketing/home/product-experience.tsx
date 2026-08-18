import type { LucideIcon } from "lucide-react";
import {
  CheckCircle2,
  Clock,
  Palette,
  Radar,
  Search,
  TrendingUp,
} from "lucide-react";

import { AgentelseMark } from "@/components/marketing/agentelse-mark";
import { Reveal } from "@/components/marketing/reveal";
import { Section } from "@/components/marketing/section";
import { Button } from "@/components/ui/button";

// Department family colors — exact OKLCH values from the main app's
// globals.css / department-explorer.tsx DEPT_FAMILY. Scoped locally: the
// marketing site's own theme is monochrome, but this card is a screenshot
// of the real product and should read like one.
const DEPT_FAMILY = {
  intel: "oklch(0.6 0.13 222)",
  creative: "oklch(0.55 0.2 346)",
  growth: "oklch(0.5 0.14 145)",
} as const;

type Stat = {
  id: string;
  value: string;
  label: string;
  icon: LucideIcon;
  toneClass?: string;
  color?: string;
};

const STATS: Stat[] = [
  {
    id: "found",
    value: "12",
    label: "Opportunities found",
    icon: Radar,
    color: DEPT_FAMILY.intel,
  },
  {
    id: "in-progress",
    value: "8",
    label: "In progress",
    icon: TrendingUp,
    toneClass: "bg-primary/10 text-primary",
  },
  {
    id: "waiting",
    value: "4",
    label: "Waiting for approval",
    icon: Clock,
    toneClass: "bg-warning/15 text-warning",
  },
  {
    id: "completed",
    value: "21",
    label: "Completed this week",
    icon: CheckCircle2,
    toneClass: "bg-success/15 text-success",
  },
];

type ActivityItem = {
  id: string;
  dept: string;
  text: string;
  time: string;
  icon: LucideIcon;
  color: string;
};

const ACTIVITY: ActivityItem[] = [
  {
    id: "research",
    dept: "Research",
    text: "Completed competitor analysis.",
    time: "6m ago",
    icon: Radar,
    color: DEPT_FAMILY.intel,
  },
  {
    id: "seo",
    dept: "SEO",
    text: "Found 14 keyword opportunities.",
    time: "22m ago",
    icon: Search,
    color: DEPT_FAMILY.growth,
  },
  {
    id: "creative",
    dept: "Creative",
    text: "Prepared 3 campaign concepts.",
    time: "41m ago",
    icon: Palette,
    color: DEPT_FAMILY.creative,
  },
];

export function ProductExperience() {
  return (
    <Section>
      <Reveal>
        <p className="agentelse-text-caption font-medium text-muted-foreground uppercase">
          Product
        </p>
      </Reveal>

      <Reveal delayMs={80} className="mt-6">
        <div className="overflow-hidden rounded-2xl border border-border bg-background shadow-[0_24px_60px_-24px_rgba(0,0,0,0.16)]">
          {/* Browser chrome — same anatomy as the live-board showcase, so
              every "product" screenshot on the page reads as one app. */}
          <div className="flex items-center gap-3 border-b border-border bg-[#fafafa] px-4 py-2.5">
            <div className="flex gap-1.5" aria-hidden="true">
              <span className="size-2.5 rounded-full bg-[#e5e5e5]" />
              <span className="size-2.5 rounded-full bg-[#e5e5e5]" />
              <span className="size-2.5 rounded-full bg-[#e5e5e5]" />
            </div>
            <div className="flex h-7 flex-1 items-center justify-center rounded-md bg-white ring-1 ring-black/8">
              <span className="font-mono text-[11px] text-[#999]">
                app.agentelse.ai
              </span>
            </div>
            <span className="flex items-center gap-1.5 text-[11px] font-medium text-[oklch(0.6_0.135_155)]">
              <span className="agentelse-live-dot size-1.5 rounded-full bg-current" />
              Autonomous
            </span>
          </div>

          <div className="p-6 md:p-8">
            <div>
              <p className="text-lg font-medium text-foreground">
                Good morning, Sarah.
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Here&apos;s what your AI team is working on.
              </p>
            </div>

            <dl className="mt-8 grid grid-cols-2 gap-3 md:grid-cols-4">
              {STATS.map((stat) => (
                <div
                  key={stat.id}
                  className="rounded-xl border border-border p-4"
                >
                  <span
                    className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${stat.toneClass ?? ""}`}
                    style={
                      stat.color
                        ? {
                            backgroundColor: `color-mix(in oklch, ${stat.color} 14%, transparent)`,
                            color: stat.color,
                          }
                        : undefined
                    }
                  >
                    <stat.icon className="size-4" />
                  </span>
                  <dd className="mt-3 font-mono text-2xl font-medium text-foreground tabular-nums">
                    {stat.value}
                  </dd>
                  <dt className="mt-1 text-xs text-muted-foreground">
                    {stat.label}
                  </dt>
                </div>
              ))}
            </dl>

            <div className="mt-8">
              <div className="flex items-center gap-2">
                <AgentelseMark className="size-4 text-foreground" />
                <h2 className="text-sm font-medium text-foreground">
                  Agency Director
                </h2>
              </div>

              <ul className="mt-4 space-y-1">
                {ACTIVITY.map((item) => (
                  <li
                    key={item.id}
                    className="flex items-center gap-3 rounded-lg py-1.5"
                  >
                    <span
                      className="flex size-7 shrink-0 items-center justify-center rounded-lg"
                      style={{
                        backgroundColor: `color-mix(in oklch, ${item.color} 14%, transparent)`,
                        color: item.color,
                      }}
                    >
                      <item.icon className="size-3.5" />
                    </span>
                    <p className="min-w-0 flex-1 truncate text-sm">
                      <span className="font-medium text-foreground">
                        {item.dept}
                      </span>{" "}
                      <span className="text-muted-foreground">{item.text}</span>
                    </p>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {item.time}
                    </span>
                  </li>
                ))}
              </ul>

              <div className="mt-3 flex items-center gap-2.5 rounded-xl bg-warning/10 p-3 ring-1 ring-warning/20">
                <CheckCircle2 className="size-4 shrink-0 text-warning" />
                <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                  One action requires your approval.
                </p>
              </div>

              <Button
                type="button"
                variant="default"
                size="lg"
                className="mt-5"
              >
                Review recommendation
              </Button>
            </div>
          </div>
        </div>
      </Reveal>
    </Section>
  );
}
