import type { Metadata } from "next";
import Link from "next/link";
import {
  BadgeCheck,
  CircleSlash,
  CopyX,
  KeyRound,
  Lock,
  ShieldAlert,
  Trash2,
  Unplug,
} from "lucide-react";

import { appHref } from "@/lib/app-url";
import { CONTACT_EMAIL } from "@/lib/site";
import { CtaBand } from "@/components/site/cta-band";
import { PageHero } from "@/components/site/page-hero";
import { Reveal } from "@/components/site/reveal";
import { Section, SectionHeader } from "@/components/site/section";
import { CONTROLS } from "@/components/site/home/control";

export const metadata: Metadata = {
  title: "Security",
  description:
    "How Agentelse keeps you in control: approval before anything goes live, encrypted account tokens, AI guardrails, and your data never sold.",
};

const ACCOUNTS = [
  {
    Icon: KeyRound,
    title: "Official sign-in.",
    body: "Accounts connect through each platform's own login. We never see your passwords.",
  },
  {
    Icon: Lock,
    title: "Encrypted tokens.",
    body: "Access tokens are stored encrypted with AES-256-GCM.",
  },
  {
    Icon: Unplug,
    title: "Disconnect anytime.",
    body: "Remove it in Agentelse, or revoke it on the platform.",
  },
  {
    Icon: Trash2,
    title: "Delete on request.",
    body: "Ask us to delete your data, including Instagram and Facebook data.",
  },
];

const GUARDRAILS = [
  {
    Icon: ShieldAlert,
    title: "The web can't give orders.",
    body: "While a chat reads web pages, it can't change memory or approve anything.",
  },
  {
    Icon: CopyX,
    title: "No double posts.",
    body: "A lock makes sure the same post never goes out twice.",
  },
  {
    Icon: CircleSlash,
    title: "Brand rules first.",
    body: "Plans are checked for words your brand never uses.",
  },
  {
    Icon: BadgeCheck,
    title: "What you approve is final.",
    body: "Approved text and time are locked. Revisions come back for review.",
  },
];

function TileGrid({
  items,
}: {
  items: { Icon: typeof Lock; title: string; body: string }[];
}) {
  return (
    <ul className="grid gap-px overflow-hidden rounded-[1.75rem] border border-border bg-border sm:grid-cols-2">
      {items.map(({ Icon, title, body }, index) => (
        <li key={title} className="bg-card">
          <Reveal
            delayMs={(index % 2) * 70}
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
  );
}

export default function SecurityPage() {
  return (
    <>
      <PageHero
        eyebrow="Security"
        title="You're always in control."
        lead="How we keep your brand and your accounts safe."
      />

      <Section wide className="pt-0 sm:pt-0">
        <SectionHeader
          eyebrow="Approvals"
          title="You decide. Every time."
          className="mb-12"
        />
        <TileGrid items={CONTROLS} />
      </Section>

      <Section tone="muted" wide>
        <SectionHeader
          eyebrow="Your accounts"
          title="Safe to connect. Easy to remove."
          className="mb-12"
        />
        <TileGrid items={ACCOUNTS} />
      </Section>

      <Section wide>
        <SectionHeader
          eyebrow="AI guardrails"
          title="Safe by design."
          className="mb-12"
        />
        <TileGrid items={GUARDRAILS} />
      </Section>

      <Section tone="muted">
        <Reveal className="flex flex-col gap-6">
          <SectionHeader eyebrow="Your data" title="Your data is yours." />
          <div className="flex max-w-[60ch] flex-col gap-4 text-[16px] leading-relaxed text-muted-foreground">
            <p>
              We never sell it. It&apos;s used only to run Agentelse for you,
              with hosting, database and AI providers under data-protection
              terms.
            </p>
            <p>
              Read the{" "}
              <Link
                href={appHref("/privacy")}
                className="text-foreground underline underline-offset-4"
              >
                Privacy Policy
              </Link>{" "}
              and{" "}
              <Link
                href={appHref("/terms")}
                className="text-foreground underline underline-offset-4"
              >
                Terms
              </Link>
              , or{" "}
              <Link
                href={appHref("/data-deletion")}
                className="text-foreground underline underline-offset-4"
              >
                request deletion
              </Link>
              . Security question? Write to{" "}
              <a
                href={`mailto:${CONTACT_EMAIL}`}
                className="text-foreground underline underline-offset-4"
              >
                {CONTACT_EMAIL}
              </a>
              .
            </p>
          </div>
        </Reveal>
      </Section>

      <CtaBand />
    </>
  );
}
