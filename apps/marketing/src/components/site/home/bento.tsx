import { cn } from "@/lib/utils";
import { Section, SectionHeader } from "@/components/site/section";
import { Reveal } from "@/components/site/reveal";
import {
  BrandVisual,
  CalendarVisual,
  ChannelsVisual,
  LanguagesVisual,
  LearnVisual,
  LooksVisual,
} from "@/components/site/home/bento-visuals";

const TILES = [
  {
    title: "Knows your brand.",
    body: "Logo, colors, fonts and voice. Read from your website.",
    Visual: BrandVisual,
    wide: true,
  },
  {
    title: "Looks like you.",
    body: "Your layouts and logo, pixel-perfect.",
    Visual: LooksVisual,
    wide: false,
  },
  {
    title: "One plan. Every channel.",
    body: "Each idea, made for every format.",
    Visual: ChannelsVisual,
    wide: false,
  },
  {
    title: "Posts on time.",
    body: "Instagram on schedule. Facebook in one tap.",
    Visual: CalendarVisual,
    wide: true,
  },
  {
    title: "Learns what works.",
    body: "Every result shapes the next plan.",
    Visual: LearnVisual,
    wide: false,
  },
  {
    title: "Speaks 14 languages.",
    body: "Plan for every market you sell in.",
    Visual: LanguagesVisual,
    wide: true,
  },
];

export function Bento() {
  return (
    <Section tone="muted" wide>
      <SectionHeader
        eyebrow="Features"
        title="Everything your social media needs."
        align="center"
        className="mx-auto mb-14 md:mb-16"
      />
      <ul className="grid gap-4 lg:grid-cols-3">
        {TILES.map(({ title, body, Visual, wide }, index) => (
          <li key={title} className={cn(wide && "lg:col-span-2")}>
            <Reveal
              delayMs={(index % 2) * 80}
              className="flex h-full flex-col overflow-hidden rounded-[1.75rem] border border-border bg-card"
            >
              <div className="flex min-h-[240px] flex-1 items-center justify-center px-6 pt-8 pb-4 sm:px-10">
                <Visual />
              </div>
              <div className="flex flex-col gap-1 px-7 pt-3 pb-7">
                <p className="text-h3">{title}</p>
                <p className="text-[15px] text-muted-foreground">{body}</p>
              </div>
            </Reveal>
          </li>
        ))}
      </ul>
    </Section>
  );
}
