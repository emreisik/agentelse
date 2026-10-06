import {
  BadgeCheck,
  CirclePause,
  Clock,
  Gauge,
  Send,
  Workflow,
} from "lucide-react";

import { Section } from "@/components/site/section";
import { Reveal } from "@/components/site/reveal";

export const CONTROLS = [
  {
    Icon: BadgeCheck,
    title: "Nothing posts without your OK.",
    body: "Your approval is the only way a post goes live.",
  },
  {
    Icon: Clock,
    title: "Late posts wait.",
    body: "Missed its time? It's held until you choose a new one.",
  },
  {
    Icon: CirclePause,
    title: "Ads start paused.",
    body: "Every ad change needs approval. Budgets are capped.",
  },
  {
    Icon: Gauge,
    title: "Limits per brand.",
    body: "Set daily AI limits and budgets in plain settings.",
  },
  {
    Icon: Workflow,
    title: "Autopilot is opt-in.",
    body: "It can prepare drafts on its own. Never publish them.",
  },
  {
    Icon: Send,
    title: "Approve from Telegram.",
    body: "Get a message, tap approve. Done.",
  },
];

export function Control() {
  return (
    <Section tone="ink" wide>
      <Reveal className="flex flex-col items-center gap-4 text-center">
        <p className="text-sm font-medium text-primary-foreground/55">
          You stay in charge
        </p>
        <h2 className="text-h2 max-w-[14ch] text-balance">
          You approve. Always.
        </h2>
      </Reveal>
      <ul className="mt-14 grid gap-px overflow-hidden rounded-[1.75rem] bg-primary-foreground/10 sm:grid-cols-2 lg:grid-cols-3">
        {CONTROLS.map(({ Icon, title, body }, index) => (
          <li key={title} className="bg-primary">
            <Reveal
              delayMs={(index % 3) * 70}
              className="flex h-full flex-col gap-2.5 p-7 sm:p-8"
            >
              <Icon className="size-5 text-[oklch(0.78_0.14_293)]" />
              <p className="text-[17px] font-medium tracking-tight">{title}</p>
              <p className="text-sm leading-relaxed text-primary-foreground/55">
                {body}
              </p>
            </Reveal>
          </li>
        ))}
      </ul>
    </Section>
  );
}
