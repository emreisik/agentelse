"use client";

import { Check, Globe } from "lucide-react";

import { cn } from "@/lib/utils";
import { useLoop } from "@/components/site/use-loop";
import {
  DEMO_BRAND,
  Pill,
  PlatformIcon,
  PostArt,
} from "@/components/site/mock/parts";

const SITE = DEMO_BRAND.site;

// 1. A website goes in, a brand kit comes out.
export function WebsiteVisual() {
  const { ref, phase } = useLoop(5, 900);
  const typed = phase === 0 ? SITE.slice(0, 4) : SITE;
  const kit = phase >= 2;

  return (
    <div ref={ref} className="flex w-full max-w-[280px] flex-col gap-3">
      <div className="flex items-center gap-2 rounded-xl border border-border bg-background px-3 py-2.5 shadow-[var(--shadow-card)]">
        <Globe className="size-3.5 text-muted-foreground" />
        <span className="text-[13px]">
          {typed}
          {phase < 2 ? <span className="demo-caret" /> : null}
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        {DEMO_BRAND.colors.map((color, index) => (
          <span
            key={color}
            className={cn(
              "size-9 rounded-xl border border-black/5 transition-all duration-500 ease-[var(--site-ease)]",
              kit ? "scale-100 opacity-100" : "scale-50 opacity-0",
            )}
            style={{
              background: color,
              transitionDelay: kit ? `${index * 90}ms` : "0ms",
            }}
          />
        ))}
        <span
          className={cn(
            "ml-1 font-serif text-[26px] leading-none transition-opacity duration-500",
            kit ? "opacity-100 delay-300" : "opacity-0",
          )}
        >
          Aa
        </span>
      </div>
      <span
        className={cn(
          "flex items-center gap-1.5 text-[12px] font-medium transition-opacity duration-500",
          phase >= 3 ? "opacity-100" : "opacity-0",
        )}
      >
        <Check className="size-3.5 text-success" />
        Brand kit ready
      </span>
    </div>
  );
}

const ROWS = [
  { day: "Mon", title: "Behind the roast" },
  { day: "Thu", title: "The autumn menu is here" },
  { day: "Sat", title: "Pumpkin spice, done properly" },
];

// 2. One sentence becomes a plan.
export function PlanVisual() {
  const { ref, phase } = useLoop(6, 800);
  return (
    <div ref={ref} className="flex w-full max-w-[280px] flex-col gap-2">
      <p className="self-end rounded-2xl rounded-br-md bg-primary px-3 py-2 text-[12.5px] text-primary-foreground">
        Plan next week for us.
      </p>
      <div className="flex flex-col gap-1.5">
        {ROWS.map((row, index) => (
          <div
            key={row.day}
            className={cn(
              "flex items-center gap-2.5 rounded-xl border border-border bg-background px-3 py-2 shadow-[var(--shadow-card)] transition-all duration-500 ease-[var(--site-ease)]",
              phase > index
                ? "translate-y-0 opacity-100"
                : "translate-y-2 opacity-0",
            )}
          >
            <span className="w-7 text-[11px] font-medium text-muted-foreground">
              {row.day}
            </span>
            <span className="min-w-0 flex-1 truncate text-[12px]">
              {row.title}
            </span>
            <PlatformIcon
              platform="instagram"
              className="size-3 text-muted-foreground"
            />
            <PlatformIcon
              platform="facebook"
              className="size-3 text-muted-foreground"
            />
          </div>
        ))}
      </div>
    </div>
  );
}

// 3. One tap, and it's on the calendar.
export function ApproveVisual() {
  const { ref, phase } = useLoop(5, 900);
  const approved = phase >= 2;
  return (
    <div ref={ref} className="flex w-full max-w-[280px] items-center gap-3">
      <PostArt
        headline="The autumn menu is here"
        tone="warm"
        className="w-[92px] shrink-0 rounded-xl text-[10px] shadow-[var(--shadow-card)]"
      />
      <div className="flex flex-col items-start gap-2">
        <Pill tone={approved ? "positive" : "waiting"}>
          {approved ? "Scheduled" : "In review"}
        </Pill>
        <span
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[12.5px] font-medium transition-all duration-300",
            approved
              ? "bg-[oklch(0.96_0.04_152)] text-[oklch(0.45_0.12_152)]"
              : "bg-primary text-primary-foreground",
            phase === 1 && "scale-95",
          )}
        >
          <Check className="size-3.5" />
          {approved ? "Approved" : "Approve"}
        </span>
        <span
          className={cn(
            "text-[11.5px] text-muted-foreground transition-opacity duration-500",
            approved ? "opacity-100" : "opacity-0",
          )}
        >
          Thu · 09:00
        </span>
      </div>
    </div>
  );
}
