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
    <a href={`mailto:${SUPPORT_EMAIL}`} className="underline underline-offset-4">
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
                ? `We erased the Instagram connection data we held for your account (${request.removed} ${request.removed === 1 ? "connection" : "connections"}): the access token, account id, username and account type.`
                : "We did not hold any Instagram connection data for your account, so there was nothing to erase."}
            </p>
            <p className="text-muted-foreground">
              Confirmation code: <span className="font-mono text-foreground">{code}</span>
            </p>
            <p className="text-muted-foreground">
              Posts that were published to Instagram stay on Instagram, and the
              content kept in the workspace that created them is that
              workspace&rsquo;s own. Questions? Write to <Mail />.
            </p>
          </section>
        ) : null}

        <div className="mt-10 flex flex-col gap-3 text-sm leading-relaxed text-muted-foreground">
          <h2 className="text-lg font-semibold text-foreground">
            How to delete your Instagram data
          </h2>
          <p>
            When you connect Instagram, Agentelse stores an access token, your
            Instagram account id, username and account type. To erase them, use
            any of these:
          </p>
          <ol className="flex list-decimal flex-col gap-2 pl-5">
            <li>
              In Instagram, open <span className="text-foreground">Settings &gt; Apps and websites</span>,
              find Agentelse and remove it, choosing to delete the data when
              Instagram offers it. Instagram then tells us, and we erase the
              connection data automatically.
            </li>
            <li>
              Email <Mail /> from the address you use with Agentelse, naming your
              Instagram username. We will erase the data and confirm.
            </li>
            <li>
              Inside Agentelse, open <span className="text-foreground">Integrations &gt; Instagram &gt; Disconnect</span> to
              stop Agentelse from using the connection right away.
            </li>
          </ol>
          <p>
            See our <Link href="/privacy#instagram-data" className="underline underline-offset-4">Privacy Policy</Link>{" "}
            for what we collect and why.
          </p>
        </div>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex w-full max-w-3xl flex-col-reverse items-start gap-2 px-6 py-6 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <span>© {new Date().getFullYear()} Agentelse</span>
          <div className="flex gap-4">
            <Link href="/privacy" className="transition-colors hover:text-foreground">
              Privacy
            </Link>
            <Link href="/terms" className="transition-colors hover:text-foreground">
              Terms
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
