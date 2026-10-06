"use client";

import { Check, ThumbsUp } from "lucide-react";

import { cn } from "@/lib/utils";
import { useLoop } from "@/components/site/use-loop";
import {
  BrandAvatar,
  DEMO_BRAND,
  PlatformIcon,
  PostArt,
} from "@/components/site/mock/parts";

// The small living pictures inside the feature grid on the home page.

export function BrandVisual() {
  const { ref, phase } = useLoop(3, 1800);
  const voices = ["Warm", "Crafted", "Honest"];
  return (
    <div ref={ref} className="flex w-full max-w-[420px] flex-col gap-4">
      <div className="flex items-center gap-3">
        <BrandAvatar className="size-12 rounded-2xl text-[20px]" />
        <div>
          <p className="text-[15px] font-semibold">{DEMO_BRAND.name}</p>
          <p className="text-[12px] text-muted-foreground">{DEMO_BRAND.site}</p>
        </div>
        <span className="ml-auto font-serif text-[34px] leading-none">Aa</span>
      </div>
      <div className="grid grid-cols-4 gap-2">
        {DEMO_BRAND.colors.map((color) => (
          <div key={color} className="flex flex-col gap-1.5">
            <span
              className="h-12 rounded-xl border border-black/5"
              style={{ background: color }}
            />
            <span className="font-mono text-[10px] text-muted-foreground">
              {color}
            </span>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {voices.map((voice, index) => (
          <span
            key={voice}
            className={cn(
              "rounded-full border px-3 py-1 text-[12px] font-medium transition-colors duration-500",
              index === phase
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-background text-foreground/80",
            )}
          >
            {voice}
          </span>
        ))}
      </div>
    </div>
  );
}

const FORMATS = [
  {
    label: "Instagram",
    platform: "instagram" as const,
    aspect: "aspect-[4/5]",
    width: "w-[86px]",
  },
  {
    label: "Facebook",
    platform: "facebook" as const,
    aspect: "aspect-[1.91/1]",
    width: "w-[120px]",
  },
  {
    label: "Story",
    platform: "instagram" as const,
    aspect: "aspect-[9/16]",
    width: "w-[62px]",
  },
];

export function ChannelsVisual() {
  const { ref, phase } = useLoop(3, 1400);
  return (
    <div ref={ref} className="flex w-full items-end justify-center gap-3">
      {FORMATS.map((format, index) => (
        <div
          key={format.label}
          className={cn(
            "flex flex-col items-center gap-2 transition-all duration-500 ease-[var(--site-ease)]",
            index === phase ? "-translate-y-1.5 opacity-100" : "opacity-55",
          )}
        >
          <div
            className={cn(
              "overflow-hidden rounded-lg shadow-[var(--shadow-card)] ring-2 transition-colors duration-500",
              format.width,
              index === phase ? "ring-spark" : "ring-transparent",
            )}
          >
            <PostArt
              headline="Autumn menu"
              tone="warm"
              aspect={format.aspect}
              className="text-[9px]"
            />
          </div>
          <span className="flex items-center gap-1 text-[11px] font-medium">
            <PlatformIcon platform={format.platform} className="size-3" />
            {format.label}
          </span>
        </div>
      ))}
    </div>
  );
}

const DESIGNS = [
  {
    headline: "The autumn menu is here",
    kicker: "New this week",
    tone: "warm" as const,
  },
  {
    headline: "Single origin, slow roast",
    kicker: "Behind the bar",
    tone: "dark" as const,
  },
  { headline: "Oat, always", kicker: "House favourite", tone: "sage" as const },
];

export function LooksVisual() {
  const { ref, phase } = useLoop(3, 2200);
  return (
    <div ref={ref} className="relative w-[170px]">
      <div className="relative aspect-[4/5] overflow-hidden rounded-2xl shadow-[var(--shadow-float)]">
        {DESIGNS.map((design, index) => (
          <PostArt
            key={design.headline}
            headline={design.headline}
            kicker={design.kicker}
            tone={design.tone}
            className={cn(
              "absolute inset-0 text-[17px] transition-opacity duration-700",
              index === phase ? "opacity-100" : "opacity-0",
            )}
          />
        ))}
      </div>
      <span className="absolute -right-3 -bottom-3 flex items-center gap-1 rounded-full border border-border bg-background px-2.5 py-1 text-[11px] font-medium shadow-[var(--shadow-card)]">
        <Check className="size-3 text-success" />
        On brand
      </span>
    </div>
  );
}

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function CalendarVisual() {
  const { ref, phase } = useLoop(4, 1200);
  const dropped = phase >= 1;
  const published = phase >= 3;
  return (
    <div ref={ref} className="grid w-full max-w-[460px] grid-cols-7 gap-1.5">
      {DAYS.map((day, index) => (
        <div key={day} className="flex flex-col gap-1.5">
          <span className="text-center text-[10.5px] font-medium text-muted-foreground">
            {day}
          </span>
          <div
            className={cn(
              "relative flex h-[92px] flex-col gap-1 rounded-xl border border-border bg-background p-1",
              index === 3 && "border-foreground/15",
            )}
          >
            {index === 0 ? (
              <MiniChip platform="facebook" tone="success" />
            ) : null}
            {index === 5 ? (
              <MiniChip platform="instagram" tone="warning" />
            ) : null}
            {index === 3 ? (
              <div
                className={cn(
                  "transition-all duration-500 ease-[var(--site-ease)]",
                  dropped
                    ? "translate-y-0 opacity-100"
                    : "-translate-y-5 opacity-0",
                )}
              >
                <MiniChip
                  platform="instagram"
                  tone={published ? "success" : "ink"}
                  strong
                />
              </div>
            ) : null}
          </div>
        </div>
      ))}
      <div className="col-span-7 mt-1 flex items-center justify-center gap-1.5 text-[11.5px] font-medium">
        <span
          className={cn(
            "size-2 rounded-full transition-colors duration-500",
            published ? "bg-success" : "bg-primary",
          )}
        />
        {published
          ? "Published · Thu 09:00"
          : dropped
            ? "Scheduled · Thu 09:00"
            : "Waiting for approval"}
      </div>
    </div>
  );
}

function MiniChip({
  platform,
  tone,
  strong = false,
}: {
  platform: "instagram" | "facebook";
  tone: "success" | "warning" | "ink";
  strong?: boolean;
}) {
  return (
    <span
      className={cn(
        "flex flex-col gap-1 rounded-md px-1 py-1",
        strong ? "bg-spark-soft" : "bg-secondary",
      )}
    >
      <span className="flex items-center justify-between">
        <PlatformIcon platform={platform} className="size-2.5" />
        <span
          className={cn(
            "size-1.5 rounded-full transition-colors duration-500",
            tone === "success" && "bg-success",
            tone === "warning" && "bg-warning",
            tone === "ink" && "bg-primary",
          )}
        />
      </span>
      <span className="h-1 w-4/5 rounded-full bg-foreground/15" />
      <span className="h-1 w-3/5 rounded-full bg-foreground/10" />
    </span>
  );
}

const BARS = [38, 52, 44, 61, 92];

export function LearnVisual() {
  const { ref, phase } = useLoop(3, 1600);
  const worked = phase >= 1;
  return (
    <div ref={ref} className="flex w-full max-w-[260px] flex-col gap-4">
      <div className="flex h-[92px] items-end gap-2">
        {BARS.map((height, index) => (
          <span
            key={height}
            className={cn(
              "flex-1 origin-bottom rounded-t-md transition-transform duration-700 ease-[var(--site-ease)]",
              index === BARS.length - 1 ? "bg-spark" : "bg-foreground/12",
            )}
            style={{
              height: `${height}%`,
              transform:
                index === BARS.length - 1 && phase === 0
                  ? "scaleY(0.45)"
                  : "scaleY(1)",
            }}
          />
        ))}
      </div>
      <div className="flex items-center justify-between">
        <span className="text-[12px] text-muted-foreground">
          <span className="text-[15px] font-semibold text-foreground tabular-nums">
            {phase === 0 ? "186" : "412"}
          </span>{" "}
          likes
        </span>
        <span
          className={cn(
            "inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-[12px] font-medium transition-colors duration-300",
            worked
              ? "bg-primary text-primary-foreground"
              : "bg-background ring-1 ring-border",
          )}
        >
          <ThumbsUp className="size-3" />
          Worked
        </span>
      </div>
    </div>
  );
}

const GREETINGS = [
  "Hello",
  "Merhaba",
  "Hallo",
  "Bonjour",
  "Hola",
  "Ciao",
  "Hoi",
  "Привет",
  "مرحبا",
  "Përshëndetje",
  "Здраво",
  "Zdravo",
  "Здравей",
  "Γεια σου",
];

export function LanguagesVisual() {
  return (
    <div className="site-fade-x w-full overflow-hidden">
      <ul className="site-marquee flex w-max items-center gap-3 pr-3">
        {[...GREETINGS, ...GREETINGS].map((word, index) => (
          <li
            key={`${word}-${index}`}
            aria-hidden={index >= GREETINGS.length ? true : undefined}
            className="rounded-full border border-border bg-background px-4 py-2 text-[15px] font-medium whitespace-nowrap shadow-[var(--shadow-card)]"
          >
            {word}
          </li>
        ))}
      </ul>
    </div>
  );
}
