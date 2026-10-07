import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "How Agentelse collects, uses, and protects your data when you use your AI Growth Team.",
};

const LAST_UPDATED = "October 7, 2026";

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
            when you ask for it or approve it. If a workspace owner or admin
            turns on Ads autopilot for a project, Agentelse may also pause ads or
            lower their budgets on its own to protect your spend (and, in Full
            auto, raise a budget by a limited amount within the monthly cap they
            set); each such change is reported to you and can be undone.
            Agentelse may also add a safety rule to your ad account that pauses
            an Agentelse campaign when it spends more than twice its daily budget
            in a day; the rule is removed when you disconnect.
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
          copy after 90 days. When Meta notifies us that an ad&rsquo;s status
          changed (for example, it was rejected), we keep that notice for 14
          days. If an agency connects a client&rsquo;s business through
          Facebook Login for Business, we store that business login&rsquo;s
          access token (encrypted with a separate key), the business id and
          the ad accounts and Pages it can use. For each ad set we keep a short
          summary of its targeting (locations, age range, genders and audience
          ids, never the people in an audience) to spot ad sets that compete
          for the same people. If you run lead ads, the details people send stay
          in Meta (Leads Center); Agentelse only counts how many arrived and
          never reads or stores them. Page access tokens are derived when needed
          and never stored. We use this data only to publish and manage what you
          ask for and to show and analyze your results. Campaign performance
          figures may be processed by our AI provider to produce
          recommendations, and so may the names of your connected Page and
          accounts, so the assistant knows where it can publish (see How AI is
          used with your data). We do not sell this data and we do not use it to
          train AI models.
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
          each one asks Google only for its own permission. Search Console is
          always read-only. Google Analytics is read-only unless you choose to
          turn on an optional extra permission (see below). Without that extra
          permission, Agentelse never changes anything in your Google accounts.
        </p>
        <ul className="flex flex-col gap-2 pl-5 list-disc">
          <li>
            Google Analytics asks for &ldquo;See and download your Google
            Analytics data&rdquo; (analytics.readonly), to show your website
            traffic and results in reports, check that your tracking works and
            suggest improvements.
          </li>
          <li>
            If you choose to let Agentelse make approved changes to Google
            Analytics, a second Google screen asks for &ldquo;Edit Google
            Analytics management entities&rdquo; (analytics.edit). It is
            optional. Agentelse only uses it for small fixes you ask for and a
            workspace owner or admin approves one by one: marking a key event,
            raising event data retention to 14 months, turning on enhanced
            measurement items that are off, adding an &ldquo;AI
            assistants&rdquo; channel group, and adding dated notes
            (annotations) to your reports. It also lets Agentelse read your
            property&rsquo;s change history once a day, to tell you if something
            was changed in Google Analytics outside Agentelse; the history
            itself is not stored, only an alert in the app. Agentelse keeps a
            record of each change (what it was and how it was before and after)
            so you can undo it, for up to 24 months while Google Analytics stays
            connected, and deletes that record when you disconnect. You can turn
            editing off at any time in Connectors. That stops Agentelse right
            away; to also remove the permission at Google, remove Agentelse in
            your Google Account settings (Security, third-party access).
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
          For Google Analytics we also keep daily summaries of your
          website&rsquo;s figures (such as users, sessions, engagement and key
          events, broken down by channel, landing page, page, event, device and
          country), so reports and trends load quickly: up to 400 days, and 95
          days for page and campaign detail, after which page, source, campaign,
          device and country detail is kept only as weekly summaries for up to
          400 days. Monthly summaries (totals, channels and your top 50 landing
          pages) are kept for up to 36 months. We also keep weekly summaries of
          the words visitors search for on your site (up to 400 days) and, when
          your property is linked to Google Ads or Search Console, ad cost and
          click summaries per campaign (up to 400 days) and Google Search clicks
          per landing page (95 days). These are totals, never individual
          visitors. Page addresses are stored without query strings, and email
          addresses, phone numbers and similar personal details in them and in
          search words are masked. The &ldquo;Today so far&rdquo; and &ldquo;Right
          now&rdquo; figures are read from Google while you look at them and are
          not stored.
        </p>
        <p>
          When website reports are on, Agentelse writes daily, weekly and
          monthly website reports from these stored Google Analytics summaries
          into a &ldquo;Website analytics&rdquo; chat in your project, and keeps
          each report as it was sent so later changes in Google Analytics do not
          alter it. Daily notes and tracking alerts are kept for 95 days, and
          weekly reports, monthly reports and plans for 400 days. If you set
          website goals, Agentelse updates their progress from Google Analytics
          every day. To write the short summary at the top of a weekly or
          monthly report, the report&rsquo;s aggregated figures and at most 20
          masked page addresses or event names are sent to our AI provider; they
          are not stored there and are not used to train AI models. Telegram
          messages never contain Google Analytics figures, page addresses or
          campaign names. When you disconnect Google Analytics, these reports
          and the goal progress taken from it are deleted right away.
        </p>
        <p>
          When link tracking is on, Agentelse adds standard tracking tags (UTM
          parameters) to the links it puts in your ads and to the Instagram bio
          link it makes for you, and keeps a short record of each tagged link
          (the address and what it belongs to) until the project is deleted.
          With Google Analytics connected, Agentelse matches the visits these
          links bring, using the stored campaign summaries, to your ads and
          posts; shows them next to your ad figures from Meta; may add Google
          Analytics visit counts to the evidence of ad suggestions; and may save
          a short lesson without any figures to your Brand Brain when a tagged
          link clearly does better or worse than the rest of your website. These
          lessons and the Google Analytics figures added to ad suggestions are
          deleted right away when you disconnect Google Analytics. You can turn
          link tracking off in Settings → Publishing.
        </p>
        <p>
          Agentelse also analyses these stored Google Analytics summaries to
          point out what changed and where your website can do better (for
          example a landing page that gets visits but few leads). Findings are
          shown only to you and your team and are deleted at the latest 24
          months after they are closed. Short, figure-free notes derived from
          them (signals in Brand Brain, lessons such as &ldquo;improving a
          landing page raised its key event rate&rdquo;, and article ideas
          marked &ldquo;From your website&rdquo;) stay while you are connected.
          All of this is deleted right away when you disconnect, except ideas
          you have already used and tasks you have already accepted. To explain
          the most important findings, answer your questions in chat and suggest
          website ideas, the aggregated figures behind them and at most 20
          masked page addresses or search words per request are sent to our AI
          provider; they are not stored there and are not used to train AI
          models.
        </p>
        <p>
          To check that your Google Analytics tracking works, Agentelse also
          runs measurement checks: it compares your stored daily summaries,
          reads your property&rsquo;s settings and, once a week (or when you ask
          us to check again), asks Google for page addresses that look like they
          contain personal details. We keep only the results and counts (for
          example how many pages were affected and which parameter names, such
          as &ldquo;email&rdquo;, appeared), never the addresses or the personal
          details themselves. Once a week we also open your website&rsquo;s home
          page and up to five popular pages as &ldquo;AgentelseSiteCheck&rdquo;,
          following your robots.txt, to see whether the Google Analytics tag is
          installed. Alerts about these checks are shown in Agentelse and, for
          critical problems, sent to your project&rsquo;s own Telegram chat if
          you connected one; they never include your figures.
        </p>
        <p>
          For Google Search Console we also keep summaries of how your site
          appears in Google Search: daily totals (clicks, impressions and
          average position) by search type, country, device and search
          appearance, and weekly and monthly totals for your search queries and
          pages. Agentelse keeps your Search Console history, including data
          older than the 16 months Google keeps: daily totals and monthly
          summaries for as long as the connection exists, weekly query and page
          summaries for 36 months, query-by-page detail for 16 months, and daily
          breakdowns for 16 months, after which we keep them only as monthly
          breakdowns. In Connectors you can choose to keep only the last 16
          months, or delete the stored history anytime; disconnecting deletes it
          all right away. The weekly and monthly Search reports Agentelse
          writes from this data are kept for up to 36 months (16 months if you
          chose to keep only the last 16 months; daily notes for 90 days) and
          are deleted with it. If you choose a different site, the previous
          site&rsquo;s data is deleted after 30 days. Searches Google hides for
          privacy never reach us. Page addresses are stored without query
          strings, and email addresses, phone numbers and similar personal
          details in search queries and addresses are masked.
        </p>
        <p>
          When you connect Google Search Console, or verify your website in
          Agentelse (with a meta tag on your homepage or a DNS TXT record we look
          up), our site audit (AgentelseSiteAudit, described at
          agentelse.com/bot) visits the public pages of that website only: the
          pages anyone can open, plus its robots.txt and sitemaps. It makes at
          most one request per second and checks at most 500 pages a week plus a
          few key pages every 6 hours, and it follows your robots.txt. We store
          each page&rsquo;s address, status code, title, meta description,
          headings, language, Open Graph tags, structured-data types, hreflang
          links, internal links with their link text, and a few technical
          measurements such as size and response time, plus a copy of your
          robots.txt. We don&rsquo;t store the page text, only a fingerprint
          used to spot duplicate pages. For Search Console we also keep
          Google&rsquo;s index status for a sample of your pages (URL
          Inspection, at most 200 checks a day), the status of your sitemaps and
          the alerts based on them; disconnecting Search Console deletes these
          right away. Alerts based on Search Console data are shown in
          Agentelse; for a critical one we may also send your project&rsquo;s
          own Telegram chat a short notice with no figures, pages or findings.
          Core Web Vitals come from Google&rsquo;s public Chrome
          UX Report. You can turn the audit off or delete its data anytime on
          the Search page.
        </p>
        <p>
          From your Search Console data Agentelse also finds search
          opportunities, such as pages close to the first page, pages losing
          clicks or searches with no matching page, and keeps them, with the
          figures they are based on, for up to 24 months or until you
          disconnect. To group your searches into topics, the search words
          (with personal details masked) are sent once to our AI provider to
          compute a numeric representation, which we keep with the search; our
          AI provider may also receive a small sample of search words and page
          addresses (never more than 20 at a time) to classify searches, name
          topics, suggest spellings of your brand and write short explanations.
          Disconnecting Search Console deletes these opportunities, topic
          groups and suggestions right away, together with the article ideas
          made from them that you haven&rsquo;t used yet. If you use the
          monthly SEO content plan, Agentelse stores the search topics and
          article suggestions it is built from; Disconnect or Delete stored
          data removes them, and drafts you have not started are removed from
          your calendar.
        </p>
        <p>
          When you tell Agentelse you changed a page, it checks your public page
          and compares your Search Console numbers before and after the change
          to show what it did; these results are deleted right away when you
          disconnect Search Console. When you ask the SEO Manager to rewrite a
          page&rsquo;s title or description or to refresh an article, a few of
          that page&rsquo;s top search words (personal details masked, at most
          10) and the page text are sent to our AI provider to write the
          suggestion; they are not used to train AI models and are not stored
          there.
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
    id: "wordpress-and-website-changes",
    title: "WordPress connection and website changes",
    body: (
      <>
        <p>
          If you connect WordPress, you give Agentelse your site address, a
          WordPress username and an Application Password. Agentelse stores the
          password encrypted, uses it only to read your site and to make changes
          you approve, and deletes it when you disconnect. You can also revoke
          the Application Password in WordPress at any time.
        </p>
        <p>
          Agentelse changes your site only after a workspace owner or admin
          approves each change. New articles are saved as drafts; making an
          article public is a separate approval. For each change Agentelse keeps
          a copy of the page content it changed (title, description, text) so
          you can undo it, for up to 24 months, and deletes these copies when
          you disconnect WordPress. The text you approved is your own content
          and is not removed when you disconnect Search Console. Search Console
          is never used to change anything.
        </p>
        <p>
          Optional IndexNow: if you turn it on, Agentelse tells search engines
          that take part in IndexNow (for example Bing and Yandex, not Google)
          the web addresses of pages it changed, after you approved the change.
          It sends only those addresses and a public key.
        </p>
        <p>
          AI search visibility: Agentelse checks your public site (robots.txt,
          llms.txt, your home page and the pages it already audits) and, if
          Google Analytics is connected, counts visits that come from AI
          assistants. These checks are not shared with anyone; recommendations
          are written by an AI service without any Google Analytics or Search
          Console data.
        </p>
        <p>
          If you add more than one Google Analytics property to a project, or
          link one Google account to several of your projects, Agentelse reads
          each property with the same read-only permission and keeps each
          property&rsquo;s data separately; disconnecting Google Analytics
          deletes all of them right away. If you create a client report link,
          anyone who has the link can see that report until it expires (7, 30
          or 90 days) or you revoke it; the page shows only the report, never
          your Google account or any other data, and the link stops working as
          soon as you disconnect Google Analytics. If you choose to share your
          Google Analytics BigQuery export with Agentelse&rsquo;s read-only
          service account, Agentelse reads daily totals from it using that
          access only (no extra Google permission is requested from you;
          queries run and are billed in your own Google Cloud project), stores
          only those totals, and deletes them when you disconnect. Where
          Google&rsquo;s Cross-Account Protection notices are enabled for
          Agentelse, a connection is switched off as soon as Google tells us
          your account&rsquo;s access was revoked. Agentelse encrypts the stored
          Google tokens.
        </p>
        <p>
          If you turn on the Search Console bulk data export to BigQuery and
          give Agentelse&rsquo;s read-only service account access to it,
          Agentelse reads weekly and monthly summaries of that property from
          your own BigQuery dataset (the queries run and are billed in your own
          Google Cloud project, with a size limit you set, and only the property
          owner can connect it) and stores them like Search Console API data. If
          you create a client report link for a Search Console report, anyone
          who has the link can see that stored report until it expires or you
          revoke it, and the link is deleted right away when you disconnect
          Search Console. Disconnecting Search Console, or choosing Delete
          stored data, deletes the imported summaries and split-test results
          right away; the page-group rules, extra-site lists and BigQuery
          project and dataset names you entered are settings, and are deleted
          when you disconnect.
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
