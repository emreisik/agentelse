import type { Metadata } from "next";

import { FinalCta } from "@/components/marketing/final-cta";
import { Reveal } from "@/components/marketing/reveal";
import { Section } from "@/components/marketing/section";

export const metadata: Metadata = {
  title: "Security",
  description:
    "How Agentelse keeps your company data separated, permissioned, and under human control.",
};

type Principle = {
  id: string;
  title: string;
  body: string;
};

const PRINCIPLES: Principle[] = [
  {
    id: "encrypted-connections",
    title: "Encrypted connections",
    body: "Data moving between Agentelse and your connected tools is encrypted in transit, and data stored at rest is encrypted too.",
  },
  {
    id: "separated-company-data",
    title: "Separated company data",
    body: "Each company's data is isolated from every other customer's. Nothing is shared or pooled across tenants.",
  },
  {
    id: "permissions-on-every-action",
    title: "Permissions on every action",
    body: "Every capability Agentelse has is gated by the permission level you set: view, create, recommend, request approval, or execute. This is the same Human Control model described on the homepage, enforced down to the level of individual actions.",
  },
  {
    id: "human-approvals",
    title: "Human approvals for risky work",
    body: "Actions with real-world consequences, like publishing, ad spend, or account changes, require a person to approve before they happen.",
  },
  {
    id: "audit-history",
    title: "Audit history",
    body: "Every action Agentelse takes, and every approval decision a person makes, is logged and reviewable.",
  },
  {
    id: "controlled-integrations",
    title: "Controlled integrations",
    body: "Connected tools, like analytics, ads, CRM, and social accounts, are scoped to only the access they need. You can review and revoke a connection at any time.",
  },
  {
    id: "configurable-data-retention",
    title: "Configurable data retention",
    body: "You control how long signals, findings, and historical data are kept.",
  },
];

export default function SecurityPage() {
  return (
    <>
      <Section className="pb-0">
        <Reveal className="flex flex-col gap-4">
          <p className="agentelse-text-caption font-medium text-muted-foreground uppercase">
            Security
          </p>
          <h1 className="agentelse-text-h1 max-w-[24ch] text-balance">
            Your company data stays your company data.
          </h1>
          <p className="agentelse-text-lead max-w-[56ch] text-muted-foreground">
            Agentelse works inside your company&rsquo;s real systems and real
            data, so it&rsquo;s built with strict data separation and human
            control from day one, not added on afterward.
          </p>
        </Reveal>
      </Section>

      <Section tone="raised">
        <Reveal>
          <div className="border-t border-border">
            {PRINCIPLES.map((principle) => (
              <div
                key={principle.id}
                className="grid gap-2 border-b border-border py-8 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] sm:gap-8 md:py-10"
              >
                <h3 className="agentelse-text-h3 text-foreground">
                  {principle.title}
                </h3>
                <p className="max-w-[60ch] text-base text-foreground/80">
                  {principle.body}
                </p>
              </div>
            ))}
          </div>
        </Reveal>

        <Reveal delayMs={80} className="mt-8">
          <p className="text-sm text-muted-foreground">
            Built with enterprise-grade security principles.
          </p>
        </Reveal>
      </Section>

      <FinalCta />
    </>
  );
}
