import type { Metadata } from "next";
import Link from "next/link";
import { BarChart3, Megaphone, Search } from "lucide-react";

import { CtaBand } from "@/components/site/cta-band";
import { FeatureSplit, PaneFrame } from "@/components/site/feature-split";
import { PageHero } from "@/components/site/page-hero";
import { Reveal } from "@/components/site/reveal";
import { Section, SectionHeader } from "@/components/site/section";
import { DemoChat, ResultsCard } from "@/components/site/hero/demo-chat";
import {
  BrandPane,
  CalendarPane,
  PlanPane,
  PostPane,
} from "@/components/site/hero/demo-panes";
import { T } from "@/components/site/hero/timeline";
import { PlatformIcon, type Platform } from "@/components/site/mock/parts";

export const metadata: Metadata = {
  title: "Product",
  description:
    "One chat for all your social media: Brand Brain, plans for every channel, on-brand posts, a content calendar, publishing and results.",
};

const CHAPTERS = [
  { href: "#chat", label: "Chat" },
  { href: "#brand-brain", label: "Brand Brain" },
  { href: "#plans", label: "Plans" },
  { href: "#posts", label: "Posts" },
  { href: "#calendar", label: "Calendar" },
  { href: "#results", label: "Results" },
  { href: "#integrations", label: "Integrations" },
];

const CONNECTIONS: {
  platforms: Platform[];
  name: string;
  does: string;
  how: string;
}[] = [
  {
    platforms: ["instagram"],
    name: "Instagram",
    does: "Posts and Stories. Reach and engagement.",
    how: "Automatic after approval",
  },
  {
    platforms: ["facebook"],
    name: "Facebook Page",
    does: "Page posts.",
    how: "One tap after approval",
  },
  {
    platforms: ["tiktok", "linkedin", "x"],
    name: "TikTok, LinkedIn, X",
    does: "Ready-made posts to share.",
    how: "You post",
  },
  {
    platforms: ["meta-ads"],
    name: "Meta Ads",
    does: "Campaigns, budgets and new ads.",
    how: "Starts paused, needs approval",
  },
  {
    platforms: ["analytics", "search-console"],
    name: "Google Analytics, Search Console",
    does: "Traffic and search data.",
    how: "Read-only",
  },
  {
    platforms: ["telegram"],
    name: "Telegram",
    does: "Alerts and approvals.",
    how: "Approve in the chat",
  },
];

const NEXT = [
  {
    Icon: Megaphone,
    title: "Ads Manager",
    body: "Meta campaigns, from brief to launch.",
  },
  {
    Icon: BarChart3,
    title: "Analytics",
    body: "All your numbers in one report.",
  },
  {
    Icon: Search,
    title: "SEO Manager",
    body: "Keywords, articles and on-page checks.",
  },
];

export default function ProductPage() {
  return (
    <>
      <PageHero
        eyebrow="Product"
        title="One chat. All your social media."
        lead="Plan, create, approve, publish and learn. In one place."
      >
        <nav
          aria-label="On this page"
          className="flex flex-wrap justify-center gap-2"
        >
          {CHAPTERS.map((chapter) => (
            <Link
              key={chapter.href}
              href={chapter.href}
              className="rounded-full border border-border bg-background px-3.5 py-1.5 text-sm text-foreground/80 transition-colors hover:border-foreground/30 hover:text-foreground"
            >
              {chapter.label}
            </Link>
          ))}
        </nav>
      </PageHero>

      <FeatureSplit
        id="chat"
        eyebrow="Chat"
        title="Just ask."
        points={[
          "Plans, posts and answers in one chat.",
          "Keeps working when you leave.",
          "Always shows your next step.",
        ]}
        mock={
          <PaneFrame className="flex max-w-[520px] flex-col bg-card">
            <DemoChat pos={T.readyLine + 600} />
          </PaneFrame>
        }
      />

      <FeatureSplit
        id="brand-brain"
        tone="muted"
        reverse
        eyebrow="Brand Brain"
        title="It knows your brand."
        points={[
          "Reads your website in seconds.",
          "Follows your post style kit.",
          "Checks your brand rules.",
        ]}
        mock={
          <PaneFrame>
            <BrandPane pos={T.countTo + 200} />
          </PaneFrame>
        }
      />

      <FeatureSplit
        id="plans"
        eyebrow="Plans"
        title="One plan. Every channel."
        points={[
          "Pick the channels you want.",
          "Swap any idea in one click.",
          "Add Stories with one switch.",
        ]}
        mock={
          <PaneFrame>
            <PlanPane pos={T.planRowsFrom + 1200} />
          </PaneFrame>
        }
      />

      <FeatureSplit
        id="posts"
        tone="muted"
        reverse
        eyebrow="Posts"
        title="See it before it posts."
        points={[
          "Your layouts and logo, exact.",
          "Revise it in one sentence.",
          "Approve one, or all at once.",
        ]}
        mock={
          <PaneFrame>
            <PostPane pos={T.postPane + 300} />
          </PaneFrame>
        }
      />

      <FeatureSplit
        id="calendar"
        eyebrow="Calendar"
        title="Always on time."
        points={[
          "Drag to reschedule.",
          "Instagram posts by itself.",
          "Facebook goes out in one tap.",
        ]}
        mock={
          <PaneFrame>
            <CalendarPane pos={T.published + 300} />
          </PaneFrame>
        }
      />

      <FeatureSplit
        id="results"
        tone="muted"
        reverse
        eyebrow="Results"
        title="It learns what works."
        points={[
          "Likes and comments vs. your average.",
          "Tell it what worked.",
          "Every plan gets sharper.",
        ]}
        mock={
          <div aria-hidden="true" className="w-full max-w-[420px] text-left">
            <ResultsCard pos={T.worked + 500} />
          </div>
        }
      />

      <Section id="integrations" wide>
        <SectionHeader
          eyebrow="Integrations"
          title="What's automatic. What's not."
          className="mb-12"
        />
        <Reveal>
          <div className="overflow-hidden rounded-[1.75rem] border border-border">
            <table className="w-full border-collapse text-left">
              <thead className="hidden bg-muted text-xs text-muted-foreground md:table-header-group">
                <tr>
                  <th scope="col" className="px-6 py-3.5 font-medium">
                    Connection
                  </th>
                  <th scope="col" className="px-6 py-3.5 font-medium">
                    What it does
                  </th>
                  <th scope="col" className="px-6 py-3.5 font-medium">
                    How
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {CONNECTIONS.map((row) => (
                  <tr
                    key={row.name}
                    className="flex flex-col gap-2 px-6 py-5 md:table-row md:p-0"
                  >
                    <th
                      scope="row"
                      className="font-medium md:px-6 md:py-5 md:align-middle"
                    >
                      <span className="flex items-center gap-2.5">
                        <span className="flex items-center gap-1">
                          {row.platforms.map((platform) => (
                            <PlatformIcon
                              key={platform}
                              platform={platform}
                              className="size-4"
                            />
                          ))}
                        </span>
                        <span className="text-[15px]">{row.name}</span>
                      </span>
                    </th>
                    <td className="text-[15px] text-muted-foreground md:px-6 md:py-5 md:align-middle">
                      {row.does}
                    </td>
                    <td className="md:px-6 md:py-5 md:align-middle">
                      <span className="inline-flex rounded-full bg-secondary px-2.5 py-1 text-xs font-medium whitespace-nowrap">
                        {row.how}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Reveal>
      </Section>

      <Section tone="muted" wide>
        <SectionHeader
          eyebrow="On the way"
          title="Coming next."
          className="mb-12"
        />
        <ul className="grid gap-4 md:grid-cols-3">
          {NEXT.map(({ Icon, title, body }, index) => (
            <li key={title}>
              <Reveal
                delayMs={index * 70}
                className="flex h-full flex-col gap-3 rounded-[1.5rem] border border-border bg-card p-7"
              >
                <span className="flex items-center justify-between">
                  <Icon className="size-5" />
                  <span className="rounded-full bg-secondary px-2.5 py-1 text-xs text-muted-foreground">
                    Coming soon
                  </span>
                </span>
                <p className="text-h3">{title}</p>
                <p className="text-[15px] text-muted-foreground">{body}</p>
              </Reveal>
            </li>
          ))}
        </ul>
      </Section>

      <CtaBand />
    </>
  );
}
