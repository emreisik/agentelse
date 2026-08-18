"use client";

import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

// A faithful recreation of the real product's Fikirler (Ideas) Kanban —
// same 5 columns, same card anatomy (title row, solid department pill,
// lens + status badges, council dots), same colors, taken directly from
// src/components/hub-core/panels/idea-lens-board.tsx and
// src/lib/labels in the main app. Rendered inside a browser frame and
// scrolled right-to-left as the visitor scrolls the page, with periodic
// "autonomous work" mutations (cards advancing status) so the board
// visibly runs itself.

// Department colors — exact OKLCH values from the main app's globals.css
// (light mode). Scoped locally: the marketing site's own theme is
// monochrome, but the product screenshot must look like the product.
const DEPT_COLORS = {
  strategy: "oklch(0.5 0.18 258)",
  intel: "oklch(0.6 0.13 222)",
  creative: "oklch(0.55 0.2 346)",
  growth: "oklch(0.5 0.14 145)",
} as const;

// Status badge tones — exact tone classes from the main app's StatusBadge,
// with the app's OKLCH status colors inlined as arbitrary values.
const TONE_STYLES = {
  neutral: "bg-black/5 text-[#666] ring-1 ring-black/10",
  waiting:
    "bg-[oklch(0.685_0.16_63)]/15 text-[oklch(0.685_0.16_63)] ring-1 ring-[oklch(0.685_0.16_63)]/25",
  active:
    "bg-[oklch(0.19_0.014_260)]/12 text-[oklch(0.19_0.014_260)] ring-1 ring-[oklch(0.19_0.014_260)]/25",
  positive:
    "bg-[oklch(0.6_0.135_155)]/15 text-[oklch(0.6_0.135_155)] ring-1 ring-[oklch(0.6_0.135_155)]/25",
} as const;

type Tone = keyof typeof TONE_STYLES;
type Dept = keyof typeof DEPT_COLORS;

type IdeaCard = {
  id: string;
  title: string;
  dept: Dept;
  deptLabel: string;
  lens: string;
  status: string;
  tone: Tone;
  council?: ("go" | "warn")[];
};

type Column = { key: string; title: string; cards: IdeaCard[] };

// Real-looking board content in the product's own language (Turkish UI,
// same lens names the app uses).
const BOARD: Column[] = [
  {
    key: "discovery",
    title: "Discovery",
    cards: [
      {
        id: "k1",
        title: "Fast-response campaign to competitor price change",
        dept: "intel",
        deptLabel: "Competitor Intelligence",
        lens: "Growth",
        status: "Researching",
        tone: "active",
      },
      {
        id: "k2",
        title: "Winter routine content series — 3 parts",
        dept: "creative",
        deptLabel: "Creative",
        lens: "Content",
        status: "Raw",
        tone: "neutral",
      },
      {
        id: "k3",
        title: "Search opportunity for the new product page",
        dept: "growth",
        deptLabel: "SEO",
        lens: "Growth",
        status: "Validated",
        tone: "positive",
        council: ["go", "go"],
      },
    ],
  },
  {
    key: "concept",
    title: "Concept",
    cards: [
      {
        id: "c1",
        title: "Influencer collaboration — micro-creator shortlist",
        dept: "creative",
        deptLabel: "Influencer",
        lens: "Social",
        status: "Concept",
        tone: "neutral",
        council: ["go", "warn"],
      },
      {
        id: "c2",
        title: "Email lifecycle re-activation flow",
        dept: "growth",
        deptLabel: "CRM Lifecycle",
        lens: "Brand",
        status: "Shortlisted",
        tone: "waiting",
      },
    ],
  },
  {
    key: "approved",
    title: "Approved",
    cards: [
      {
        id: "o1",
        title: "Instagram carousel — product benefits",
        dept: "creative",
        deptLabel: "Social Media",
        lens: "Social",
        status: "Planning",
        tone: "active",
        council: ["go", "go", "go"],
      },
      {
        id: "o2",
        title: "Brand story PR push",
        dept: "strategy",
        deptLabel: "PR Media",
        lens: "PR",
        status: "Approved",
        tone: "positive",
      },
    ],
  },
  {
    key: "executing",
    title: "In execution",
    cards: [
      {
        id: "y1",
        title: "Search console opportunity brief — 14 keywords",
        dept: "growth",
        deptLabel: "SEO",
        lens: "Growth",
        status: "Running",
        tone: "active",
        council: ["go", "go"],
      },
      {
        id: "y2",
        title: "Competitor positioning analysis",
        dept: "intel",
        deptLabel: "Market Intelligence",
        lens: "Brand",
        status: "Measuring",
        tone: "active",
      },
    ],
  },
  {
    key: "results",
    title: "Results",
    cards: [
      {
        id: "s1",
        title: "Launch announcement — 3 channels",
        dept: "strategy",
        deptLabel: "Brand Strategy",
        lens: "Brand",
        status: "Learned",
        tone: "positive",
        council: ["go", "go"],
      },
    ],
  },
];

// Periodic "autonomous work": a rotating set of status mutations that walk
// cards forward, so the board visibly runs itself without any user input.
const LIVE_TICKS: { id: string; status: string; tone: Tone }[] = [
  { id: "k1", status: "Validated", tone: "positive" },
  { id: "c2", status: "Concept", tone: "neutral" },
  { id: "y1", status: "Verifying", tone: "active" },
  { id: "k2", status: "Researching", tone: "active" },
  { id: "o1", status: "Executing", tone: "active" },
  { id: "y2", status: "Completed", tone: "positive" },
];

function IdeaCardView({ card }: { card: IdeaCard }) {
  return (
    <div className="block rounded-lg bg-white p-3 shadow-xs ring-1 ring-black/10">
      <p className="line-clamp-2 text-xs leading-snug font-medium text-[#1b1b1b]">
        {card.title}
      </p>
      <span
        className="mt-2 inline-flex w-fit items-center rounded-sm px-2 py-0.5 text-[10px] font-bold tracking-wide text-white uppercase"
        style={{ backgroundColor: DEPT_COLORS[card.dept] }}
      >
        {card.deptLabel}
      </span>
      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <span className="inline-flex h-4 items-center rounded-full bg-black/5 px-1.5 text-[10px] font-medium text-[#666]">
            {card.lens}
          </span>
          <span
            key={card.status}
            className={cn(
              "animate-in fade-in inline-flex h-4 items-center rounded-full px-1.5 text-[10px] font-medium duration-500",
              TONE_STYLES[card.tone],
            )}
          >
            {card.status}
          </span>
        </div>
        {card.council ? (
          <div className="flex items-center gap-0.5">
            {card.council.map((vote, i) => (
              <span
                key={i}
                className={cn(
                  "size-1.5 rounded-full",
                  vote === "go"
                    ? "bg-[oklch(0.6_0.135_155)]"
                    : "bg-[oklch(0.685_0.16_63)]",
                )}
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function AppKanbanShowcase() {
  const frameRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [tick, setTick] = useState(0);

  // Scroll-linked right-to-left board pan: as the section moves through
  // the viewport, the Kanban track translates from right to left.
  useEffect(() => {
    const frame = frameRef.current;
    const track = trackRef.current;
    if (!frame || !track) return;

    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (reduceMotion) return;

    let raf = 0;
    const update = () => {
      raf = 0;
      const rect = frame.getBoundingClientRect();
      const viewport = window.innerHeight;
      // 0 when the frame enters from the bottom, 1 when it leaves at the top
      const progress = Math.min(
        1,
        Math.max(0, (viewport - rect.top) / (viewport + rect.height)),
      );
      const maxShift = Math.max(0, track.scrollWidth - frame.clientWidth);
      track.style.transform = `translateX(${-progress * maxShift}px)`;
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

  // Autonomous status mutations on an interval.
  useEffect(() => {
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (reduceMotion) return;
    const id = window.setInterval(() => {
      setTick((t) => (t + 1) % (LIVE_TICKS.length + 1));
    }, 2800);
    return () => window.clearInterval(id);
  }, []);

  const applied = LIVE_TICKS.slice(0, tick);
  const columns = BOARD.map((col) => ({
    ...col,
    cards: col.cards.map((card) => {
      const mutation = [...applied].reverse().find((m) => m.id === card.id);
      return mutation
        ? { ...card, status: mutation.status, tone: mutation.tone }
        : card;
    }),
  }));

  return (
    <div className="agentelse-container-wide pb-14 md:pb-20">
      {/* Browser frame */}
      <div className="overflow-hidden rounded-2xl border border-border bg-white shadow-[0_24px_60px_-24px_rgba(0,0,0,0.18)]">
        {/* Browser chrome bar */}
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

        {/* App bar inside the "product" */}
        <div className="flex items-center justify-between border-b border-border bg-white px-4 py-2.5">
          <div className="flex items-center gap-2 text-xs text-[#666]">
            <span className="font-semibold text-[#1b1b1b]">Ideas</span>
            <span aria-hidden="true">·</span>
            <span>Northwind Cosmetics</span>
          </div>
          <span className="text-[11px] text-[#999]">
            Last updated: just now
          </span>
        </div>

        {/* Kanban viewport — track pans right-to-left on page scroll */}
        <div ref={frameRef} className="overflow-hidden bg-[#fafafa] p-4">
          <div
            ref={trackRef}
            className="flex w-max gap-3 transition-transform duration-300 ease-out will-change-transform"
          >
            {columns.map((col) => (
              <div
                key={col.key}
                className="w-60 shrink-0 sm:w-72 lg:w-80"
              >
                <div className="flex items-baseline gap-1.5 px-1">
                  <span className="text-[11px] font-bold tracking-wide text-[#666] uppercase">
                    {col.title}
                  </span>
                  <span className="text-[11px] font-normal text-[#999] tabular-nums">
                    {col.cards.length}
                  </span>
                </div>
                <div className="mt-2 flex flex-col gap-2">
                  {col.cards.map((card) => (
                    <IdeaCardView key={card.id} card={card} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <p className="mt-4 text-center text-sm text-muted-foreground">
        The real product: ideas move through discovery, approval and execution
        on their own — departments do the work, you approve the moments that
        matter.
      </p>
    </div>
  );
}
