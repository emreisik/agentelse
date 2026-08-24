import Link from "next/link";
import { redirect } from "next/navigation";
import { CheckIcon } from "lucide-react";

import { auth } from "@/lib/auth";
import { Button } from "@/components/ui/button";

const CAPABILITIES = [
  "Connects to your advertising and analytics accounts (Google, Meta, TikTok, LinkedIn, X) to research and plan campaigns",
  "Coordinates specialized AI agents across strategy, creative, and reporting",
  "Every AI action is gated by the permission level you set — view, recommend, or execute — with risky steps routed to human approval",
];

// Public home page: required by Google OAuth brand verification, which
// crawls the consent screen's homepage URL without a session. Signed-in
// visitors are sent straight to /dashboard; everyone else sees this.
export default async function Home() {
  const session = await auth();
  if (session?.user?.id) {
    redirect("/dashboard");
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex items-center justify-between px-6 py-5 sm:px-10">
        <img src="/logo.png" alt="Agentelse" className="h-7 w-auto" />
        <Button
          render={<Link href="/login" />}
          nativeButton={false}
          variant="outline"
          size="sm"
        >
          Sign in
        </Button>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center gap-10 px-6 py-16 text-center sm:px-10">
        <div className="flex max-w-2xl flex-col items-center gap-6">
          <h1 className="text-4xl font-semibold leading-tight tracking-tight text-balance sm:text-5xl">
            The AI team that grows your agency.
          </h1>
          <p className="max-w-xl text-pretty text-base text-muted-foreground sm:text-lg">
            Agentelse is an AI growth team for marketing and ad agencies.
            Campaigns, teams, and reporting come together under one roof, with
            specialized AI agents that research, plan, and — within the
            permission level you configure — execute work on your behalf.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Button render={<Link href="/register" />} nativeButton={false}>
              Get started
            </Button>
            <Button
              render={<Link href="/login" />}
              nativeButton={false}
              variant="outline"
            >
              Sign in
            </Button>
          </div>
        </div>

        <ul className="flex max-w-xl flex-col gap-3 text-left">
          {CAPABILITIES.map((item) => (
            <li
              key={item}
              className="flex items-start gap-2.5 text-sm text-muted-foreground"
            >
              <CheckIcon
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-foreground/50"
              />
              {item}
            </li>
          ))}
        </ul>
      </main>

      <footer className="flex flex-col items-center gap-3 border-t border-border px-6 py-8 text-xs text-muted-foreground sm:flex-row sm:justify-between sm:px-10">
        <span>© {new Date().getFullYear()} Agentelse</span>
        <div className="flex items-center gap-4">
          <Link href="/privacy" className="hover:text-foreground">
            Privacy Policy
          </Link>
          <Link href="/terms" className="hover:text-foreground">
            Terms of Service
          </Link>
        </div>
      </footer>
    </div>
  );
}
