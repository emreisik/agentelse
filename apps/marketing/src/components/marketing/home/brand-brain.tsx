"use client";

import { useState } from "react";

import { Reveal } from "@/components/marketing/reveal";
import { Section } from "@/components/marketing/section";
import { cn } from "@/lib/utils";

// This section is the product's actual center of gravity — every
// department reads from the same brand context — so instead of an
// abstract five-node diagram it now shows real slices of what that
// context contains, in the exact shape the app stores it (see
// src/components/hub-core/panels/marka-beyni-panel.tsx "Varlıklar" for
// Brand, its BrandDossier json fields for Business, BrandFact/
// BrandLearning/BrandEvidence for Knowledge, ayarlar-panel.tsx's
// AutonomyTab + NegativeBriefRule for Rules, and its ActivityTab daily
// stats for Data). Minimal, high-contrast, OpenAI-docs-style card system:
// thin 1px borders, mono numerals, no color noise beyond what the data
// itself carries.

type TabKey = "brand" | "business" | "knowledge" | "rules" | "data";

const TABS: Array<{ key: TabKey; label: string; sublabel: string }> = [
  { key: "brand", label: "Brand", sublabel: "Positioning, tone, identity" },
  {
    key: "business",
    label: "Business",
    sublabel: "Products, markets, audiences",
  },
  {
    key: "knowledge",
    label: "Knowledge",
    sublabel: "Facts, evidence, learnings",
  },
  { key: "rules", label: "Rules", sublabel: "Autonomy, approvals, limits" },
  { key: "data", label: "Data", sublabel: "Activity, analytics, signals" },
];

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

function FieldRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border/60 py-3 last:border-0">
      <dt className="shrink-0 font-mono text-[11px] tracking-wide text-muted-foreground uppercase">
        {label}
      </dt>
      <dd className="min-w-0 text-right text-sm text-foreground">{value}</dd>
    </div>
  );
}

function BrandPanel() {
  const colors = [
    { hex: "#0F5132", name: "Forest" },
    { hex: "#D9C7A8", name: "Sand" },
    { hex: "#1B1B1B", name: "Ink" },
  ];
  return (
    <div className="space-y-6">
      <blockquote className="border-l-2 border-foreground/20 pl-4">
        <p className="text-lg leading-relaxed font-medium text-balance text-foreground">
          &ldquo;Premium, sustainable skincare that never compromises — and
          never tests on animals.&rdquo;
        </p>
      </blockquote>
      <p className="text-sm text-muted-foreground">
        <span className="font-medium text-foreground">Tone of voice — </span>
        Warm, expert, non-clinical.
      </p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Brand facts" value="47" />
        <StatTile label="Approved claims" value="12" />
        <StatTile label="Assumptions" value="3" />
        <StatTile label="Negative rules" value="5" />
      </div>
      <div className="flex flex-wrap items-center gap-2.5">
        {colors.map((color) => (
          <div
            key={color.hex}
            className="flex items-center gap-2 rounded-full border border-border py-1 pr-3 pl-1"
          >
            <span
              className="size-5 rounded-full ring-1 ring-black/10"
              style={{ backgroundColor: color.hex }}
            />
            <span className="font-mono text-xs text-muted-foreground">
              {color.name}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function BusinessPanel() {
  const fields = [
    { label: "Products", value: "Cleanser, Serum, Moisturizer, SPF 50" },
    { label: "Services", value: "Personalized skincare consultation" },
    { label: "Target audiences", value: "Gen Z · urban · eco-conscious" },
    { label: "Markets", value: "US, UK, DE, TR" },
  ];
  return (
    <dl>
      {fields.map((field) => (
        <FieldRow key={field.label} {...field} />
      ))}
    </dl>
  );
}

function KnowledgePanel() {
  const facts = [
    { key: "pricing · flagship_serum", value: "$42", confidence: 92 },
    { key: "channel · primary", value: "DTC + Instagram", confidence: 88 },
    { key: "packaging · material", value: "Recycled glass", confidence: 95 },
  ];
  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Brand facts
        </p>
        <div className="mt-2.5 divide-y divide-border/60 rounded-xl border border-border">
          {facts.map((fact) => (
            <div
              key={fact.key}
              className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm"
            >
              <span className="min-w-0 truncate text-muted-foreground">
                {fact.key}
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <span className="font-medium text-foreground">
                  {fact.value}
                </span>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {fact.confidence}%
                </span>
              </span>
            </div>
          ))}
        </div>
      </div>
      <div>
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Learnings
        </p>
        <p className="mt-2.5 rounded-xl border border-border p-4 text-sm leading-relaxed text-foreground">
          Video content on TikTok outperforms static posts by{" "}
          <span className="font-mono">3.2×</span> — weighted into every future
          Creative brief.
        </p>
      </div>
    </div>
  );
}

function RulesPanel() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatTile label="Max tasks / day" value="25" />
        <StatTile label="Daily budget" value="$150" />
        <StatTile label="Task cooldown" value="72h" />
      </div>
      <div className="flex items-center gap-3 rounded-xl border border-border p-4">
        <span className="shrink-0 rounded-full bg-foreground px-2.5 py-1 text-[10px] font-medium tracking-wide text-background uppercase">
          S2 · Agency Director
        </span>
        <span className="text-xs text-muted-foreground">
          Approval level required before a campaign goes live.
        </span>
      </div>
      <p className="text-sm text-muted-foreground">
        <span className="font-medium text-foreground">Negative rule — </span>
        Never claim &ldquo;clinically proven&rdquo; without a citation.
      </p>
    </div>
  );
}

function DataPanel() {
  const series = [
    { label: "Tasks", values: [3, 5, 2, 6, 4, 7, 5], total: 32 },
    { label: "Signals", values: [8, 6, 9, 7, 10, 6, 8], total: 54 },
    { label: "Opportunities", values: [1, 2, 1, 3, 2, 2, 1], total: 12 },
  ];
  return (
    <div className="space-y-5">
      {series.map((serie) => {
        const max = Math.max(...serie.values);
        return (
          <div key={serie.label}>
            <div className="mb-1.5 flex items-center justify-between text-xs">
              <span className="text-muted-foreground">{serie.label}</span>
              <span className="font-mono text-foreground tabular-nums">
                {serie.total}
              </span>
            </div>
            <div className="flex h-8 items-end gap-1">
              {serie.values.map((value, i) => (
                <div
                  key={i}
                  className="min-w-0 flex-1 rounded-t-sm bg-foreground/15"
                  style={{ height: `${(value / max) * 100}%` }}
                />
              ))}
            </div>
          </div>
        );
      })}
      <div className="flex items-center justify-between rounded-xl border border-border px-4 py-3 text-xs">
        <span className="text-muted-foreground">1,204 AI calls this month</span>
        <span className="font-mono text-foreground">$18.40</span>
      </div>
    </div>
  );
}

const PANELS: Record<TabKey, () => React.ReactNode> = {
  brand: BrandPanel,
  business: BusinessPanel,
  knowledge: KnowledgePanel,
  rules: RulesPanel,
  data: DataPanel,
};

export function BrandBrain() {
  const [active, setActive] = useState<TabKey>("brand");
  const ActivePanel = PANELS[active];

  return (
    <Section tone="raised">
      <Reveal>
        <p className="agentelse-text-caption font-medium text-muted-foreground uppercase">
          The center of gravity
        </p>
        <h2 className="agentelse-text-h2 mt-5 max-w-2xl text-foreground">
          One brain for your entire AI team.
        </h2>
        <p className="agentelse-text-lead mt-4 max-w-[50ch] text-muted-foreground">
          Every specialist reads from the same context. This is what it actually
          contains — click through.
        </p>
      </Reveal>

      <Reveal delayMs={100} className="mt-12 md:mt-16">
        <div className="grid overflow-hidden rounded-2xl border border-border bg-background shadow-sm md:grid-cols-[220px_1fr]">
          <div className="flex gap-1 overflow-x-auto border-b border-border p-2 md:flex-col md:gap-0.5 md:overflow-visible md:border-r md:border-b-0 md:bg-secondary/40 md:p-3">
            {TABS.map((tab) => {
              const isActive = tab.key === active;
              return (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setActive(tab.key)}
                  aria-pressed={isActive}
                  className={cn(
                    "shrink-0 rounded-lg px-3 py-2.5 text-left transition-colors",
                    isActive
                      ? "bg-foreground text-background"
                      : "text-foreground hover:bg-accent",
                  )}
                >
                  <p className="text-sm font-medium whitespace-nowrap">
                    {tab.label}
                  </p>
                  <p
                    className={cn(
                      "mt-0.5 hidden text-xs md:block",
                      isActive ? "text-background/60" : "text-muted-foreground",
                    )}
                  >
                    {tab.sublabel}
                  </p>
                </button>
              );
            })}
          </div>

          <div
            key={active}
            className="animate-in fade-in p-6 duration-300 md:p-8"
          >
            <ActivePanel />
          </div>
        </div>
      </Reveal>
    </Section>
  );
}
