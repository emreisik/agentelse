"use client";

import { useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  Compass,
  Lightbulb,
  Palette,
  Radar,
  Search,
  Share2,
} from "lucide-react";

import { cn } from "@/lib/utils";

export type Department = {
  id: string;
  name: string;
};

// Same tab format as BrandBrain — this panel now mirrors the real
// Departmanlar detail view (src/components/hub-core/panels/
// departmanlar-panel.tsx DepartmentDetail): icon + team color, working
// mode badge, audit score, owned capabilities, one strength line. Colors
// are the exact OKLCH department-family values used elsewhere on this
// page (AppKanbanShowcase, StopManagingAi, HowItWorks). Director, Idea
// Foundry and Opportunity Engine aren't literal DepartmentKey rows in the
// app (Director coordinates all 19; the other two are product concepts),
// so they get the closest real family color and a fitting icon instead of
// a fabricated key.
const DEPT_FAMILY = {
  strategy: "oklch(0.5 0.18 258)",
  intel: "oklch(0.6 0.13 222)",
  creative: "oklch(0.55 0.2 346)",
  growth: "oklch(0.5 0.14 145)",
} as const;

type ModeTone = "neutral" | "active" | "waiting" | "positive";

const MODE_TONE_STYLES: Record<ModeTone, string> = {
  neutral: "bg-muted text-muted-foreground",
  active: "bg-primary/10 text-primary",
  waiting: "bg-warning/15 text-warning",
  positive: "bg-success/15 text-success",
};

type DepartmentVisual = {
  Icon: LucideIcon;
  color: string;
  mode: string;
  modeTone: ModeTone;
  score: number;
  capabilities: string[];
  strength: string;
};

const DEPARTMENT_VISUALS: Record<string, DepartmentVisual> = {
  director: {
    Icon: Compass,
    color: DEPT_FAMILY.strategy,
    mode: "Execute",
    modeTone: "positive",
    score: 94,
    capabilities: ["Task Assignment", "Approval Routing", "Priority Scoring"],
    strength: "Resolves department conflicts automatically.",
  },
  research: {
    Icon: Radar,
    color: DEPT_FAMILY.intel,
    mode: "Listen",
    modeTone: "neutral",
    score: 88,
    capabilities: [
      "Market Research",
      "Competitor Monitoring",
      "Customer Intelligence",
    ],
    strength: "Surfaces market shifts within hours.",
  },
  "idea-foundry": {
    Icon: Lightbulb,
    color: DEPT_FAMILY.creative,
    mode: "Suggest",
    modeTone: "active",
    score: 91,
    capabilities: ["Concept Generation", "Growth Ideation"],
    strength: "Ships 40+ validated concepts a month.",
  },
  creative: {
    Icon: Palette,
    color: DEPT_FAMILY.creative,
    mode: "Prepare",
    modeTone: "waiting",
    score: 85,
    capabilities: ["Ad Creative", "Social Creative", "Copywriting"],
    strength: "Produces on-brand assets in hours, not days.",
  },
  seo: {
    Icon: Search,
    color: DEPT_FAMILY.growth,
    mode: "Execute",
    modeTone: "positive",
    score: 79,
    capabilities: ["SEO Research", "SEO Analysis"],
    strength: "Found 14 keyword gaps this month.",
  },
  social: {
    Icon: Share2,
    color: DEPT_FAMILY.creative,
    mode: "Execute",
    modeTone: "positive",
    score: 82,
    capabilities: ["Instagram Publish", "TikTok Publish", "LinkedIn Publish"],
    strength: "Publishes on schedule, zero manual steps.",
  },
  analytics: {
    Icon: BarChart3,
    color: DEPT_FAMILY.growth,
    mode: "Listen",
    modeTone: "neutral",
    score: 90,
    capabilities: ["Analytics Analysis", "Reporting"],
    strength: "Flags underperforming campaigns automatically.",
  },
  "opportunity-engine": {
    Icon: Radar,
    color: DEPT_FAMILY.intel,
    mode: "Suggest",
    modeTone: "active",
    score: 93,
    capabilities: ["Signal Scan", "Opportunity Scoring"],
    strength: "Combines 12 signal types into one score.",
  },
};

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border p-4">
      <p className="font-mono text-2xl font-medium text-foreground tabular-nums">
        {value}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

function DepartmentPanel({
  name,
  visual,
}: {
  name: string;
  visual: DepartmentVisual;
}) {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <span
          className="flex size-10 shrink-0 items-center justify-center rounded-xl"
          style={{
            backgroundColor: `color-mix(in oklch, ${visual.color} 15%, transparent)`,
            color: visual.color,
          }}
        >
          <visual.Icon className="size-5" />
        </span>
        <p className="text-base font-medium text-foreground">{name}</p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <StatTile label="Audit score" value={`${visual.score}/100`} />
        <div className="rounded-xl border border-border p-4">
          <span
            className={cn(
              "inline-flex h-6 items-center rounded-md px-2 text-xs font-semibold",
              MODE_TONE_STYLES[visual.modeTone],
            )}
          >
            {visual.mode}
          </span>
          <p className="mt-2 text-xs text-muted-foreground">Working mode</p>
        </div>
      </div>

      <div>
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Owned capabilities
        </p>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {visual.capabilities.map((capability) => (
            <span
              key={capability}
              className="rounded-full bg-secondary px-2.5 py-1 text-xs text-secondary-foreground"
            >
              {capability}
            </span>
          ))}
        </div>
      </div>

      <p className="rounded-xl border border-border p-4 text-sm text-foreground">
        {visual.strength}
      </p>
    </div>
  );
}

export function DepartmentExplorer({
  departments,
}: {
  departments: Department[];
}) {
  const [selectedId, setSelectedId] = useState(departments[0]?.id ?? "");
  const selected =
    departments.find((d) => d.id === selectedId) ?? departments[0];
  const visual = selected ? DEPARTMENT_VISUALS[selected.id] : undefined;

  return (
    <div className="grid overflow-hidden rounded-2xl border border-border bg-background shadow-sm md:grid-cols-[220px_1fr]">
      <div
        role="tablist"
        aria-label="Departments"
        className="flex gap-1 overflow-x-auto border-b border-border p-2 md:flex-col md:gap-0.5 md:overflow-visible md:border-r md:border-b-0 md:bg-secondary/40 md:p-3"
      >
        {departments.map((dept) => {
          const isSelected = dept.id === selectedId;
          const deptVisual = DEPARTMENT_VISUALS[dept.id];
          return (
            <button
              key={dept.id}
              type="button"
              role="tab"
              aria-selected={isSelected}
              onClick={() => setSelectedId(dept.id)}
              onMouseEnter={() => setSelectedId(dept.id)}
              className={cn(
                "flex shrink-0 items-center gap-2 rounded-lg px-3 py-2.5 text-left transition-colors",
                isSelected
                  ? "bg-foreground text-background"
                  : "text-foreground hover:bg-accent",
              )}
            >
              {deptVisual ? (
                <deptVisual.Icon
                  className="size-4 shrink-0"
                  style={{ color: isSelected ? undefined : deptVisual.color }}
                />
              ) : null}
              <span className="text-sm font-medium whitespace-nowrap">
                {dept.name}
              </span>
            </button>
          );
        })}
      </div>

      <div
        key={selectedId}
        className="animate-in fade-in p-6 duration-300 md:p-8"
      >
        {selected && visual ? (
          <DepartmentPanel name={selected.name} visual={visual} />
        ) : null}
      </div>
    </div>
  );
}
