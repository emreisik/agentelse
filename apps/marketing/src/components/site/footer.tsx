import Link from "next/link";

import { CONTACT_EMAIL, FOOTER_COLUMNS } from "@/lib/site";

export function SiteFooter() {
  return (
    <footer className="border-t border-border bg-muted/60">
      <div className="site-container-wide grid gap-12 py-16 md:grid-cols-[1.5fr_1fr_1fr_1fr]">
        <div className="flex flex-col gap-4">
          <Link
            href="/"
            className="flex items-center"
            aria-label="Agentelse home"
          >
            <img src="/logo.png" alt="Agentelse" className="h-6 w-auto" />
          </Link>
          <p className="max-w-[30ch] text-sm text-muted-foreground">
            Your AI social media team. You approve, it does the rest.
          </p>
          <a
            href={`mailto:${CONTACT_EMAIL}`}
            className="text-sm text-foreground underline-offset-4 hover:underline"
          >
            {CONTACT_EMAIL}
          </a>
        </div>
        {FOOTER_COLUMNS.map((column) => (
          <div key={column.title} className="flex flex-col gap-3">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {column.title}
            </p>
            <ul className="flex flex-col gap-2.5">
              {column.links.map((link) => (
                <li key={link.label}>
                  <Link
                    href={link.href}
                    className="text-sm text-foreground/80 transition-colors hover:text-foreground"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-border">
        <div className="site-container-wide flex flex-col gap-2 py-6 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <span>
            © {new Date().getFullYear()} Agentelse. All rights reserved.
          </span>
          <span>Made for brands and the agencies behind them.</span>
        </div>
      </div>
    </footer>
  );
}
