import type { Metadata } from "next";
import Link from "next/link";

import { FinalCta } from "@/components/marketing/final-cta";
import { Reveal } from "@/components/marketing/reveal";
import { Section } from "@/components/marketing/section";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "How Agentelse collects, uses, and protects your data when you use our AI Growth Department.",
};

const LAST_UPDATED = "August 20, 2026";

type PolicySection = {
  id: string;
  title: string;
  body: React.ReactNode;
};

const SECTIONS: PolicySection[] = [
  {
    id: "overview",
    title: "Overview",
    body: (
      <p>
        This Privacy Policy explains how Agentelse (&ldquo;Agentelse,&rdquo;
        &ldquo;we,&rdquo; &ldquo;us&rdquo;) collects, uses, and protects
        information when you visit agentelse.com or use the Agentelse product.
        It applies to visitors, prospective customers, and customers who use
        Agentelse to run an AI Growth Department for their company.
      </p>
    ),
  },
  {
    id: "information-we-collect",
    title: "Information we collect",
    body: (
      <>
        <p>We collect the following categories of information:</p>
        <ul className="flex flex-col gap-2 pl-5 list-disc">
          <li>
            <span className="text-foreground">Account information</span> — name,
            email address, company name, and password when you create an account
            or fill out a form on our site.
          </li>
          <li>
            <span className="text-foreground">Company and workspace data</span>{" "}
            — brand information, connected integration data, campaigns,
            findings, and content created or reviewed within your Agentelse
            workspace.
          </li>
          <li>
            <span className="text-foreground">Usage data</span> — log data,
            device and browser information, and how you interact with our site
            and product.
          </li>
          <li>
            <span className="text-foreground">Communications</span> — messages
            you send us through the contact form, email, or support channels.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "how-we-use-information",
    title: "How we use information",
    body: (
      <ul className="flex flex-col gap-2 pl-5 list-disc">
        <li>To provide, operate, and improve Agentelse.</li>
        <li>
          To power research, planning, and execution work carried out on your
          behalf, within the permission levels you configure.
        </li>
        <li>To respond to inquiries and provide customer support.</li>
        <li>
          To send service updates and, where you&rsquo;ve agreed to receive
          them, product or marketing communications.
        </li>
        <li>
          To detect, investigate, and prevent fraud, abuse, and security
          incidents.
        </li>
        <li>To comply with legal obligations.</li>
      </ul>
    ),
  },
  {
    id: "ai-processing",
    title: "How AI is used with your data",
    body: (
      <p>
        Agentelse uses artificial intelligence and machine learning, including
        models operated by third-party AI providers, to analyze your company
        data and generate research, recommendations, and, where you&rsquo;ve
        granted execution permission, actions. We work with these providers
        under agreements that govern how your data may be processed and require
        appropriate safeguards. Every AI-driven capability is gated by the
        permission level you set for it — view, create, recommend, request
        approval, or execute — as described on our{" "}
        <Link href="/security" className="underline underline-offset-4">
          Security
        </Link>{" "}
        page.
      </p>
    ),
  },
  {
    id: "connected-integrations",
    title: "Connected integrations",
    body: (
      <p>
        When you connect third-party tools, such as analytics, advertising, CRM,
        or social accounts, we access only the data those integrations expose
        within the scope you authorize. You can review and revoke any connection
        at any time from your workspace settings. Data obtained through a
        connected integration is subject to this Policy as well as the
        third-party provider&rsquo;s own terms.
      </p>
    ),
  },
  {
    id: "how-we-share-information",
    title: "How we share information",
    body: (
      <>
        <p>
          We do not sell your personal information. We may share information
          with:
        </p>
        <ul className="flex flex-col gap-2 pl-5 list-disc">
          <li>
            Service providers and subprocessors who help us operate Agentelse,
            including hosting, infrastructure, and AI providers, bound by
            confidentiality and data protection obligations.
          </li>
          <li>
            Professional advisors, or in connection with a merger, acquisition,
            financing, or sale of assets.
          </li>
          <li>
            Authorities, where required to comply with law, legal process, or to
            protect rights and safety.
          </li>
          <li>Any other party, where you have given us consent to do so.</li>
        </ul>
      </>
    ),
  },
  {
    id: "data-retention",
    title: "Data retention",
    body: (
      <p>
        You control how long signals, findings, and historical company data are
        kept within your workspace. Account information is retained while your
        account is active and for a reasonable period afterward for legal,
        backup, and record-keeping purposes. You can request deletion of your
        account and associated data by contacting us at{" "}
        <a
          href="mailto:hello@agentelse.com"
          className="underline underline-offset-4"
        >
          hello@agentelse.com
        </a>
        .
      </p>
    ),
  },
  {
    id: "data-security",
    title: "Data security",
    body: (
      <p>
        Data moving between Agentelse and your connected tools is encrypted in
        transit, and data stored at rest is encrypted too. Each company&rsquo;s
        data is isolated from every other customer&rsquo;s. Every AI action is
        gated by permissions, risky actions require human approval, and all
        actions and approval decisions are logged. See our{" "}
        <Link href="/security" className="underline underline-offset-4">
          Security
        </Link>{" "}
        page for more detail.
      </p>
    ),
  },
  {
    id: "your-rights",
    title: "Your rights and choices",
    body: (
      <p>
        Depending on where you&rsquo;re located, you may have rights under
        applicable data protection law, which can include the right to access,
        correct, export, or delete your personal information, and to object to
        or restrict certain processing. You can exercise these rights, or opt
        out of marketing communications, by contacting us at{" "}
        <a
          href="mailto:hello@agentelse.com"
          className="underline underline-offset-4"
        >
          hello@agentelse.com
        </a>
        . We will respond within a reasonable time and in accordance with
        applicable law.
      </p>
    ),
  },
  {
    id: "cookies",
    title: "Cookies and similar technologies",
    body: (
      <p>
        Our site may use cookies and similar technologies that are necessary for
        it to function, and, where enabled, to understand how visitors use our
        site. You can control cookies through your browser settings; disabling
        them may affect some site functionality.
      </p>
    ),
  },
  {
    id: "childrens-privacy",
    title: "Children's privacy",
    body: (
      <p>
        Agentelse is intended for business use and is not directed at children.
        We do not knowingly collect personal information from children under the
        age of 16.
      </p>
    ),
  },
  {
    id: "international-transfers",
    title: "International data transfers",
    body: (
      <p>
        We and our service providers may process information in countries other
        than the one where you or your company are located. Where required, we
        use appropriate safeguards to protect information transferred across
        borders.
      </p>
    ),
  },
  {
    id: "changes",
    title: "Changes to this policy",
    body: (
      <p>
        We may update this Privacy Policy from time to time. If we make material
        changes, we will update the &ldquo;Last updated&rdquo; date below and,
        where appropriate, provide additional notice.
      </p>
    ),
  },
  {
    id: "contact",
    title: "Contact us",
    body: (
      <p>
        Questions about this Privacy Policy? Reach us at{" "}
        <a
          href="mailto:hello@agentelse.com"
          className="underline underline-offset-4"
        >
          hello@agentelse.com
        </a>
        .
      </p>
    ),
  },
];

export default function PrivacyPage() {
  return (
    <>
      <Section className="pb-0">
        <Reveal className="flex flex-col gap-4">
          <p className="agentelse-text-caption font-medium text-muted-foreground uppercase">
            Legal
          </p>
          <h1 className="agentelse-text-h1 max-w-[20ch] text-balance">
            Privacy Policy
          </h1>
          <p className="agentelse-text-lead max-w-[56ch] text-muted-foreground">
            Your company data stays your company data. Here&rsquo;s what we
            collect, how we use it, and the choices you have.
          </p>
          <p className="text-sm text-muted-foreground">
            Last updated: {LAST_UPDATED}
          </p>
        </Reveal>
      </Section>

      <Section tone="raised">
        <Reveal>
          <div className="flex max-w-[70ch] flex-col divide-y divide-border border-t border-border">
            {SECTIONS.map((section) => (
              <div
                key={section.id}
                className="flex flex-col gap-3 py-8 md:py-10"
              >
                <h2 className="agentelse-text-h3 text-foreground">
                  {section.title}
                </h2>
                <div className="flex flex-col gap-3 text-base text-foreground/80">
                  {section.body}
                </div>
              </div>
            ))}
          </div>
        </Reveal>
      </Section>

      <FinalCta />
    </>
  );
}
