import type { Metadata } from "next";
import { Ban, FileSearch, Gauge, Globe } from "lucide-react";

import { CONTACT_EMAIL } from "@/lib/site";
import { PageHero } from "@/components/site/page-hero";
import { Reveal } from "@/components/site/reveal";
import { Section, SectionHeader } from "@/components/site/section";

// agentelse.com/bot: Agentelse'in iki tarayıcısı (SC-F3 site denetimi
// AgentelseSiteAudit, GA-F3 etiket kontrolü AgentelseSiteCheck) kimdir, ne
// getirir, ne kadar naziktir ve nasıl sınırlanır. UA dizgileri uygulamadaki
// sabitlerle aynıdır (src/lib/seo/audit-constants.ts, GA site kontrolü).

export const metadata: Metadata = {
  title: "Agentelse bots",
  description:
    "Who AgentelseSiteAudit and AgentelseSiteCheck are, what they fetch, and how to limit or block them.",
};

const BOTS = [
  {
    token: "AgentelseSiteAudit",
    userAgent: "AgentelseSiteAudit/1.0 (+https://agentelse.com/bot)",
    body: "Our site audit. It checks websites whose owners connected Google Search Console or verified their website in Agentelse.",
  },
  {
    token: "AgentelseSiteCheck",
    userAgent: "AgentelseSiteCheck/1.0 (+https://agentelse.com/bot)",
    body: "Our tracking check. Once a week it opens the home page and a few popular pages of websites whose owners connected Google Analytics, to see if the tag is installed.",
  },
];

const FETCHES = [
  "Public pages anyone can open.",
  "Your robots.txt and your sitemaps.",
  "No forms, no logins, no JavaScript.",
  "No images, scripts or style files.",
];

const POLITE = [
  "At most 1 request per second per website.",
  "At most 500 pages a week, plus a few key pages every 6 hours.",
  "Conditional requests: unchanged pages aren't downloaded again.",
  "Backs off when your server answers 429 or 503.",
  "Follows Crawl-delay, up to 10 seconds.",
  "Reads robots.txt for every host it visits.",
];

const BLOCK_AUDIT = "User-agent: AgentelseSiteAudit\nDisallow: /";
const BLOCK_CHECK = "User-agent: AgentelseSiteCheck\nDisallow: /";

function Card({
  Icon,
  title,
  children,
}: {
  Icon: typeof Globe;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Reveal className="flex h-full flex-col gap-3 rounded-[1.75rem] border border-border bg-card p-7 sm:p-8">
      <span className="flex size-9 items-center justify-center rounded-xl bg-secondary">
        <Icon className="size-4" />
      </span>
      <p className="text-h3">{title}</p>
      <div className="flex flex-col gap-2 text-[15px] text-muted-foreground">
        {children}
      </div>
    </Reveal>
  );
}

function Code({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-xl bg-muted px-4 py-3 text-[13px] leading-relaxed text-foreground">
      <code>{children}</code>
    </pre>
  );
}

function List({ items }: { items: string[] }) {
  return (
    <ul className="flex list-disc flex-col gap-1.5 pl-5">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

export default function BotPage() {
  return (
    <>
      <PageHero
        eyebrow="Our bots"
        title="Agentelse bots."
        lead="What they fetch, how polite they are, and how to block them."
      />

      <Section wide className="pt-0 sm:pt-0">
        <SectionHeader
          eyebrow="Who"
          title="Two bots. Your sites only."
          className="mb-12"
        />
        <ul className="grid gap-4 sm:grid-cols-2">
          {BOTS.map((bot) => (
            <li key={bot.token}>
              <Card Icon={Globe} title={bot.token}>
                <p>{bot.body}</p>
                <Code>{bot.userAgent}</Code>
              </Card>
            </li>
          ))}
        </ul>
      </Section>

      <Section tone="muted" wide>
        <div className="grid gap-4 sm:grid-cols-2">
          <Card Icon={FileSearch} title="What they fetch.">
            <List items={FETCHES} />
          </Card>
          <Card Icon={Gauge} title="How polite they are.">
            <List items={POLITE} />
          </Card>
        </div>
      </Section>

      <Section wide>
        <SectionHeader
          eyebrow="Limit or block"
          title="Your robots.txt decides."
          lead="Add these lines to your robots.txt. Changes apply on the next visit."
          className="mb-12"
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Card Icon={Ban} title="Block the site audit.">
            <Code>{BLOCK_AUDIT}</Code>
          </Card>
          <Card Icon={Ban} title="Block the tracking check.">
            <Code>{BLOCK_CHECK}</Code>
          </Card>
        </div>
        <Reveal className="mt-8 max-w-[60ch] text-[16px] leading-relaxed text-muted-foreground">
          <p>
            Using a firewall or bot protection? To let the audit in, allow
            requests whose user agent contains AgentelseSiteAudit or
            AgentelseSiteCheck.
          </p>
        </Reveal>
      </Section>

      <Section tone="muted">
        <Reveal className="flex flex-col gap-6">
          <SectionHeader eyebrow="Contact" title="Questions?" />
          <p className="max-w-[60ch] text-[16px] leading-relaxed text-muted-foreground">
            Something looks wrong, or a bot visits a site it shouldn&apos;t?
            Write to{" "}
            <a
              href={`mailto:${CONTACT_EMAIL}`}
              className="text-foreground underline underline-offset-4"
            >
              {CONTACT_EMAIL}
            </a>
            .
          </p>
        </Reveal>
      </Section>
    </>
  );
}
