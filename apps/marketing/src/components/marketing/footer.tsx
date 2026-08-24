import Link from "next/link";

const FOOTER_COLUMNS: {
  title: string;
  links: { label: string; href: string }[];
}[] = [
  {
    title: "Product",
    links: [
      { label: "Pricing", href: "/pricing" },
      { label: "Security", href: "/security" },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "About", href: "/about" },
      { label: "Contact", href: "/contact" },
    ],
  },
  {
    title: "Legal",
    links: [
      { label: "Privacy", href: "/privacy" },
      { label: "Terms", href: "/terms" },
    ],
  },
];

export function MarketingFooter() {
  return (
    <footer className="border-t border-border">
      <div className="agentelse-container-wide grid gap-12 py-16 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
        <div className="flex flex-col gap-3">
          <Link href="/" className="flex items-center">
            <img src="/logo.png" alt="Agentelse" className="h-6 w-auto" />
          </Link>
          <p className="max-w-[26ch] text-sm text-muted-foreground">
            Your Autonomous Growth Department.
          </p>
        </div>
        {FOOTER_COLUMNS.map((column) => (
          <div key={column.title} className="flex flex-col gap-3">
            <p className="agentelse-text-caption font-medium text-foreground uppercase">
              {column.title}
            </p>
            <ul className="flex flex-col gap-2.5">
              {column.links.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="text-sm text-muted-foreground transition-colors hover:text-foreground"
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
        <div className="agentelse-container-wide flex flex-col-reverse items-start gap-2 py-6 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <span>© {new Date().getFullYear()} Agentelse</span>
          <span>Your Autonomous Growth Department.</span>
        </div>
      </div>
    </footer>
  );
}
