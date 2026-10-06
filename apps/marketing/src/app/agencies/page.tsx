import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRight,
  Download,
  Globe,
  Languages,
  Lock,
  Send,
  ShieldCheck,
} from "lucide-react";

import { START_HREF } from "@/lib/site";
import { Button } from "@/components/ui/button";
import { CtaBand } from "@/components/site/cta-band";
import { Faq, type FaqItem } from "@/components/site/faq";
import { FeatureSplit, PaneFrame } from "@/components/site/feature-split";
import { PageHero } from "@/components/site/page-hero";
import { Reveal } from "@/components/site/reveal";
import { Section, SectionHeader } from "@/components/site/section";
import { PlanPane } from "@/components/site/hero/demo-panes";
import { T } from "@/components/site/hero/timeline";
import { BrandsMock } from "@/components/site/mock/brands-mock";

export const metadata: Metadata = {
  title: "For agencies",
  description:
    "Run every client's social media from one workspace. A separate brain, style and calendar for each brand.",
};

const BENEFITS = [
  {
    Icon: Lock,
    title: "Nothing mixes.",
    body: "Each brand has its own memory, files and calendar.",
  },
  {
    Icon: Globe,
    title: "Onboard in minutes.",
    body: "Paste the client's website. Done.",
  },
  {
    Icon: Languages,
    title: "Any market.",
    body: "14 languages, every market they sell in.",
  },
  {
    Icon: Download,
    title: "Client-ready.",
    body: "Approve in bulk. Download finished posts.",
  },
  {
    Icon: Send,
    title: "Sign-off anywhere.",
    body: "Approvals on Telegram, for the people you choose.",
  },
  {
    Icon: ShieldCheck,
    title: "Safe ads.",
    body: "Ad changes start paused and need approval.",
  },
];

const FAQ: FaqItem[] = [
  {
    question: "Do client brands share anything?",
    answer:
      "No. Each brand's memory, rules, files, chats and calendar stay separate.",
  },
  {
    question: "Who approves posts?",
    answer: "You, in Agentelse, or the approvers you allow on Telegram.",
  },
  {
    question: "Can we publish for clients?",
    answer:
      "Yes, once their account is connected. Instagram posts on schedule, Facebook in one tap. TikTok, LinkedIn and X are ready for you to share.",
  },
  {
    question: "Bringing many brands?",
    answer: "Talk to us. We'll help you set them up.",
  },
];

export default function AgenciesPage() {
  return (
    <>
      <PageHero
        eyebrow="For agencies"
        title="Every client. One workspace."
        lead="A separate brain, style and calendar for each brand."
      >
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Button
            className="h-12 px-7"
            nativeButton={false}
            render={<Link href={START_HREF} />}
          >
            Start free
            <ArrowRight />
          </Button>
          <Button
            variant="secondary"
            className="h-12 px-7"
            nativeButton={false}
            render={<Link href="/contact" />}
          >
            Talk to us
          </Button>
        </div>
      </PageHero>

      <FeatureSplit
        eyebrow="Workspace"
        title="Switch clients, not tools."
        points={[
          "Every brand in one sidebar.",
          "See what's waiting at a glance.",
          "Plans stay with their brand.",
        ]}
        mock={
          <BrandsMock className="w-full max-w-[420px] shadow-[var(--shadow-float)]" />
        }
      />

      <Section tone="muted" wide>
        <SectionHeader
          eyebrow="Why agencies"
          title="More brands. Same care."
          align="center"
          className="mx-auto mb-14"
        />
        <ul className="grid gap-px overflow-hidden rounded-[1.75rem] border border-border bg-border sm:grid-cols-2 lg:grid-cols-3">
          {BENEFITS.map(({ Icon, title, body }, index) => (
            <li key={title} className="bg-card">
              <Reveal
                delayMs={(index % 3) * 70}
                className="flex h-full flex-col gap-2.5 p-7 sm:p-8"
              >
                <span className="flex size-9 items-center justify-center rounded-xl bg-secondary">
                  <Icon className="size-4" />
                </span>
                <p className="text-h3">{title}</p>
                <p className="text-[15px] text-muted-foreground">{body}</p>
              </Reveal>
            </li>
          ))}
        </ul>
      </Section>

      <FeatureSplit
        reverse
        eyebrow="Planning"
        title="A month per client. In an afternoon."
        points={[
          "One chat per client.",
          "Their rules, their style.",
          "Every post waits for approval.",
        ]}
        mock={
          <PaneFrame>
            <PlanPane pos={T.planRowsFrom + 1200} />
          </PaneFrame>
        }
      />

      <Faq items={FAQ} title="Agency questions." />
      <CtaBand title="Bring your first client in today." />
    </>
  );
}
