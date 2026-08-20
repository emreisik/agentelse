import type { Metadata } from "next";
import Link from "next/link";

import { LogoBadge } from "@/components/shared/logo-badge";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "How Agentelse collects, uses, and protects your data when you use your AI Growth Team.",
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
        information when you use the Agentelse product at agentelse.ai. It
        applies to account holders and to anyone who uses Agentelse to run an AI
        Growth Team for their company.
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
            email address, company name, and password when you create an
            account.
          </li>
          <li>
            <span className="text-foreground">Company and workspace data</span>{" "}
            — brand information, connected integration data, campaigns,
            findings, and content created or reviewed within your Agentelse
            workspace.
          </li>
          <li>
            <span className="text-foreground">Usage data</span> — log data,
            device and browser information, and how you interact with the
            product.
          </li>
          <li>
            <span className="text-foreground">Communications</span> — messages
            you send us through support channels.
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
          them, product communications.
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
        approval, or execute.
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
          href="mailto:hello@agentelse.ai"
          className="underline underline-offset-4"
        >
          hello@agentelse.ai
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
        <a
          href="https://agentelse.com/security"
          className="underline underline-offset-4"
        >
          Security
        </a>{" "}
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
        out of product communications, by contacting us at{" "}
        <a
          href="mailto:hello@agentelse.ai"
          className="underline underline-offset-4"
        >
          hello@agentelse.ai
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
        Agentelse uses cookies that are necessary for authentication and core
        functionality, such as keeping you signed in. You can control cookies
        through your browser settings; disabling them will affect your ability
        to use the product.
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
          href="mailto:hello@agentelse.ai"
          className="underline underline-offset-4"
        >
          hello@agentelse.ai
        </a>
        .
      </p>
    ),
  },
];

export default function PrivacyPage() {
  return (
    <div className="flex min-h-screen w-full flex-col bg-background">
      <header className="border-b border-border">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-6 py-5">
          <Link href="/login" className="flex items-center gap-2">
            <LogoBadge size="sm" />
            <span className="font-heading text-sm font-semibold tracking-tight">
              Agentelse
            </span>
          </Link>
          <Link
            href="/login"
            className="text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            Sign in
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-16">
        <div className="flex flex-col gap-4">
          <p className="text-sm font-medium tracking-wide text-muted-foreground uppercase">
            Legal
          </p>
          <h1 className="text-3xl font-semibold tracking-tight text-balance xl:text-4xl">
            Privacy Policy
          </h1>
          <p className="max-w-[60ch] text-base text-pretty text-muted-foreground">
            Your company data stays your company data. Here&rsquo;s what we
            collect, how we use it, and the choices you have.
          </p>
          <p className="text-sm text-muted-foreground">
            Last updated: {LAST_UPDATED}
          </p>
        </div>

        <div className="mt-12 flex flex-col divide-y divide-border border-t border-border">
          {SECTIONS.map((section) => (
            <div key={section.id} className="flex flex-col gap-3 py-8">
              <h2 className="text-xl font-semibold tracking-tight text-foreground">
                {section.title}
              </h2>
              <div className="flex flex-col gap-3 text-sm leading-relaxed text-muted-foreground">
                {section.body}
              </div>
            </div>
          ))}
        </div>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex w-full max-w-3xl flex-col-reverse items-start gap-2 px-6 py-6 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <span>© {new Date().getFullYear()} Agentelse</span>
          <div className="flex gap-4">
            <Link
              href="/privacy"
              className="transition-colors hover:text-foreground"
            >
              Privacy
            </Link>
            <Link
              href="/terms"
              className="transition-colors hover:text-foreground"
            >
              Terms
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
