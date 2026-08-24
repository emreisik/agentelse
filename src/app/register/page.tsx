import { CheckIcon } from "lucide-react";

import { RegisterForm } from "@/components/auth/register-form";
import { sanitizeCallbackUrl } from "@/lib/utils";

const HIGHLIGHTS = [
  "Real-time campaign visibility",
  "Approval and human-review workflows",
  "Automated reporting",
];

export default async function RegisterPage({
  searchParams,
}: PageProps<"/register">) {
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
            Campaigns, teams, and reporting come together under one roof in
            Agentelse.
          </p>
          <ul className="space-y-3 pt-2">
            {HIGHLIGHTS.map((item) => (
              <li
                key={item}
                className="flex items-center gap-2.5 text-sm text-primary-foreground/80"
              >
                <CheckIcon
                  aria-hidden="true"
                  className="size-4 shrink-0 text-primary-foreground/50"
                />
                {item}
              </li>
            ))}
          </ul>
        </div>

        <p className="text-xs text-primary-foreground/40">
          © {new Date().getFullYear()} Agentelse
        </p>
      </div>

      {/* Right panel — registration form */}
      <div className="flex flex-1 flex-col items-center justify-center gap-10 p-6 sm:p-10">
        <div className="flex flex-col items-center gap-1.5 lg:hidden">
          <img src="/logo.png" alt="Agentelse" className="h-8 w-auto" />
          <span className="text-xs text-muted-foreground">
            Your AI Growth Team
          </span>
        </div>
        <RegisterForm callbackUrl={callbackUrl} />
      </div>
    </div>
  );
}
