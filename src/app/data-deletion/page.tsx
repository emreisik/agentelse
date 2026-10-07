import type { Metadata } from "next";
import Link from "next/link";

import { getEnv } from "@/lib/env";
import { readDeletionCode } from "@/lib/meta-signed-request";

export const metadata: Metadata = {
  title: "Data deletion",
  description:
    "How to delete the Instagram data Agentelse holds, and the status of a deletion request.",
  robots: { index: false },
};

const SUPPORT_EMAIL = "hello@agentelse.ai";

function Mail() {
  return (
    <a
      href={`mailto:${SUPPORT_EMAIL}`}
      className="underline underline-offset-4"
    >
      {SUPPORT_EMAIL}
    </a>
  );
}

// Two jobs on one public page: the instructions Meta asks for ("how do I delete
// my data"), and the status of one request when opened with the confirmation code
// from the data deletion callback. The code is signed, so a made-up one just shows
// the instructions.
export default async function DataDeletionPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { code } = await searchParams;
  const request =
    typeof code === "string"
      ? readDeletionCode(code, getEnv().AUTH_SECRET)
      : null;

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
            Privacy
          </p>
          <h1 className="text-3xl font-semibold tracking-tight text-balance xl:text-4xl">
            Data deletion
          </h1>
        </div>

        {request ? (
          <section
            data-testid="deletion-status"
            className="mt-10 flex flex-col gap-3 rounded-lg border border-border p-5 text-sm leading-relaxed"
          >
            <h2 className="text-lg font-semibold text-foreground">
              Your request was processed
            </h2>
            <p className="text-muted-foreground">
              Received on {request.requestedAt.toISOString().slice(0, 10)}.{" "}
              {request.removed > 0
                ? `We erased the Instagram connection record we held for your account (${request.removed} ${request.removed === 1 ? "connection" : "connections"}): the access token, account id, username and account type.`
                : "We could not match this request to an Instagram connection stored in Agentelse, so nothing was erased. If you connected through a Facebook Page or Meta Ads, or you want more removed, email us and we will handle it by hand."}
            </p>
            <p className="text-muted-foreground">
              Confirmation code:{" "}
              <span className="font-mono text-foreground">{code}</span>
            </p>
            <p className="text-muted-foreground">
              Posts that were published to Instagram stay on Instagram. Plans,
              chats and other content created in Agentelse belong to the
              workspace that made them and stay there until it is deleted; email{" "}
              <Mail /> to have those deleted too.
            </p>
          </section>
        ) : null}

        <div className="mt-10 flex flex-col gap-3 text-sm leading-relaxed text-muted-foreground">
          <h2 className="text-lg font-semibold text-foreground">
            How to delete your Instagram data
          </h2>
          <p>
            When you connect Instagram, Agentelse keeps a connection record: an
            access token, your Instagram account id, username and account type.
            To erase that record, use either of these:
          </p>
          <ol className="flex list-decimal flex-col gap-2 pl-5">
            <li>
              In Instagram, open{" "}
              <span className="text-foreground">
                Settings &gt; Apps and websites
              </span>
              , find Agentelse and remove it, choosing to delete the data if
              Instagram offers that choice. Instagram then tells us, and we
              erase the connection record automatically.
            </li>
            <li>
              Email <Mail /> from the address you use with Agentelse, naming
              your Instagram username. We will erase the record and confirm.
            </li>
          </ol>
          <p>
            To only stop Agentelse from using the connection, open{" "}
            <span className="text-foreground">
              Connectors &gt; Instagram &gt; Disconnect
            </span>{" "}
            inside Agentelse. That takes effect right away but does not erase
            the record; use one of the options above for that. Content you
            created in Agentelse (plans, chats, creatives) belongs to your
            workspace and is deleted with it: email us to have a workspace
            deleted.
          </p>
          <p>
            See our{" "}
            <Link
              href="/privacy#instagram-data"
              className="underline underline-offset-4"
            >
              Privacy Policy
            </Link>{" "}
            for what we collect and why.
          </p>

          <h2 className="mt-6 text-lg font-semibold text-foreground">
            How to delete your Facebook Page and Meta Ads data
          </h2>
          <p>
            When you connect a Facebook Page or Meta Ads, Agentelse keeps a
            connection record for each: a Meta access token, your name on
            Facebook, the Pages and ad accounts you can choose from and the ones
            you chose, the ids of posts Agentelse shared on your Page, and for
            Meta Ads a copy of your campaigns, ad sets and ads with their daily
            performance figures. Page access tokens are never stored. To erase
            those records, email <Mail /> from the address you use with
            Agentelse, naming the Page or ad account. We will erase the records
            and confirm.
          </p>
          <p>
            To stop Agentelse from using them right away, open{" "}
            <span className="text-foreground">
              Connectors &gt; Facebook &gt; Disconnect
            </span>{" "}
            or{" "}
            <span className="text-foreground">
              Connectors &gt; Meta Ads &gt; Disconnect
            </span>
            , or remove Agentelse in Facebook under{" "}
            <span className="text-foreground">
              Settings &amp; privacy &gt; Settings &gt; Business integrations
            </span>
            . Neither erases the record by itself; email us for that. A post
            Agentelse shared on your Page can be deleted from its card in
            Agentelse or on Facebook; posts and ads already published stay on
            Facebook until you remove them there.
          </p>
          <p>
            See the{" "}
            <Link
              href="/privacy#facebook-and-meta-ads"
              className="underline underline-offset-4"
            >
              Facebook Page and Meta Ads section
            </Link>{" "}
            of our Privacy Policy for what we collect and why.
          </p>

          <h2 className="mt-6 text-lg font-semibold text-foreground">
            How to delete your Google Analytics and Search Console data
          </h2>
          <p>
            Open{" "}
            <span className="text-foreground">
              Connectors &gt; Google Analytics &gt; Disconnect
            </span>{" "}
            or{" "}
            <span className="text-foreground">
              Connectors &gt; Google Search Console &gt; Disconnect
            </span>
            . Disconnecting deletes that connection&rsquo;s stored token and the
            Google data in it right away: the connected email address and
            account id, the properties or sites you could choose from, the one
            you chose and your last test result. For Search Console it also
            deletes the search history Agentelse stored: daily totals,
            breakdowns, and weekly and monthly query and page summaries.
            Disconnecting Search Console also deletes the URL Inspection
            results, sitemap status and search alerts based on Search Console
            that Agentelse stored. Disconnecting Google Analytics also deletes
            the lessons learned from your tagged links and the Google Analytics
            figures added to ad suggestions. The records of the links Agentelse
            tagged are kept until the project is deleted, and you can turn link
            tracking off in Settings &gt; Publishing. Disconnecting Search
            Console also deletes the search opportunities, topic groups and
            brand-term suggestions built from it, and the article ideas made
            from them that you haven&rsquo;t used yet, as well as the measured
            results of SEO changes and the learnings drawn from them. It also
            removes
            Agentelse&rsquo;s access in your Google account, unless the same
            Google account is still used by your other Agentelse Google
            connection. You can remove that access yourself in your Google
            Account under{" "}
            <span className="text-foreground">
              Security &gt; Third-party apps and services
            </span>
            .
          </p>
          <p>
            You can also delete that stored Search Console history without
            disconnecting: open{" "}
            <span className="text-foreground">
              Connectors &gt; Google Search Console &gt; Delete stored data
            </span>
            . The last 16 months then load again from Google.
          </p>
          <p>
            To delete what our site audit stored about your website (page
            addresses, titles and technical checks), open{" "}
            <span className="text-foreground">
              Search &gt; Index &amp; technical health &gt; Delete audit data
            </span>
            . You can also turn the audit off there.
          </p>
          <p>
            Disconnecting Google Analytics also deletes, right away, the website
            reports Agentelse posted in your project&rsquo;s &ldquo;Website
            analytics&rdquo; chat and the goal progress it took from Google
            Analytics. Your own messages in that chat stay until you delete the
            chat.
          </p>
          <p>
            To also erase reports and suggestions Agentelse built from your
            Google data, email <Mail /> from the address you use with Agentelse,
            naming the property or site. We will erase them and confirm. See the{" "}
            <Link
              href="/privacy#google-analytics-and-search-console"
              className="underline underline-offset-4"
            >
              Google Analytics and Search Console section
            </Link>{" "}
            of our Privacy Policy for what we collect and why.
          </p>
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
