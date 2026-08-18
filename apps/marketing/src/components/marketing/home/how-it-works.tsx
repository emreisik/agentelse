"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { ArrowRight } from "lucide-react";

import { Reveal } from "@/components/marketing/reveal";
import { Section } from "@/components/marketing/section";
import {
  StatusPill,
  type StatusPillTone,
} from "@/components/marketing/status-pill";
import { cn } from "@/lib/utils";

// Card anatomy and OKLCH department/status colors copied from the real
// product's kanban system (src/components/hub-core/panels/idea-lens-board.tsx,
// task-department-board.tsx, work-handoff-board.tsx, src/lib/labels) — same
// fixed light "screenshot" card styling as AppKanbanShowcase and
// StopManagingAi elsewhere on this page. Unlike those, every stage below
// follows the SAME opportunity end to end, so the five steps read as one
// real case moving through the product rather than five disconnected
// mockups.
const DEPT_COLORS = {
  seo: "oklch(0.5 0.14 145)",
  creative: "oklch(0.55 0.2 346)",
} as const;

const TONE_POSITIVE =
  "bg-[oklch(0.6_0.135_155)]/15 text-[oklch(0.6_0.135_155)] ring-1 ring-[oklch(0.6_0.135_155)]/25";

function ProductCard({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg bg-white p-3 shadow-xs ring-1 ring-black/10">
      {children}
    </div>
  );
}

// Step 1 — a slice of the shared Brand Brain context every department
// reads from (same key/value list shape as FieldGrid in
// src/components/hub-core/primitives/field-grid.tsx).
function UnderstandVisual() {
  const fields = [
    { label: "Brand", value: "Northwind Cosmetics" },
    { label: "Positioning", value: "Premium, sustainable skincare" },
    { label: "Competitors", value: "6 tracked" },
  ];
  return (
    <ProductCard>
      <p className="text-[10px] font-semibold tracking-wide text-[#999] uppercase">
        Brand Brain
      </p>
      <dl className="mt-2 divide-y divide-black/8">
        {fields.map((field) => (
          <div
            key={field.label}
            className="flex items-start justify-between gap-3 py-1.5"
          >
            <dt className="shrink-0 text-[10px] text-[#999]">{field.label}</dt>
            <dd className="min-w-0 text-right text-[11px] font-medium text-[#1b1b1b]">
              {field.value}
            </dd>
          </div>
        ))}
      </dl>
    </ProductCard>
  );
}

// Step 2 — the raw signal that starts this case, before it becomes an idea.
function MonitorVisual() {
  return (
    <ProductCard>
      <p className="text-[10px] font-semibold tracking-wide text-[#999] uppercase">
        Search Console
      </p>
      <p className="mt-2 text-xs leading-snug text-[#1b1b1b]">
        Demand for &ldquo;AI-powered skincare&rdquo; is up{" "}
        <span className="font-semibold">28%</span> this month.
      </p>
    </ProductCard>
  );
}

// Step 3 — the exact Fikirler/Ideas card anatomy: title, solid department
// pill, lens + status badge, council approval dots.
function ThinkVisual() {
  return (
    <ProductCard>
      <p className="line-clamp-2 text-xs leading-snug font-medium text-[#1b1b1b]">
        Search opportunity: AI-powered skincare content
      </p>
      <span
        className="mt-1.5 inline-flex w-fit items-center rounded-sm px-1.5 py-0.5 text-[9px] font-bold tracking-wide text-white uppercase"
        style={{ backgroundColor: DEPT_COLORS.seo }}
      >
        SEO
      </span>
      <div className="mt-1.5 flex items-center justify-between gap-1.5">
        <div className="flex items-center gap-1">
          <span className="inline-flex h-4 items-center rounded-full bg-black/5 px-1.5 text-[9px] font-medium text-[#666]">
            Growth
          </span>
          <span
            className={cn(
              "inline-flex h-4 items-center rounded-full px-1.5 text-[9px] font-medium",
              TONE_POSITIVE,
            )}
          >
            Validated
          </span>
        </div>
        <div className="flex items-center gap-0.5">
          <span className="size-1.5 rounded-full bg-[oklch(0.6_0.135_155)]" />
          <span className="size-1.5 rounded-full bg-[oklch(0.6_0.135_155)]" />
        </div>
      </div>
    </ProductCard>
  );
}

// Step 4 — the exact Devirler/Handoffs card anatomy: from-department,
// to-department, reason, status badge.
function CoordinateVisual() {
  return (
    <ProductCard>
      <div className="flex items-center gap-1.5 text-[9px] font-bold tracking-wide uppercase">
        <span
          className="rounded-sm px-1.5 py-0.5 text-white"
          style={{ backgroundColor: DEPT_COLORS.seo }}
        >
          SEO
        </span>
        <ArrowRight
          className="size-3 shrink-0 text-[#999]"
          aria-hidden="true"
        />
        <span
          className="rounded-sm px-1.5 py-0.5 text-white"
          style={{ backgroundColor: DEPT_COLORS.creative }}
        >
          Creative
        </span>
      </div>
      <p className="mt-2 text-[11px] leading-snug text-[#666]">
        Opportunity approved — needs a supporting content brief.
      </p>
      <span
        className={cn(
          "mt-2 inline-flex h-4 items-center rounded-full px-1.5 text-[9px] font-medium",
          TONE_POSITIVE,
        )}
      >
        Accepted
      </span>
    </ProductCard>
  );
}

// Step 5 — the exact Görevler/Tasks card anatomy: title, capability,
// solid department pill, status badge.
function ExecuteVisual() {
  return (
    <ProductCard>
      <p className="line-clamp-2 text-xs leading-snug font-medium text-[#1b1b1b]">
        Publish 3-part SEO content series
      </p>
      <p className="mt-1 truncate text-[10px] text-[#999]">Content Plan</p>
      <span
        className="mt-1.5 inline-flex w-fit items-center rounded-sm px-1.5 py-0.5 text-[9px] font-bold tracking-wide text-white uppercase"
        style={{ backgroundColor: DEPT_COLORS.creative }}
      >
        Creative
      </span>
      <span
        className={cn(
          "mt-1.5 inline-flex h-4 items-center rounded-full px-1.5 text-[9px] font-medium",
          TONE_POSITIVE,
        )}
      >
        Completed
      </span>
    </ProductCard>
  );
}

type Stage = {
  number: string;
  title: string;
  copy: string;
  pillTone?: StatusPillTone;
  pillLabel?: string;
  Visual: () => ReactNode;
};

const STAGES: Stage[] = [
  {
    number: "01",
    title: "Understand",
    copy: "Agentelse learns your brand, products, customers, positioning, competitors, business goals and rules.",
    Visual: UnderstandVisual,
  },
  {
    number: "02",
    title: "Monitor",
    copy: "Continuously watches the market, search, analytics, competitors, campaigns, trends and customer signals.",
    pillTone: "signal",
    pillLabel: "Signal detected",
    Visual: MonitorVisual,
  },
  {
    number: "03",
    title: "Think",
    copy: "Identifies opportunities, threats, ideas, anomalies and growth possibilities.",
    pillTone: "decision",
    pillLabel: "Opportunity created",
    Visual: ThinkVisual,
  },
  {
    number: "04",
    title: "Coordinate",
    copy: "Agency Director assigns work to Research, Creative, SEO, Social and Analytics specialists.",
    pillTone: "coordination",
    pillLabel: "Handed off",
    Visual: CoordinateVisual,
  },
  {
    number: "05",
    title: "Execute",
    copy: "Depending on your permissions, Agentelse can create, schedule, publish, update, report, recommend or ask for approval.",
    pillTone: "execution",
    pillLabel: "Task completed",
    Visual: ExecuteVisual,
  },
];

// Deliberately not a FlowDiagram and not a card grid — an editorial numbered
// narrative. Odd stages sit flush left, even stages shift right on desktop
// so the sequence reads as a stepped progression rather than five identical
// repeated blocks. Each stage now carries a real product card on the right
// so the abstract step name has a concrete, in-app example next to it.
//
// Scroll progress: a thin rail above the list fills as the reader moves
// through the stages, and each stage brightens from dimmed to full opacity
// once the reading line (~40% down the viewport) reaches it. Both are driven
// imperatively via refs on a single rAF loop (no React state per frame) —
// same pattern as AppKanbanShowcase's scroll-linked pan.
export function HowItWorks() {
  const listRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const stageRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    const list = listRef.current;
    const fill = fillRef.current;
    if (!list || !fill) return;

    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (reduceMotion) return;

    let raf = 0;
    const update = () => {
      raf = 0;
      const rect = list.getBoundingClientRect();
      const viewport = window.innerHeight;
      const readLine = viewport * 0.4;
      const progress = Math.min(
        1,
        Math.max(0, (readLine - rect.top) / rect.height),
      );
      fill.style.transform = `scaleX(${progress})`;

      for (const node of stageRefs.current) {
        if (!node) continue;
        const passed = node.getBoundingClientRect().top <= readLine;
        node.classList.toggle("opacity-100", passed);
        node.classList.toggle("opacity-45", !passed);
      }
    };
    const onScroll = () => {
      if (!raf) raf = window.requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <Section id="how-it-works">
      <Reveal>
        <h2 className="agentelse-text-h2 max-w-2xl text-foreground">
          From signal to execution.
        </h2>
        <p className="agentelse-text-lead mt-4 max-w-[46ch] text-muted-foreground">
          One real opportunity, followed end to end — from what Agentelse
          already knows about your brand to the work it ships.
        </p>
      </Reveal>

      <div className="relative mt-12 md:mt-16">
        <div className="h-px w-full bg-border" aria-hidden="true" />
        <div
          ref={fillRef}
          className="absolute inset-x-0 top-0 h-px origin-left scale-x-0 bg-foreground motion-reduce:hidden"
          aria-hidden="true"
        />

        <div ref={listRef} className="divide-y divide-border">
          {STAGES.map((stage, i) => (
            <Reveal key={stage.number} delayMs={i * 80}>
              <div
                ref={(node) => {
                  stageRefs.current[i] = node;
                }}
                className={cn(
                  "flex flex-col gap-5 py-8 opacity-100 transition-opacity duration-700 ease-out md:flex-row md:items-start md:gap-10 md:py-10",
                  i % 2 === 1 && "md:pl-16",
                )}
              >
                <span className="font-mono text-4xl text-muted-foreground/40 md:w-24 md:shrink-0 md:text-5xl">
                  {stage.number}
                </span>
                <div className="max-w-2xl flex-1">
                  <h3 className="agentelse-text-h3 text-foreground">
                    {stage.title}
                  </h3>
                  <p className="mt-2 text-base text-muted-foreground">
                    {stage.copy}
                  </p>
                </div>
                <div className="flex flex-col gap-2 md:w-60 md:shrink-0">
                  {stage.pillTone ? (
                    <StatusPill tone={stage.pillTone} className="w-fit">
                      {stage.pillLabel}
                    </StatusPill>
                  ) : null}
                  <stage.Visual />
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </Section>
  );
}
