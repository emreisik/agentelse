"use client";

import { useEffect, useRef, useState } from "react";
import type { IconType } from "react-icons";
import { FaLinkedin } from "react-icons/fa6";
import {
  SiGmail,
  SiGoogleanalytics,
  SiInstagram,
  SiMeta,
  SiTelegram,
  SiTiktok,
  SiX,
} from "react-icons/si";

import { cn } from "@/lib/utils";

// Symbol-only marks, so each gets its name set alongside the icon — the
// same icon+name pattern real integration/logo rows use.
// Exactly 8 logos: with 4 visible slots changing one at a time every second,
// the full pool cycles (and visibly restarts from the first logo) every 8s.
const LOGO_POOL: { name: string; Icon: IconType; wordmark?: boolean }[] = [
  { name: "Telegram", Icon: SiTelegram },
  { name: "Google Analytics", Icon: SiGoogleanalytics },
  { name: "Instagram", Icon: SiInstagram },
  { name: "Meta Ads", Icon: SiMeta },
  { name: "TikTok", Icon: SiTiktok },
  { name: "LinkedIn", Icon: FaLinkedin },
  { name: "Gmail", Icon: SiGmail },
  { name: "X", Icon: SiX },
];

const SLOT_COUNT = 4;
const LOGO_CHANGE_INTERVAL_MS = 1_000;
const INITIAL_SLOTS = Array.from({ length: SLOT_COUNT }, (_, index) => index);

// Four fixed slots; every second ONE slot (left-to-right) transitions upward
// to the next unused logo from the pool. Every visible slot therefore changes
// once per four seconds without multiple logos moving at the same time.
export function IntegrationIcons({ className }: { className?: string }) {
  const [slots, setSlots] = useState<number[]>(INITIAL_SLOTS);
  const cursor = useRef({ nextLogo: SLOT_COUNT, nextSlot: 0 });

  useEffect(() => {
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (reduceMotion) return;
    const id = window.setInterval(() => {
      setSlots((prev) => {
        const { nextLogo, nextSlot } = cursor.current;
        const next = [...prev];
        next[nextSlot] = nextLogo % LOGO_POOL.length;
        cursor.current = {
          nextLogo: nextLogo + 1,
          nextSlot: (nextSlot + 1) % SLOT_COUNT,
        };
        return next;
      });
    }, LOGO_CHANGE_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className={cn("w-full", className)}>
      {/* Mobile: one continuous right-to-left marquee, evenly spaced, no
          per-item jumps — the pool is duplicated once so the 0%→-50%
          loop is seamless. */}
      <div className="agentelse-marquee-mask overflow-hidden sm:hidden">
        <div className="agentelse-marquee-track flex w-max items-center gap-10">
          {[...LOGO_POOL, ...LOGO_POOL].map((logo, index) => (
            <LogoMark key={`${logo.name}-${index}`} {...logo} />
          ))}
        </div>
      </div>

      {/* Tablet/desktop: fixed slots, one logo fades in at a time. */}
      <div className="mx-auto hidden w-full max-w-4xl grid-cols-4 items-center justify-items-center gap-x-3 gap-y-10 sm:grid sm:gap-x-6 xl:gap-x-10">
        {slots.map((logoIndex, slot) => {
          const logo = LOGO_POOL[logoIndex] ?? LOGO_POOL[0]!;
          return (
            <span
              key={slot}
              className="flex h-12 w-full min-w-0 items-center justify-center"
            >
              <span
                key={logo.name}
                className="animate-in fade-in slide-in-from-bottom-2 inline-flex duration-300 motion-reduce:animate-none"
              >
                <LogoMark {...logo} />
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

function LogoMark({ name, Icon, wordmark }: (typeof LOGO_POOL)[number]) {
  return (
    <span className="flex shrink-0 items-center justify-center gap-1.5 text-foreground sm:gap-2.5">
      <Icon
        className={wordmark ? "h-6 w-auto sm:h-8" : "size-6 shrink-0 sm:size-8"}
        aria-hidden="true"
      />
      {wordmark ? (
        <span className="sr-only">{name}</span>
      ) : (
        <span className="text-sm font-semibold whitespace-nowrap sm:text-base">
          {name}
        </span>
      )}
    </span>
  );
}
