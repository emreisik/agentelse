import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "How Agentelse collects, uses, and protects your data when you use your AI Growth Team.",
};

const LAST_UPDATED = "October 6, 2026";

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
    id: "instagram-data",
    title: "Instagram connection",
    body: (
      <>
        <p>
          When you connect an Instagram professional (Business or Creator)
          account, you sign in on Instagram&rsquo;s own screen and approve the
          permissions listed there. Agentelse asks for three:
        </p>
        <ul className="flex flex-col gap-2 pl-5 list-disc">
          <li>
            <span className="text-foreground">instagram_business_basic</span> —
            to read the account&rsquo;s id, username, account type, profile
            picture and follower, following and post counts, and its most recent
            posts with their like and comment counts, so we can show which
            account is connected and how it looks in your workspace, and, when
            you ask for a style analysis, the images and captions of its most
            recent posts.
          </li>
          <li>
            <span className="text-foreground">
              instagram_business_manage_insights
            </span>{" "}
            — to read the account&rsquo;s insights over the last 28 days
            (accounts reached, views, accounts that engaged and total
            interactions), so we can show how the account is doing.
          </li>
          <li>
            <span className="text-foreground">
              instagram_business_content_publish
            </span>{" "}
            — to publish posts and stories to that account: content you create
            or approve in Agentelse, and content Agentelse publishes for you if
            you switch on scheduled posting or Autopilot for a project.
          </li>
        </ul>
        <p>
          We store the access token Instagram gives us (encrypted), the account
          id, username and account type in a connection record. We use them only
          to publish content as described above, to show which account is
          connected and, when you ask, to analyze the look of your recent posts:
          their images and captions are sent to our AI provider for that
          analysis and are not stored. The profile figures, post counters and
          insights are read when you open your workspace and shown to you; we do
          not store them. We do not read your messages, the content of comments
          or who your followers are, we do not sell this data, and we do not use
          it for advertising or to train AI models.
        </p>
        <p>
          You can stop Agentelse from using the connection at any time with
          Connectors &gt; Instagram &gt; Disconnect, or by removing Agentelse in
          Instagram under Settings &gt; Apps and websites. Neither erases the
          stored connection record by itself. To have it erased, email us or, if
          Instagram offers the choice when you remove the app, ask Instagram to
          delete your data: Instagram then notifies us and we erase the record
          automatically. Instructions and the status of a request are on our{" "}
          <Link href="/data-deletion" className="underline underline-offset-4">
            data deletion page
          </Link>
          . Posts already published to Instagram remain on Instagram, and plans,
          chats and other content you created in Agentelse stay in your
          workspace until it is deleted.
        </p>
        <p>
          If you connect through a Facebook Page instead, or connect Meta Ads,
          you sign in with Facebook and approve the permissions shown there. We
          store a Meta access token (encrypted) together with the Pages and ad
          accounts you choose. You can remove that access in your Facebook
          settings under Business Integrations, or email us.
        </p>
      </>
    ),
  },
  {
    id: "facebook-and-meta-ads",
    title: "Facebook Page and Meta Ads connections",
    body: (
      <>
        <p>
          Facebook and Meta Ads are connected separately from Instagram and from
          each other: each one asks only for the permissions it needs and can be
          disconnected on its own. Facebook keeps one grant per person for
          Agentelse, though, so the Pages you allow in its dialog apply to all
          of these connections.
        </p>
        <p>When you connect a Facebook Page, Agentelse asks for:</p>
        <ul className="flex flex-col gap-2 pl-5 list-disc">
          <li>
            <span className="text-foreground">pages_show_list</span> — to list
            the Pages you manage, so you can choose one.
          </li>
          <li>
            <span className="text-foreground">pages_read_engagement</span> — to
            read the chosen Page&rsquo;s name, read back the posts Agentelse
            published there (their text and link), and obtain the Page access
            token that posting as the Page requires.
          </li>
          <li>
            <span className="text-foreground">pages_manage_posts</span> — to
            publish posts to the chosen Page (content you create or approve in
            Agentelse and choose to share on Facebook), and to change the text
            of those posts or delete them when you ask.
          </li>
          <li>
            <span className="text-foreground">business_management</span> — so
            Pages owned through a Meta Business portfolio appear in that list.
          </li>
        </ul>
        <p>When you connect Meta Ads, Agentelse asks for:</p>
        <ul className="flex flex-col gap-2 pl-5 list-disc">
          <li>
            <span className="text-foreground">ads_management</span> — to create
            and update campaigns, ad sets and ads in the ad account you choose,
            when you ask for it or approve it.
          </li>
          <li>
            <span className="text-foreground">ads_read</span> — to read how
            those campaigns perform (spend, impressions, clicks and results) for
            reports and recommendations.
          </li>
          <li>
            <span className="text-foreground">pages_show_list</span>,{" "}
            <span className="text-foreground">pages_read_engagement</span> and{" "}
            <span className="text-foreground">business_management</span> — to
            choose the Page your ads run as and to see ad accounts and Pages
            owned through a Business portfolio.
          </li>
        </ul>
        <p>
          If you connect Instagram through a Facebook Page, Agentelse also asks
          for <span className="text-foreground">instagram_basic</span>,{" "}
          <span className="text-foreground">instagram_content_publish</span> and{" "}
          <span className="text-foreground">instagram_manage_insights</span>, to
          find the Instagram account linked to that Page, publish to it, show
          its profile figures, recent posts and insights, and read its recent
          posts for a style analysis you ask for, as described in the Instagram
          section above.
        </p>
        <p>
          We store the Meta access token (encrypted), your name on Facebook, the
          Pages and ad accounts you can choose from and the ones you chose, the
          ids of posts Agentelse shared on your Page, a copy of your campaigns,
          ad sets and ads (names, status, budgets and schedule) and their daily
          performance figures (spend, impressions, reach, clicks and results).
          We keep the daily figures for 400 days, and for individual ads for 180
          days, so we can show trends, pace your budget and warn you about
          problems; a campaign that no longer exists in Meta is removed from our
          copy after 90 days. Page access tokens are derived when needed and
          never stored. We use this data only to publish and manage what you ask
          for and to show and analyze your results. Campaign performance figures
          may be processed by our AI provider to produce recommendations, and so
          may the names of your connected Page and accounts, so the assistant
          knows where it can publish (see How AI is used with your data). We do
          not sell this data and we do not use it to train AI models.
        </p>
        <p>
          You can stop Agentelse from using either connection with Connectors
          &gt; Facebook &gt; Disconnect or Connectors &gt; Meta Ads &gt;
          Disconnect, or by removing Agentelse in Facebook under Settings &gt;
          Business Integrations. Neither erases the stored record by itself; to
          have it erased, email us (see the{" "}
          <Link href="/data-deletion" className="underline underline-offset-4">
            data deletion page
          </Link>
          ). Posts and ads already published stay on Facebook and Instagram
          until you remove them there.
        </p>
      </>
    ),
  },
  {
    id: "google-analytics-and-search-console",
    title: "Google Analytics and Search Console connections",
    body: (
      <>
        <p>
          Google Analytics and Google Search Console are two separate
          connections: you connect, and disconnect, each one on its own, and
          each one asks Google only for its own permission. Both are read-only;
          Agentelse never changes anything in your Google accounts.
        </p>
        <ul className="flex flex-col gap-2 pl-5 list-disc">
          <li>
            Google Analytics asks for &ldquo;See and download your Google
            Analytics data&rdquo; (analytics.readonly), to show your website
            traffic and results in reports, check that your tracking works and
            suggest improvements.
          </li>
          <li>
            Google Search Console asks for &ldquo;View Search Console data for
            your verified sites&rdquo; (webmasters.readonly), to show how your
            site appears in Google Search and suggest content and SEO
            improvements.
          </li>
          <li>
            Both also ask for your email address, so we can show which Google
            account is connected and tell your connections apart.
          </li>
        </ul>
        <p>
          We store the access Google gives us (an encrypted refresh token), the
          connected Google account&rsquo;s email address and account id, the
          list of properties or sites that account can see, the one you
          selected, and the result of your last connection test. Reports and
          suggestions read your figures when they are built: summary figures
          (such as users, sessions, clicks and impressions) and your top search
          queries are shown to you, kept with the report or suggestion they
          belong to, and may be processed by our AI provider to write summaries
          and ideas (see How AI is used with your data). We do not sell this
          data, we do not use it for advertising and we do not use it to train
          AI models. People at Agentelse do not read it unless you ask us to, or
          when it is needed for security or required by law.
        </p>
        <p>
          Agentelse&rsquo;s use of information received from Google APIs will
          adhere to{" "}
          <a
            href="https://developers.google.com/terms/api-services-user-data-policy"
            className="underline underline-offset-4"
            target="_blank"
            rel="noreferrer"
          >
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements.
        </p>
        <p>
          Disconnecting a Google connection in Connectors deletes its stored
          token and the Google data in that connection right away. We also
          remove Agentelse&rsquo;s access in your Google account, unless the
          same Google account is still used by another of your Agentelse Google
          connections; Google removes access for an app as a whole, so doing it
          then would disconnect that one too. You can remove Agentelse&rsquo;s
          access yourself at any time in your Google Account under Security &gt;
          Third-party apps and services, which stops both connections. To have
          reports and suggestions built from your Google data erased as well,
          email us (see the{" "}
          <Link href="/data-deletion" className="underline underline-offset-4">
            data deletion page
          </Link>
          ).
        </p>
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
          <Link href="/login" className="flex items-center">
            <img src="/logo.png" alt="Agentelse" className="h-6 w-auto" />
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
            <div
              key={section.id}
              id={section.id}
              className="flex flex-col gap-3 py-8 scroll-mt-24"
            >
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
