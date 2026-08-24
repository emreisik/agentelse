import Link from "next/link";
import { CheckIcon } from "lucide-react";

import { LoginForm } from "@/components/auth/login-form";
import { sanitizeCallbackUrl } from "@/lib/utils";

const HIGHLIGHTS = [
  "Connects to your advertising and analytics accounts (Google, Meta, TikTok, LinkedIn, X) to research and plan campaigns",
  "Coordinates specialized AI agents across strategy, creative, and reporting",
  "Every AI action is gated by the permission level you set — view, recommend, or execute — with risky steps routed to human approval",
];

function BrandFooterLinks({ className }: { className?: string }) {
  return (
    <div className={className}>
      <Link href="/privacy" className="hover:underline">
        Privacy Policy
      </Link>
      <span aria-hidden="true"> · </span>
      <Link href="/terms" className="hover:underline">
        Terms of Service
      </Link>
    </div>
  );
}

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const params = await searchParams;
  const callbackUrl = sanitizeCallbackUrl(
    typeof params.callbackUrl === "string" ? params.callbackUrl : undefined,
  );

  return (
    <div className="flex min-h-screen w-full flex-col bg-background lg:flex-row">
      {/* Left panel — brand and value proposition (desktop only) */}
      <div className="hidden flex-col justify-between bg-primary p-10 text-primary-foreground lg:flex lg:w-1/2 xl:p-16">
        <div className="flex flex-col gap-1.5">
          <img src="/logo-black.png" alt="Agentelse" className="h-8 w-auto" />
          <div className="text-xs text-primary-foreground/60">
            Your AI Growth Team
          </div>
        </div>

        <div className="max-w-md space-y-6">
          <h1 className="text-3xl font-semibold leading-tight tracking-tight text-balance xl:text-4xl">
            The AI team that grows your agency.
          </h1>
          <p className="text-base text-pretty text-primary-foreground/70">
            Agentelse is an AI growth team for marketing and ad agencies.
            Campaigns, teams, and reporting come together under one roof in
            Agentelse.
          </p>
          <ul className="space-y-3 pt-2">
            {HIGHLIGHTS.map((item) => (
              <li
                key={item}
                className="flex items-start gap-2.5 text-sm text-primary-foreground/80"
              >
                <CheckIcon
                  aria-hidden="true"
                  className="mt-0.5 size-4 shrink-0 text-primary-foreground/50"
                />
                {item}
              </li>
            ))}
          </ul>
        </div>

        <div className="flex flex-col gap-2 text-xs text-primary-foreground/40">
          <span>© {new Date().getFullYear()} Agentelse</span>
          <BrandFooterLinks className="space-x-1" />
        </div>
      </div>

      {/* Right panel — login form */}
      <div className="flex flex-1 flex-col items-center justify-center gap-10 p-6 sm:p-10">
        <div className="flex max-w-sm flex-col items-center gap-4 text-center lg:hidden">
          <img src="/logo.png" alt="Agentelse" className="h-8 w-auto" />
          <span className="text-xs text-muted-foreground">
            Your AI Growth Team
          </span>
          <p className="text-sm text-pretty text-muted-foreground">
            Agentelse is an AI growth team for marketing and ad agencies. It
            connects to your advertising and analytics accounts, researches and
            plans campaigns, and — within the permission level you configure —
            executes work on your behalf, with risky steps routed to human
            approval.
          </p>
        </div>
        <LoginForm callbackUrl={callbackUrl} />
        <BrandFooterLinks className="space-x-1 text-xs text-muted-foreground lg:hidden" />
      </div>
    </div>
  );
}
